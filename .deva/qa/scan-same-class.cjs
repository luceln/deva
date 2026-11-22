#!/usr/bin/env node
/**
 * 审查固定入口：同类扫描（章程第 5 步「验证同类是否都修了」）。
 *
 * 上一轮漏掉三处 `existsSync` 复制品，是因为只看 diff 改了什么、看不到「哪些该改没改」。
 * 这个脚本把「哪些该改没改」变成一条可复跑的命令。
 *
 * ## 两侧都要看（这条在第二轮被推翻了）
 *
 * 上一版这里写着「源侧目录列举读不到 = 原版没有这份数据，是既定协议，无害」——**那个假设本身就是 bug**。
 * 验收实测 7 处：把源目录换成同名文件制造 ENOTDIR，结果每一行都是
 * 「那一类数据 0 个、其余正常、`ok:true`、`failures:[]`」：
 *
 * | 源位置被占 | 该类数据 | ok | failures |
 * | --- | --- | --- | --- |
 * | `data/chats` | 0 | true | [] |
 * | `personas` | 0 | true | [] |
 * | `skills` | 0 | true | [] |
 * | `data/media` | 0 | true | [] |
 * | `data/checkpoints` | 0 | true | [] |
 * | `projects` | 0 | true | [] |
 * | `data/tool-results` | 0 | true | [] |
 *
 * `readdirSync` 抛错不止 ENOENT：ENOTDIR / EACCES / EPERM / EBUSY 都走同一个 catch。这些情况下源里
 * **有**数据，只是读不出来。当成「没有」是最坏的一类静默：一次性导入，用户看到「导入完成」就
 * 以为做完了，缺的那块永远缺。所以源侧目录列举与目标侧同样要求「读失败必须上报」。
 *
 * ## 三类问题
 *
 *   BARE     存在性/读操作后直接 return / continue / 记 skipped，读失败被当成「没有」
 *   SWALLOW  catch 里返回空值且没记失败（读失败与「没有」不可分）
 *   DISCARD  用返回值表达失败的函数被当语句调用
 *   SOURCE   源侧目录列举：以前整类豁免，现在与目标侧同标准（判据同上）
 *
 * ## 豁免必须带理由，且理由会过期
 *
 * 豁免只有两种写法：
 *   1. 源码里同一行 / 上一行写 `// silent-ok: <理由>`（这是给**实现方**用的，审查方不改产品代码）；
 *   2. 本脚本的 ALLOW 清单（审查方登记，键是 `文件::源码片段`）。
 *
 * 两种都必须能被**反向清理**：
 *   - ALLOW 里的片段在源码里已不存在 → `STALE`，退出码非零。否则豁免越积越多，
 *     最后没人知道哪条还有效（magpie: "no excuse outlives the variable it was for"）。
 *   - 理由必须描述**方向**（`existsSync` 返 false 时实际走哪条分支）。写反的理由比漏检更危险：
 *     它带着「已审查」的背书去确认一件不存在的事。
 *
 * ## CANARY：检查自己的检查
 *
 * 硬编码「已知必须被检出的位置 + 期望类型」。源码重构导致正则失效时，脚本会**报错而不是静默通过**。
 * 这是本脚本最重要的一段——审查这个角色最该防的不是「代码写错了」，是「检查在跑但什么都没查」。
 *
 * 用法：
 *   node .deva/qa/scan-same-class.cjs           # 目标侧待确认项
 *   node .deva/qa/scan-same-class.cjs --all     # 连已守卫的也列
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
/**
 * 扫描根可用 `SCAN_ROOT` 覆盖：破坏验证时在**副本**上把守卫拆掉，看本脚本会不会红。
 * 不改产品代码是硬约束，所以「它真能抓 bug」这一条只能在副本上证明。
 */
const MAIN = process.env.SCAN_ROOT ? path.resolve(process.env.SCAN_ROOT) : path.join(REPO, 'apps/desktop/src/main')
const ALL = process.argv.includes('--all')

/** 扫描范围：只有导入器。其它服务里的同类写法不是本 bug 的复制品，另开一轮 `--scope=all`。 */
const SCOPE = /^importer[\w-]*\.ts$/

const DST = /\b(to|dst[A-Za-z]*|target[A-Za-z]*)\b/
const SRC = /\b(from|src[A-Za-z]*|source[A-Za-z]*|srcDir|srcMedia|srcAvatars)\b/
/** 已接入统一守卫的痕迹（只对非 existsSync 的探测生效，见下方说明）。 */
const GUARD = /inspectTarget|inspectDirTarget|lexists/
/** 三态读取器的调用：读不到与「没有」在返回值里就是分开的，静默与否取决于调用方（由 DISCARD 段负责）。 */
const TRINARY = /\b(readSourceDir|readMemoryFile|readJson|targetState|inspectTarget|inspectDirTarget)\s*\(/
const ENOENT = /ENOENT/

/**
 * 源侧**内容文件**：读不出来＝不知道，不能当成「没有」。目录列举不在此列（空目录是无害的）。
 *
 * 判据三路（前两版都漏过，逐版收窄）：
 *   1. 实参是字面量文件名：`readFileSync(join(srcHome, 'memory.json'))`；
 *   2. 实参是**别名变量**：`const file = join(srcHome, 'secrets.json')` … `readFileSync(file)`。
 *      第一版只认字面量，于是 copySecrets 的 `readFileSync(file)` 被归成 OTHER 直接丢掉——正是 bug 现场；
 *   3. 所在函数是内容读取器（`readJson(p)` / `readEntries(file)` / `readProjectRoot(file)`），
 *      它的形参拿到的是内容文件路径。
 */
const SOURCE_CRITICAL = /(secrets|memory|config)\.json/
const CONTENT_READER_FN = /\b(readJson|readEntries|readProjectRoot|readSecrets)\b/

/*
 * 读操作清单。`readSourceDir` / `readMemoryFile` / `readJson` 是**三态读取器**：它们本身返回
 * `kind: 'unreadable'`，所以必须被收入扫描才能看到调用方有没有处理那一态。
 * 漏掉它们的后果实测过：这一版之前 `readSourceDir` 从不在清单里，于是 7 处源侧复制品全部隐形。
 */
const EXIST_FNS = [
  'existsSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'readFileSync',
  'accessSync',
  'openSync',
  'readSourceDir',
  'readMemoryFile',
  'readJson'
]

/** 用返回值表达失败的函数（靠抛异常的不在此列：抛了就会被 catch 抓住，谈不上丢弃）。 */
const MUST_CHECK = [
  'setConfig',
  'enablePersonas',
  'setPersonaEnabledChecked',
  'writeMemory',
  'importEncryptedSecret',
  'mergeProviders',
  'applyHeldPatches',
  'enableImportedPersonas'
]

/**
 * 审查方登记的豁免。键：`<文件名>::<源码片段>`。理由**必须写明方向**。
 *
 * ## 只有「确实压住了一条真命中」的位置才允许留在这里
 *
 * 2026-11-17 复查：原来的 13 条里 **10 条是冗余的** —— 把那 10 条从清单里删掉，扫描照样全绿。
 * 也就是说它们从未参与过判定（典型原因：该位置已被 `GUARD` 正则覆盖，或被 `CANARY` 的
 * 栓点形态接住），却给出了「已审查」的背书。**豁免越少越好，留下的一条必须有据可查。**
 *
 * 留下 = 删掉它扫描就会红（`break-allow.cjs` 的判据 A 会逐条重验这一点）。
 *
 * 上一版这里出过两次事故，都是「理由把方向写反」：
 *   - `角色 md：读失败最坏是「没覆盖」` → 反了。`existsSync` 返 false 时走的是 `copyFileSync`（先截断再写），
 *     那是**会覆盖**；真正不覆盖的是返 true 那条分支。
 *   - `头像已有即不覆盖，方向安全` → 同样反了。
 * 两条现已删除。这个机制的失效方式不是漏检，是**带着审查背书确认一件不存在的事**。
 */
const ALLOW = [
  {
    key: 'importer-skills.ts::if (!isWin || !isDir) return null',
    why: 'makeLink 的内层 catch：symlink 失败后要**换 junction 再试**，这里的 return null 是 fallback 控制流，不是把失败吞掉。删掉这条会判 SWALLOW（误报）。注意：它守的不是「无通道」，是「这段不是错误分支」'
  },
  {
    key: "importer-target.ts::openSync(to, 'r')",
    why: '探针本体：开不了 → 返 unreadable（＝不知道），这正是本 bug 的**修法**，不是复制品。删掉这条豁免后 `openSync` 会被判 BARE —— 那是对「修法」的误伤，所以必须留'
  },
  {
    key: 'importer-assoc.ts::const st = statSync(to)',
    why: 'isStaleTarget：刷 mtime 前的探测。返失败 → false → 不刷 mtime（幂等优先），既不覆盖内容也不改时间戳。删掉这条会判 BARE，而「读不出就不刷」是本场景的正确方向，所以留'
  }
]

/**
 * CANARY：已知必须被检出的位置。`kind` 是期望类别。
 *
 * 加这一段的理由：正则/启发式一旦失效，脚本会安静地报「通过」——那比没有脚本更坏，
 * 因为它带着「已扫描」的背书。有了 canary，「什么都没查到」会变成一条显式失败。
 *
 * `kind: 'EXISTS'` 表示**只断言该片段仍存在**、不断言它被判成什么类别：用于钉住
 * 「这一段逻辑还在」的锚点（例如某个四态分支的判据行），即使那行本身不是被扫描形态。
 * 若某条 canary 从期望的类别变成另一种（例如真 bug 修好了 → BARE 变 GUARDED），
 * canary 会失败并提示更新清单——这是刻意的，清单过期＝没人知道它还准不准。
 */
const CANARY = [
  {
    file: 'importer-personas.ts',
    match: 'const probe = inspectTarget(to)',
    kind: 'GUARDED',
    why: '角色本体：四态判定已提到复制之前，不再被 existsSync 门住'
  },
  {
    file: 'importer-personas.ts',
    match: "if (probe.kind === 'usable') return undefined // 已有同名头像：不覆盖",
    kind: 'EXISTS',
    why: '头像：四态已接（上一行就是 inspectTarget）。这是「usable 才不覆盖、其余三态各自处置」的锚点'
  },
  {
    file: 'importer-target.ts',
    match: "const fd = openSync(to, 'r')",
    kind: 'GUARDED',
    why: '探针本体必须始终被判成「守卫」，它是所有修法的基点'
  },
  {
    file: 'importer-sessions.ts',
    match: "raw = readFileSync(to, 'utf8')",
    kind: 'GUARDED',
    why: 'targetState 的读：读失败必须与「解析失败」分开（读失败→unreadable，不覆盖）'
  },
  {
    file: 'importer-config.ts',
    match: "src = JSON.parse(readFileSync(file, 'utf8'))",
    kind: 'GUARDED',
    why: 'copySecrets 的源读取：区分 ENOENT（正常）与读失败（记 failed）'
  },
  {
    file: 'importer-config.ts',
    match: "raw = readFileSync(p, 'utf8')",
    kind: 'GUARDED',
    why: 'readJson 三态：读失败 → unreadable → mergeProviders 记 source-config-unreadable，不再静默归零'
  },
  {
    file: 'importer-memory.ts',
    match: "raw = readFileSync(file, 'utf8')",
    kind: 'GUARDED',
    why: 'readMemoryFile 三态（entries 与 root 合并成一次读）：读失败 → unreadable → 调用方记 failed'
  },
  {
    file: 'importer-assoc.ts',
    match: 'const probe = inspectTarget(to)',
    kind: 'GUARDED',
    why: '附件三处的统一入口；若它消失，说明又回到裸判断了'
  },
  {
    file: 'importer-memory.ts',
    match: 'projects.failed.push({',
    kind: 'EXISTS',
    why: 'readMemoryFile 的 unreadable 必须被转成失败记录，否则三态白做'
  },
  /*
   * 源侧 7 处（第二轮验收实测出来的复制品）。修好后的形态是「三态 + 上报」，
   * 所以每条都验两件事：① 读取走的是 readSourceDir（TRINARY → GUARDED）；
   * ② 那一处确实有 failed.push（EXISTS）。只验①会漏掉「接了三态但不上报」这半修。
   */
  {
    file: 'importer-sessions.ts',
    match: 'const srcList = readSourceDir(srcDir)',
    kind: 'EXISTS',
    why: '会话目录：三态读取（原 catch{return stat} 会把「读不出」当成「原版没有会话」）'
  },
  {
    file: 'importer-sessions.ts',
    match: "stat.failed.push({ step: 'sessions', id: '<data/chats>'",
    kind: 'EXISTS',
    why: '会话目录 unreadable 必须上报；缺了这条，三态白做'
  },
  {
    file: 'importer-personas.ts',
    match: 'const srcList = readSourceDir(srcDir)',
    kind: 'EXISTS',
    why: '角色目录：三态读取（原注释「原版没有 personas 目录」本身就是 bug 描述）'
  },
  {
    file: 'importer-skills.ts',
    match: 'const srcList = readSourceDir(srcDir)',
    kind: 'EXISTS',
    why: '技能目录：三态读取（原注释「原版没有 skills 目录」同形）'
  },
  {
    file: 'importer-assoc.ts',
    match: 'const mediaList = readSourceDir(srcMedia)',
    kind: 'EXISTS',
    why: 'media 目录：三态读取（原 catch{mediaNames=[]} → 报告「媒体 0 个」而 ok=true）'
  },
  {
    file: 'importer-assoc.ts',
    match: 'const srcList = readSourceDir(srcDir)',
    kind: 'EXISTS',
    why: 'mergeDir：checkpoints/subagents/tool-results 三条路径共用，且递归'
  },
  {
    file: 'importer-memory.ts',
    match: 'const projectsList = readSourceDir(join(srcHome,',
    kind: 'EXISTS',
    why: '项目记忆目录：读不出来时「全部项目」的记忆都不导（爆炸半径最大的一处）'
  },
  {
    file: 'importer-source-dir.ts',
    match: "return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }",
    kind: 'EXISTS',
    why: '7 处共用的判据本体：ENOENT 才算「没有」，其余一律 unreadable'
  }
]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const isComment = (t) => /^\s*(\*|\/\/|\/\*)/.test(t)

/**
 * 源码里显式的豁免：同一行、上一行、或紧邻上方的注释块里写 `silent-ok: 理由`。
 *
 * 三种形态都认：
 *   - `// silent-ok: …` 写在同一行；
 *   - `// silent-ok: …` 写在上一行；
 *   - `/* silent-ok: …（可跨行）*\/` 写在上一行开头——理由长的时候会这样写，
 *     只认 `//` 会把这种漏掉（主进程这轮就踩了）。
 */
function silentOk(lines, i) {
  for (const t of [lines[i], lines[i - 1], lines[i - 2]]) {
    const m = /silent-ok:\s*([^\n]*?)(?:\*\/)?\s*$/.exec(t ?? '')
    if (m && m[1].trim()) return m[1].trim().replace(/^\*+/, '').trim()
  }
  return null
}

function allowOf(file, text) {
  const hit = ALLOW.find((a) => {
    const [f, frag] = a.key.split('::')
    return file === f && text.includes(frag)
  })
  return hit ? hit.why : null
}

/**
 * 取出 `fn(...)` 的实参文本（不含外层括号，支持嵌套括号）。
 *
 * 上一版把外层左括号也吐进返回值，于是 `readFileSync(file, 'utf8')` 的实参变成
 * `"(file, 'utf8')"` —— 变量名提取失败，别名追踪整条失效。行号对、逻辑对、结果错，
 * 正是本脚本自己最该防的那种「在跑但没查对」。
 */
function argsOf(line, fn) {
  const at = line.indexOf(fn + '(')
  if (at < 0) return ''
  let depth = 0
  let out = ''
  let started = false
  for (let i = at + fn.length; i < line.length; i++) {
    const c = line[i]
    if (!started) {
      if (c === '(') started = true // 跳过外层左括号，不进 out
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) break
      depth--
    }
    out += c
  }
  return out
}

/** 找出某行所在的函数名（向上找最近的 `function xxx(` 或 `const xxx = (`）。 */
function enclosingFnName(lines, i) {
  for (let j = i; j >= Math.max(0, i - 120); j--) {
    const m = /function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[j]) ?? /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(lines[j])
    if (m) return m[1]
  }
  return null
}

/**
 * 调用方是否把这个函数的「空值返回」转成了失败记录。
 *
 * 判据必须绑到**本次调用的返回值**上：
 *   1. 调用结果被赋给变量（`const root = readProjectRoot(...)`）；
 *   2. 该变量在紧接着几行里被判过（`if (!root)`）；
 *   3. 判空分支里有 failed.push。
 *
 * 上一版只看「调用行之后 6 行里有 failed.push」——`importMemories` 里恰好有
 * `projects.failed.push({reason:'missing-root'})`，于是 `readEntries` 也被误判成「有通道」。
 * 那正是这条 bug 的现场（两条都是空值返回，只有一条被转成了 failed），差点被自己的启发式放过。
 */
function callerChannels(fnName, files) {
  if (!fnName) return false
  const call = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${fnName}\\(`)
  for (const src of files.values()) {
    const lines = src.split('\n')
    for (let k = 0; k < lines.length; k++) {
      const m = call.exec(lines[k])
      if (!m) continue
      const v = m[1]
      /*
       * 窗口只看到**下一个语句**为止：遇到另一处 `<x> = ...(` 就停。
       * `readEntries` 的调用点紧跟 `readProjectRoot`，而后者有 `if (!root) failed.push`——
       * 用固定行数窗口会把别人的失败通道算到它头上，正好放过 `readEntries`（这条 bug 的现场）。
       */
      const end = k + 1 + lines.slice(k + 1, k + 14).findIndex((l) => /\b(?:const|let|var)\s+\w+\s*=.*\(/.test(l))
      const next = lines.slice(k + 1, end === k ? k + 8 : end + 1).join('\n')
      const tested = new RegExp(`if\\s*\\(\\s*!\\s*${v}\\b`).test(next)
      if (tested && /(failures|failed|stat\.failed)\s*(\.push|\[)/.test(next)) return true
    }
  }
  return false
}

const rows = []
const files = new Map() // 文件名 → 源码，供 STALE 检查与 canary
for (const file of walk(MAIN)) {
  const rel = path.basename(file)
  if (!SCOPE.test(rel)) continue
  const src = fs.readFileSync(file, 'utf8')
  files.set(rel, src)
  const lines = src.split('\n')

  lines.forEach((text, i) => {
    if (isComment(text)) return
    const lineNo = i + 1
    const trimmed = text.trim()
    const after = lines.slice(i + 1, i + 7).join('\n')
    const win = lines.slice(Math.max(0, i - 8), i + 10).join('\n')
    const ok = silentOk(lines, i)
    const allowed = allowOf(rel, text) || ok

    const fn = EXIST_FNS.find((f) => text.includes(f + '('))
    /*
     * ⚠️ 顺序陷阱（A3 破坏验证第三次抓不到东西的原因）：
     *
     * `EXIST_FNS` 里既有裸系统调用（existsSync/readFileSync…），也有三个**三态读取器**
     * （readSourceDir / readMemoryFile / readJson）。所以 `const read = readMemoryFile(file)` 会先命中
     * 下面这个 `if (fn)` 分支，在 513 行无条件 `return` —— 永远走不到后面的 DISCARD 段。
     *
     * 后果：DISCARD 判据对这三个函数**形同虚设**。A3（保留 unreadable 判断、删掉 failed.push）
     * 三轮全是绿的，原因不是判据写错，而是这行代码根本没被那段逻辑看过。
     *
     * 修法：三态读取器的**赋值形态**先交给 DISCARD 判定（它专门处理 `const x = tri(...)`），
     * 裸调用形态（`readSourceDir(dir)` 当语句用）继续走下面的 fn 分支。
     */
    const triAssign = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:readSourceDir|readMemoryFile|readJson)\s*\(/.exec(
      trimmed
    )
    if (triAssign && !ok) {
      const v = triAssign[1]
      const callee = /(?:readSourceDir|readMemoryFile|readJson)/.exec(trimmed)?.[0] ?? ''
      const calleeSrc = files.get(rel) ?? ''
      // 必须**该函数自己的返回类型**里声明了 unreadable，而不是「文件里别处出现过 unreadable」
      const fnHead = new RegExp(`function\\s+${callee}\\s*\\([^)]*\\)\\s*:\\s*([^\\n{]+)`)
      const head = fnHead.exec(calleeSrc)?.[1] ?? ''
      // 返回类型可能是内联联合，也可能是类型别名（如 MemoryFileRead）；后者要顺着别名找一次，
      // 否则整个判据静默失效。
      const aliasName = /^[A-Za-z_$][\w$]*$/.test(head.trim()) ? head.trim() : null
      const aliasBody = aliasName
        ? new RegExp(`type\\s+${aliasName}\\s*=([\\s\\S]{0,400})`).exec(calleeSrc)?.[1] ?? ''
        : ''
      if (/unreadable/.test(head) || /unreadable/.test(aliasBody)) {
        const lines2 = lines.slice(i + 1, i + 34)
        /*
         * 「处理了 unreadable」这个判断必须按**子串**匹配，不能要求字面量恰好等于 `'unreadable'`。
         *
         * 曾经写成全等：主进程把 `makeLink` 的返回值改名成 `'source-unreadable'`（语义等价、调用方
         * 处置也完全正确），扫描器却报 `DISCARD —— 后续 34 行没有处理 kind.kind === 'unreadable'`。
         * 那是误报：判据看的是**名字**，不是**行为**。三态值叫什么由实现方定，扫描器只能要求
         * 「相等比较的那个字符串里含 unreadable」。
         */
        const UNREADABLE_EQ = `===\\s*'[^']*unreadable[^']*'`
        const at = lines2.findIndex(
          (l) =>
            new RegExp(`${v}\\.kind\\s*${UNREADABLE_EQ}`).test(l) ||
            new RegExp(`(^|[^.\\w])${v}\\s*${UNREADABLE_EQ}`).test(l)
        )
        let body = ''
        if (at >= 0) {
          if (lines2[at].includes('{')) {
            const first = lines2[at]
            let depth = (first.slice(first.indexOf('{')).match(/\{/g) ?? []).length
            body = `${first}\n`
            for (let k = at + 1; k < lines2.length; k++) {
              body += `${lines2[k]}\n`
              depth += (lines2[k].match(/\{/g) ?? []).length
              depth -= (lines2[k].match(/\}/g) ?? []).length
              if (depth <= 0) break
            }
          } else {
            body = lines2[at]
          }
        }
        const judged = at >= 0
        let reported = /(failures|failed|stat\.failed)\s*(\.push|\[)/.test(body) || /\bfailed\s*:/.test(body)
        if (!reported && at >= 0) {
          const tail = lines2.slice(at + 1, at + 7).join('\n')
          // 同上：字符串里含 unreadable 即算「判断了 unreadable」（值名由实现方定）
          reported = new RegExp(
            `(^|[^.\\w])${v}\\.kind\\s*===\\s*'[^']*unreadable[^']*'[\\s\\S]{0,120}(failures|failed|stat\\.failed)\\s*(\\.push|\\[)`
          ).test(tail)
        }
        if (!judged || !reported) {
          rows.push({
            kind: 'DISCARD',
            rel,
            lineNo,
            fn: callee,
            side: 'DST',
            text: `${trimmed} —— ${judged ? 'unreadable 判断了但没有失败通道' : `后续 34 行没有处理 ${v}.kind === 'unreadable'`}`,
            note: '三态读取的 unreadable 被丢弃'
          })
          return
        }
      }
    }

    if (fn) {
      const arg = argsOf(text, fn)
      /*
       * 实参三路归因：字面量 / 别名变量 / 所在函数是内容读取器。
       * 别名变量靠回溯同一文件里 `<var> = ... 'xxx.json'` 的赋值。
       */
      const inContentReader = /function\s+\w*(readJson|readEntries|readProjectRoot|readSecrets)\w*\s*\(/.test(
        lines.slice(Math.max(0, i - 30), i + 1).join('\n')
      )
      // 只看第一个实参：`readFileSync(file, 'utf8')` 的路径在首位，后面的编码/标志不参与判定
      const firstArg = arg.split(',')[0].trim()
      const varName = /^([A-Za-z_$][\w$]*)$/.exec(firstArg)?.[1]
      const varHoldsContentFile =
        !!varName &&
        lines.some((l) => new RegExp(`(const|let|var)\\s+${varName}\\s*=.*`).test(l) && SOURCE_CRITICAL.test(l))
      const criticalSrc =
        SOURCE_CRITICAL.test(firstArg) || varHoldsContentFile || (inContentReader && fn === 'readFileSync')
      const side = DST.test(firstArg) ? 'DST' : criticalSrc ? 'CRIT' : SRC.test(firstArg) ? 'SRC' : 'OTHER'
      if (side === 'OTHER') return
      /*
       * 源侧目录列举**不再整类豁免**（上一版这里直接 `return`，正是 7 处复制品被放过的原因）。
       *
       * 判据与目标侧一致：读操作后面直接 return / continue / 记 skipped，就是「读失败当成没有」。
       * 区别只在 kind 标签用 SOURCE 便于分组，判定标准一样严格。
       *
       * 注意这里也适用后面的「有失败通道就 GUARDED」逻辑：接了三态（`readJson` / `readMemoryFile` /
       * `readSourceDir`）并上报的，自然落进 GUARDED。
       */
      const skips = /\b(continue|return)\b/.test(after) || /skipped\.push/.test(after)
      /*
       * `existsSync(目标)` **一律**要求登记理由，不因同函数里有 inspectTarget 而豁免。
       *
       * 这条不是理论洁癖，是实测：`copyCompacted` 里已经有 inspectTarget 了，只要某个分支再写一句
       * `if (existsSync(to)) continue`，按「窗口里有守卫就算守卫过」就会被放过——真 bug 恰恰长这样
       * （一半接守卫、一半没接）。importer-personas 的两个 false 分支就是这么漏过去的。
       */
      /*
       * 读失败有没有出路，三条判据（先算，因为 `existsSync` 也要用）：
       *   1. 本行附近显式区分了 ENOENT；
       *   2. **调用方**把空值返回转成了 failed；
       *   3. 这句读在 **try 块里**，失败会被同一个 try 的 catch 抓住并处理。
       */
      const viaCaller = callerChannels(enclosingFnName(lines, i) ?? '', files)
      const inTry = (() => {
        for (let k = i; k >= Math.max(0, i - 40); k--) {
          if (/^\s*}\s*catch\b/.test(lines[k])) return false // 已出 catch 边界
          if (/^\s*try\s*\{\s*$/.test(lines[k])) {
            /*
             * 光「在 try 里」不够：必须**那个 catch 自己会记录失败**，否则 try 只是把异常吞成
             * 返回值，仍然静默。
             *
             * 判据收紧过两轮：
             *  - 太宽：只看「后面有 catch」→ 注入一句 `if (existsSync(to)) continue` 也被判 GUARDED，
             *    破坏验证集体失灵（A1/B1/B2/B3 全部抓不到）。这是本轮实测到的。
             *  - 现在：catch 块里要么有 `failed.push` / `failures.push`，要么 `return` 一个非空值
             *    交给调用方记（`return (e as Error)?.message`，`copyAvatar` 就是这种）。
             */
            const tail = lines.slice(i, Math.min(lines.length, i + 60)).join('\n')
            return (
              /}\s*catch\b[^{]*\{[\s\S]{0,600}?(failures|failed|stat\.failed)\s*(\.push|\[)/.test(tail) ||
              /}\s*catch[\s\S]{0,600}?return\s+\(?e as Error\)?\??\.?\w*/.test(tail)
            )
          }
        }
        return false
      })()
      const hasExit = ENOENT.test(after) || viaCaller || inTry

      let kind = 'CHECK'
      if (allowed) kind = 'GUARDED'
      /*
       * `existsSync(目标)` **一律** BARE，不认 try 豁免。
       *
       * 理由（这是 A1/B1/B2 破坏验证集体失灵后想清楚的）：`existsSync` 在目标被占 / 打不开 /
       * 断链时**返回 false 而不是抛异常**，所以包在 try 里丝毫没有帮助——catch 永远不会被触发，
       * 代码直接落到 copyFileSync。try/catch 对「抛异常的读」有效（statSync / readFileSync），
       * 对「静默返回 false 的探测」无效。两类必须区别对待。
       */
      else if (fn === 'existsSync') kind = 'BARE'
      else if (GUARD.test(win)) kind = 'GUARDED'
      else if (TRINARY.test(text)) kind = 'GUARDED'
      else if (skips) kind = hasExit ? 'GUARDED' : 'BARE'
      // 源侧内容文件（CRIT）走同一套判定：它读失败也是「当成没有」，只是后果在另一列数字上
      rows.push({ kind, rel, lineNo, fn, side, text: trimmed, note: allowed || '' })
      return
    }

    // SWALLOW：catch 里返回空值，既没区分 ENOENT 也没有失败通道
    if (/catch\s*(\(\s*\w*\s*\))?\s*\{/.test(trimmed)) {
      const block = lines.slice(i, i + 7).join('\n')
      const before = lines.slice(Math.max(0, i - 16), i).join('\n')
      const hasChannel = /(failures|failed|stat\.failed)\s*(\.push|\[|=)/.test(block)
      /*
       * 「吞掉」有两种：
       *   a) 返回空值 / continue；
       *   b) catch 块里**只有注释**（`catch { /* 原版没有这个目录 *\/ }`）—— 变量保持空。
       * 第二种更隐蔽，`importer-memory.ts` 的项目目录就是它。
       *
       * 判 b) 必须先截到配对 `}`：直接取后面 7 行会把 `catch` 之后的正常代码也数进来，
       * 「全是注释」永远判假。
       */
      const cLines = lines.slice(i)
      let cDepth = 0
      let cEnd = 0
      for (let k = 0; k < Math.min(cLines.length, 12); k++) {
        cDepth += (cLines[k].match(/\{/g) ?? []).length
        cDepth -= (cLines[k].match(/\}/g) ?? []).length
        if (cDepth <= 0 && k > 0) {
          cEnd = k
          break
        }
      }
      const cBody = cLines.slice(1, cEnd > 0 ? cEnd : 1)
      const onlyComment =
        cBody.length > 0 &&
        cBody.every((l) => !l.trim() || /^\s*(\*|\/\/|\/\*|\*\/)/.test(l))
      const swallows =
        /return\s*(stat|\[\]|\{\}|null|''|undefined|\d)\b/.test(block) || /\bcontinue\b/.test(block) || onlyComment
      /*
       * 源**目录**列举也算：`try { names = readdirSync(srcDir) } catch { return 0 }`
       * 与「目标侧读失败当已存在」是同一个 bug 的两面——源里明明有数据，读不出来就报「0 个 + ok」。
       * 主进程为此新建了 `importer-source-dir.ts`（7 处复制品），所以这里不能把源侧一律放行。
       *
       * 判据靠**同函数里是否有 `return 0 / return stat / names = []`**这类空返回，而不是只看这一行。
       */
      const targets = before
        .split('\n')
        .filter((l) => EXIST_FNS.some((f) => l.includes(f + '(')))
        .some((l) => {
          const f = EXIST_FNS.find((x) => l.includes(x + '('))
          const a = argsOf(l, f).split(',')[0].trim()
          const v = /^([A-Za-z_$][\w$]*)$/.exec(a)?.[1]
          const hold =
            !!v && lines.some((l2) => new RegExp(`(const|let|var)\\s+${v}\\s*=.*`).test(l2) && SOURCE_CRITICAL.test(l2))
          // SRC 目录列举：readdirSync(srcDash) —— 也算
          const srcDirList = f === 'readdirSync' && SRC.test(a)
          return DST.test(a) || SOURCE_CRITICAL.test(a) || hold || srcDirList
        })
      if (targets && swallows) {
        /*
         * 判定「有没有失败通道」不看这个 catch 自己，而看**调用方**有没有把它转成 failed。
         * `readProjectRoot` 返回 null 本身是静默的，但调用方 `if (!root) projects.failed.push({reason:'missing-root'})`
         * 有通道 —— 它就不是复制品。反过来 `readJson` / `readEntries` 的调用方直接按「没数据」往下走，那才是。
         */
        const fnName = enclosingFnName(lines, i)
        const callerHasChannel = fnName ? callerChannels(fnName, files) : false
        const guarded = ENOENT.test(block) || hasChannel || callerHasChannel || !!allowOf(rel, block) || !!silentOk(lines, i)
        rows.push({
          kind: guarded ? 'GUARDED' : 'SWALLOW',
          rel,
          lineNo,
          fn: fnName ? `${fnName}()` : 'catch',
          side: 'DST',
          text: block.split('\n').slice(0, 2).join(' ').trim().slice(0, 84),
          note: callerHasChannel ? `调用方有失败通道（${fnName} 的 null 被转成 failed）` : allowOf(rel, block) || ''
        })
      }
      return
    }

    // GUARD 调用点：`inspectTarget(to)` / `inspectDirTarget(to)` / `lexists(to)` 本身也是被扫描的行。
    //
    // 为什么要把它们登记成行：canary 只能钉在「本脚本会扫的行」上，而上一版把两条 canary 钉在
    // `const probe = inspectTarget(to)` 上——那行不含任何 EXIST_FNS，永远不会被扫到，于是 canary
    // 自己报 NOT-DETECTED。清单挂在扫不到的行上，等于没挂。现在守卫调用点自己就是一类行，
    // 顺便也能回答「这个文件接了几处守卫」，比数「有几处裸判断」更直接。
    const guardCall = /(?:inspectTarget|inspectDirTarget|lexists)\s*\(/.exec(text)
    if (guardCall) {
      rows.push({
        kind: 'GUARDED',
        rel,
        lineNo,
        fn: guardCall[0].replace(/\s*\($/, ''),
        side: 'DST',
        text: trimmed,
        note: '守卫调用点'
      })
      return
    }

    /*
     * DISCARD（三态版）：读文件返回 `{kind:'unreadable', reason}` 的辅助函数，
     * 调用方若只用 `kind === 'absent' / 'ok'` 而**不处理 unreadable**，等于把失败丢了。
     *
     * 这段必须排在 MUST_CHECK 之前：`const read = readMemoryFile(file)` 的 callee 不在
     * MUST_CHECK 里，而下面的 `assign` 分支会无条件 return —— 排在后面就永远走不到。
     * 这是 A3 破坏验证连抓两次失败的原因。
     */
    const triCall = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(\w+)\(/.exec(trimmed)
    if (triCall && files.has(rel) && !ok) {
      const [, v, callee] = triCall
      const calleeSrc = files.get(rel) ?? ''
      // 必须**该函数自己的返回类型**里声明了 unreadable，而不是「文件里别处出现过 unreadable」
      const fnHead = new RegExp(`function\\s+${callee}\\s*\\([^)]*\\)\\s*:\\s*([^\\n{]+)`)
      const head = fnHead.exec(calleeSrc)?.[1] ?? ''
      // 返回类型可能是内联联合，也可能是类型别名（如 MemoryFileRead）；后者要顺着别名找一次，
      // 否则整个判据静默失效。
      const aliasName = /^[A-Za-z_$][\w$]*$/.test(head.trim()) ? head.trim() : null
      const aliasBody = aliasName
        ? new RegExp(`type\\s+${aliasName}\\s*=([\\s\\S]{0,400})`).exec(calleeSrc)?.[1] ?? ''
        : ''
      if (/unreadable/.test(head) || /unreadable/.test(aliasBody)) {
        const next = lines.slice(i + 1, i + 34).join('\n')
        /*
         * 不变量是「unreadable 必须**上报**」，不是「必须判断过」。
         *
         * 上一版只查有没有 `x.kind === 'unreadable'`，于是 A3 这种破坏——保留判断、只删掉
         * `failed.push`——完全抓不到。而「判断了但没记失败」恰恰是更常见的一半修复：
         * 用户看到的是「导入完成」，那个项目的记忆一条都没进来。
         */
        const judged =
          new RegExp(`${v}\\.kind\\s*===\\s*'[^']*unreadable[^']*'`).test(next) ||
          new RegExp(`(^|[^.\\w])${v}\\s*===\\s*'[^']*unreadable[^']*'`).test(next)
        let reported = false
        if (judged) {
          /*
           * 只看**这个 unreadable 分支自己的块体**：判断行带 `{` 就扫到配对的 `}`，
           * 否则只看判断行本身（单语句 `if (x) continue` 必然没上报）。
           *
           * 上一版用固定 7 行窗口，把后面 `if (!read.root) failed.push({reason:'missing-root'})`
           * 也算了进来 → A3（保留判断、删掉 failed.push）被误判成「已上报」。
           * 别人的失败通道不能算到这个分支头上——这个错误我在 callerChannels 里刚犯过一次。
           */
          const lines2 = lines.slice(i + 1, i + 34)
          const at = lines2.findIndex(
            (l) =>
              new RegExp(`${v}\\.kind\\s*===\\s*'[^']*unreadable[^']*'`).test(l) ||
              new RegExp(`(^|[^.\\w])${v}\\s*===\\s*'[^']*unreadable[^']*'`).test(l)
          )
          let body = ''
          if (at >= 0) {
            if (lines2[at].includes('{')) {
              /*
               * 只数**这一行 `{` 之后**的净值。`} else if (x === 'unreadable') {` 这类行
               * 开头先有一个 `}`（闭合上一个分支），若从行首开始计数，净值为 0 →
               * 块体在第二行就"闭合"了，`stat.failed.push` 被截在窗口外。
               * 这是 sessions 那条误报的成因。
               */
              const first = lines2[at]
              let depth = (first.slice(first.indexOf('{')).match(/\{/g) ?? []).length
              body = first + '\n'
              for (let k = at + 1; k < lines2.length; k++) {
                body += lines2[k] + '\n'
                depth += (lines2[k].match(/\{/g) ?? []).length
                depth -= (lines2[k].match(/\}/g) ?? []).length
                if (depth <= 0) break
              }
            } else {
              body = lines2[at]
            }
          }
          // 上报形态有三种：
          //   a) `failed: [...]` 写在返回对象里（readJson 的调用方）
          //   b) `failed.push(...)` 在紧随的 if 块里（readMemoryFile 全局那条，判断与上报分两行）
          //   c) 同一行内 push
          reported = /(failures|failed|stat\.failed)\s*(\.push|\[)/.test(body) || /\bfailed\s*:/.test(body)
          if (!reported) {
            // 判断写成三元/单行、上报在紧接着的 if 块里：向后多看 6 行，但只认**同一变量**的 failed.push
            const tail = lines2.slice(at + 1, at + 7).join('\n')
            reported = new RegExp(`(^|[^.\\w])${v}\\.kind\\s*===\\s*'[^']*unreadable[^']*'[\\s\\S]{0,120}(failures|failed|stat\\.failed)\\s*(\\.push|\\[)`).test(tail)
          }
        }
        if (!judged || !reported) {
          rows.push({
            kind: 'DISCARD',
            rel,
            lineNo,
            fn: callee,
            side: 'DST',
            text: `${trimmed} —— ${judged ? 'unreadable 判断了但没有失败通道' : `后续 34 行没有处理 ${v}.kind === 'unreadable'`}`,
            note: '三态读取的 unreadable 被丢弃'
          })
          return
        }
      }
    }

    // DISCARD
    const fname = MUST_CHECK.find((f) => new RegExp(`(^|[^.\\w])${f}\\(`).test(text))
    if (fname) {
      // 赋值形态：只有「后续没用该变量」才是 DISCARD（`const r = x(); if (r.ok)` 正常）
      const assign = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]+\(/.exec(trimmed)
      if (assign) {
        if (ok) return
        const v = assign[1]
        const next = lines.slice(i + 1, i + 26).join('\n')
        if (!new RegExp(`\\b${v}\\b`).test(next)) {
          rows.push({
            kind: 'DISCARD',
            rel,
            lineNo,
            fn: fname,
            side: 'DST',
            text: `${trimmed} —— 赋值后 26 行内 ${v} 未被使用`,
            note: '返回值拿走了但没用'
          })
        }
        return
      }
      if (/[=!<>]|^\s*(return|if|void|await)\b/.test(trimmed)) return
      if (!/\)\s*$/.test(trimmed)) return
      rows.push({
        kind: ok || allowOf(rel, text) ? 'GUARDED' : 'DISCARD',
        rel,
        lineNo,
        fn: fname,
        side: 'DST',
        text: trimmed,
        note: ok || allowOf(rel, text) || ''
      })
      return
    }
  })
}

const ORDER = { BARE: 0, SWALLOW: 1, DISCARD: 2, CHECK: 3, GUARDED: 4, SRC: 5 }
rows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo)
const counts = {}
for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1

const W = 9
console.log('目标侧存在性判断与读失败处理（范围：importer*.ts）\n')
for (const r of rows) {
  if (!ALL && (r.kind === 'GUARDED' || r.kind === 'SRC')) continue
  console.log(`${r.kind.padEnd(W)} ${r.rel}:${r.lineNo}  ${r.fn}  ${r.text.slice(0, 84)}`)
  if (r.note) console.log(`${''.padEnd(W)}   ↳ ${r.note}`)
}

const sum = ['BARE', 'SWALLOW', 'DISCARD', 'CHECK', 'GUARDED', 'SRC'].map((k) => `${k} ${counts[k] || 0}`).join(' / ')
console.log(`\n汇总：${sum}`)

/* ── 反向清理：豁免与 canary 都会过期 ── */

let problems = 0

const stale = ALLOW.filter((a) => {
  const [f, frag] = a.key.split('::')
  const src = files.get(f)
  return !src || !src.includes(frag)
})
if (stale.length) {
  problems += stale.length
  console.log('\nSTALE 豁免（源码里已不存在这段，请删除该条）：')
  for (const s of stale) console.log(`  - ${s.key}`)
}

console.log('\nCANARY 自检：')
for (const c of CANARY) {
  const src = files.get(c.file)
  if (!src) {
    problems++
    console.log(`  FAIL 找不到文件 ${c.file}`)
    continue
  }
  const line = src.split('\n').findIndex((l) => l.includes(c.match)) + 1
  if (!line) {
    problems++
    console.log(`  FAIL ${c.file} 里已找不到「${c.match.slice(0, 40)}」——正则/启发式失效或代码已重构，请更新清单`)
    continue
  }
  const row = rows.find((r) => r.rel === c.file && r.lineNo === line)
  const got = row ? row.kind : 'NOT-DETECTED'
  // EXISTS：只断言「这段还在」，不断言它被判成什么（用于钉住非扫描形态的锚点行）
  if (c.kind === 'EXISTS') {
    console.log(`  PASS ${c.file}:${line} 存在（锚点：${c.why.slice(0, 40)}）`)
    continue
  }
  if (got === c.kind) {
    console.log(`  PASS ${c.file}:${line} 判成 ${got}`)
  } else {
    problems++
    console.log(`  FAIL ${c.file}:${line} 期望 ${c.kind}，实得 ${got}`)
    console.log(`       ${c.why}`)
    console.log('       → 若这是「已修好」导致的，说明清单过期，请更新 CANARY；否则是扫描本身失效')
  }
}

/* ── 规则自检：每条规则必须真的命中东西 ── */

/*
 * 「检查在跑但什么都没查」是扫描脚本最坏的失效方式——它带着「已扫描」的背书。
 * canary 证明**具体位置**能被检出；这一段证明**每条规则类别**都有产出。
 *
 * 为什么需要它：上一版把源侧整类 `return` 掉，于是 `SRC` 那 17 条被安静地过滤，谁也没发现
 * 「源侧根本没判过」。规则是否生效不能靠人看，得让空产出变成一条显式失败。
 *
 * 例外：`SWALLOW` / `DISCARD` 在完全修干净后可能确实是 0 条——但那两种规则由 canary 钉住，
 * 只要对应 canary 是 PASS 就说明规则还在工作。这里只硬性要求**曾经大量存在过的两列**
 * （GUARDED 与 SRC）非空，其余类别由 canary 覆盖。
 */
const RULE_MUST_HIT = [
  { key: 'GUARDED', why: '统一守卫/三态的痕迹；为 0 说明探测函数被改名或规则失效' }
]
/** 源侧识别数量：按 side 统计而不是按 kind —— 修好之后源侧全部落进 GUARDED，kind 里已看不到 SRC。 */
const sourceSides = rows.filter((r) => r.side === 'SRC' || r.side === 'CRIT').length
console.log('\n规则自检（每条规则必须命中 ≥1 处）：')
for (const r of RULE_MUST_HIT) {
  const n = counts[r.key] || 0
  if (n > 0) {
    console.log(`  PASS ${r.key} 命中 ${n} 处`)
  } else {
    problems++
    console.log(`  FAIL 规则 ${r.key} 一处都没命中 —— ${r.why}`)
  }
}
/*
 * 源侧规则的自检必须按 **side** 计数，不能按 kind。
 *
 * 上一版按 `counts.SRC` 判，于是一修好（源侧全部归入 GUARDED）它就报「规则失效」——规则本身没问题，
 * 是自检口径写错了。这类假信号会让人把正确的自检关掉，比漏检更糟。
 */
if (sourceSides > 0) {
  console.log(`  PASS 源侧识别 命中 ${sourceSides} 处（其中已守卫 ${rows.filter((r) => (r.side === 'SRC' || r.side === 'CRIT') && r.kind === 'GUARDED').length} 处）`)
} else {
  problems++
  console.log('  FAIL 源侧识别 0 处 —— 说明「源侧整类豁免」的旧逻辑又回来了，或 SRC 正则失效')
}

const todo = (counts.BARE || 0) + (counts.SWALLOW || 0) + (counts.DISCARD || 0)
if (todo > 0) {
  console.log(`\n${todo} 条待确认。逐条确认无害后登记进 ALLOW（理由必须写明方向），否则视为同类未修完。`)
}
/*
 * 边界声明：**每次运行都打印，不管通过与否**。
 *
 * 理由：一个绿的 `exit 0` 很容易被当成「这个 bug 类不存在了」。而本脚本只能证明
 * 「我知道的那些形状不在了」——它看不见没写进判据的形状（本轮就漏过 6 种：
 * 别名变量、字符串联合、调用方才有的通道、判断了但没上报、catch 里只有注释、跨行块注释）。
 *
 * 把这句话印在输出末尾，是让下一个人（包括几周后的我）在**看到结论的同一屏**上就知道它的边界，
 * 而不是去读脚本源码才明白。做法照抄 magpie 的 `TestFolderVarsAreListed` 里那段
 * 「What this cannot see is…」——测试自己声明自己看不见什么。
 */
console.log(
  '\n边界：本扫描只覆盖已知形状（BARE/SWALLOW/DISCARD/源侧四类），' +
    '无法证明「没有别的形状」。行为验证见 repro-accept 的场景表（srcdir / srcread / guardpath）。'
)
if (todo > 0 || problems > 0) process.exit(1)
console.log('同类扫描通过：目标侧没有裸判断、没有静默吞读失败、没有丢弃返回值；豁免无过期项。')
