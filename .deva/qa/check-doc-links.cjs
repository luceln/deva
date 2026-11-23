/**
 * 文档链接校验：`.md` 里引用的仓库内路径必须真的存在。
 *
 * 背景：Claude Code 的 `/doctor` 专查这个，理由是**陈旧指令比没有指令更糟**——
 * 它指着不存在的地方让人去找，读者照着走必然扑空，而且看不出来是文档错了还是自己找错了。
 * 本仓的决策记录在 `notes/`。它曾放在被 `.gitignore` 忽略的草稿区里，别人 clone 拿不到，
 * 所以搬了出来；搬动那一次，`LESSONS.md` ×4、`MEMBERS.md` ×1 等一批引用没跟着改，全悬空了。
 * 这类漂移不会让编译/类型/测试有任何反应，只能靠判据守。
 *
 * ── 判什么 ─────────────────────────────────────────────
 * 只认**带路径分隔符**的引用，且必须以下列前缀之一开头：
 *   `.deva/` `docs/` `apps/` `scripts/` `.github/` `packages/`（相对仓库根）
 * 或者相对于当前 md 文件能解析开（`../notes/x.md`、`./y.md`、同目录 `x.md`）。
 *
 * ── 为什么不认裸文件名 ─────────────────────────────────
 * 满仓都是 `` `config.json` ``、`` `messages.ts` ``、`` `support.md` `` 这类写法，
 * 它们多数指**运行期产物或概念**（`config.json` 是 `<DEVA_HOME>/config.json`，
 * `messages.ts` 是 i18n 词条模块），而不是「仓库里这个路径」。
 * 一律要求它们存在会把判据变成误报机，然后所有人把它关掉——
 * 与 jscpd 那条「threshold 0 会让所有人关掉这个 linter」是同一个坑。
 *
 * ── 例外 ─────────────────────────────────────────────
 * 1. **文件本身**在 `notes/archived/` 下：冻结快照，里面提旧名字是
 *    **应该的**，不检查。（注意豁免的是「文件所在位置」，不是「引用指向那个目录」——
 *    根目录的文档引用 archived 里不存在的文件，照样报。）
 * 2. 代码块里出现的路径：` ``` ` 围起来的示例是伪代码，不当作引用。
 * 3. 带通配符的（`docs/*.md`）、占位符（`<name>`、`{a,b}`、`...`）：跳过。
 * 4. 不带扩展名的（`../services/secrets`、`../../store/chat`）：那是**模块路径**，存在性由 tsc 保证。
 * 5. 运行期产物（`dist/`、`out/`、`data/`、`.artifacts/`）与不入库文件（`deploy.json`）：仓库里本来没有。
 * 6. 行内明确标注状态的：`（已删除）`/`（不存在）`/`（待建）`/`不纳入版本管理`，或上一行写
 *    `<!-- doclink:ignore-next-line -->`；`（原 `旧路径`）` 这种「标注迁移前旧名」的也算。
 * 7. 别的仓库的路径：文件头写 `<!-- doclink:foreign -->` 声明「本文件的 docs/... 指外部仓库」，
 *    或单个引用写成 `magpie:docs/x.md`。**故意不硬编码文件名**——那样每加一个仓库就要加一行豁免。
 *
 * ── 已知取舍 ──────────────────────────────────────────
 * 声明 `doclink:foreign` 的文件里，`docs/`、`scripts/`、`packages/` 前缀一并放行：
 * 这些前缀在两个仓库里都存在，无法只靠前缀区分。宁可漏判这几个，也不让判据变成假红机。
 *
 * 用法：
 *   node .deva/qa/check-doc-links.cjs          # 默认：有悬空即 exit 1
 *   node .deva/qa/check-doc-links.cjs --list   # 只列出所有识别到的引用，不判失败（排查用）
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

/** 这些前缀的引用一定是相对仓库根 */
const ROOT_PREFIXES = ['.deva/', 'docs/', 'notes/', 'apps/', 'scripts/', '.github/', 'packages/']

/** 不当作「仓库路径引用」的扩展名/形状 */
const WILDCARD = /[*?{}<>]|\.\.\./

/** 刻意保留的陈旧引用出口 */
const IGNORE_MARK = '<!-- doclink:ignore-next-line -->'
/**
 * 整文件声明「本文件的路径引用指别的仓库」。
 * 放在文件头，之后所有 `docs/...`、`.trellis/...` 都不按本仓判定。
 */
const FOREIGN_FILE_MARK = '<!-- doclink:foreign -->'
/** 该行已明确说明这个路径的状态（不存在 / 不入库 / 运行期生成），不是遗漏 */
const SOFT_SUFFIX = /（(已删除|不存在|待建|已废弃|不纳入版本管理)）|不纳入版本管理|运行期生成|构建产物|不存在\*\*|\*\*不存在/
/** 「原 `旧路径`」= 标注迁移前的旧名，随后同一行给出新位置；这是**历史说明**不是引用 */
const FORMER_NAME = /（原\s*`[^`]+`/

/** 这些目录/文件名是**运行期产物**，仓库里本来就没有，不能当悬空 */
const RUNTIME_ONLY = [
  /(^|\/)dist\/?$/, /(^|\/)out\/?$/, /(^|\/)node_modules\/?$/, /(^|\/)data\/?$/,
  /(^|\/)\.artifacts\//, /(^|\/)release\/?$/, /(^|\/)coverage\/?$/,
  /(^|\/)deploy\.json$/,
]

/**
 * **别的仓库**的路径。
 *
 * 这里**不硬编码文件名**——那样每提一个新仓库就要加一行，过几个月没人知道这些豁免为什么在。
 * 改成认文档里的显式声明：文中出现 `` `magpie:<路径>` `` 就表示那是 magpie 仓库的路径。
 * 这样「这条引用指的不是本仓」这件事写在**文档里**，判据只是照读。
 *
 * 历史遗留的裸 `docs/code-standards.md`（magpie 的 7 节规则）在
 * `notes/proposed/2026-11-18-rules-by-phase.md` 与 `…-mechanism-against-silent-failure.md`
 * 里各有一批；那是迁移前写的，本轮不擅改正文语义，靠 `doclink:foreign` 行标记放行。
 */
const FOREIGN_PREFIX = /^([a-z][a-z0-9-]{1,15}):\/+/i

/**
 * 声明了 `doclink:foreign` 的文件里，**仍然按本仓判定**的前缀。
 * 只列不可能属于别的仓库的那些：`.deva/` 是本仓的草稿区，`apps/` 是本仓的 workspace，
 * `.github/` 是本仓的 CI。而 `docs/`、`scripts/`、`packages/` 在 magpie 那边同样存在，
 * 无法只靠前缀区分，索性一并放行——宁可漏判这几个前缀，也不要变成假红。
 */
const FOREIGN_SAFE_PREFIXES = ['.deva/', 'apps/', '.github/']

/**
 * 不带扩展名的路径大概率是**模块路径**（`../services/secrets`、`../../store/chat`），
 * 指的是 TS 模块而非磁盘上的同名字面路径，存在性由 tsc 保证，不该由本判据判定。
 * 目录引用（`apps/relay-node/data/` 以 / 结尾）仍要判——除非它是运行期产物。
 */
function looksLikeModuleRef(clean) {
  if (clean.endsWith('/')) return false
  if (/\.(md|tsx?|cjs|mjs|js|json|yml|yaml|css|html|txt|patch|svg|png)$/i.test(clean)) return false
  return true
}

function walkMd(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = ent.name
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out') continue
    const full = path.join(dir, name)
    if (ent.isDirectory()) {
      walkMd(full, out)
    } else if (ent.isFile() && name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/**
 * **已入库**的文件集合。
 *
 * 为什么不用 `fs.existsSync` 判存在性：本地 `.deva/design/` 是被 `.gitignore` 忽略的草稿区，
 * 目录里有一堆 html 原型。用磁盘存在性判，本机永远 PASS；CI 检出后那些文件根本不存在，
 * 同一个引用在 CI 上就是悬空。**本地全绿、推上去红**——这类判据等于没有。
 * （本轮实测就是这样：`check-doc-links` 本地 118 处 PASS，CI 在「文档链接」步红。）
 *
 * 改成只认 `git ls-files` 里有的东西，本地与 CI 判据就一致了：
 * 引用一个不入库的文件，本机当场就红，不必等 CI。
 *
 * 不在 git 仓库里时（源码包、临时拷贝）退回磁盘存在性——否则整份判据会变成全红。
 */
function trackedPaths() {
  const { spawnSync } = require('node:child_process')
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return null
  const files = new Set()
  const dirs = new Set()
  for (const rel of res.stdout.split('\0')) {
    if (!rel) continue
    files.add(rel)
    // 同时记下所有祖先目录，让「引用一个目录」也能判
    let d = rel
    while (d.includes('/')) {
      d = d.slice(0, d.lastIndexOf('/'))
      dirs.add(d)
    }
  }
  return { files, dirs }
}

/** 目标是否真实存在且已入库（tracked 为 null 时退回磁盘检查） */
function targetExists(target, tracked) {
  if (!tracked) return fs.existsSync(target)
  const rel = path.relative(ROOT, target).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return false
  return tracked.files.has(rel) || tracked.dirs.has(rel)
}

/** 去掉围栏代码块（``` 或 ~~~），保持行号不变 */
function stripFences(text) {
  const lines = text.split(/\r?\n/)
  let inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return ''
    }
    return inFence ? '' : line
  })
}

/**
 * 从一行里抠出候选路径。
 * 认两种写法：`` `path` `` 反引号内，以及 markdown 链接 `](/path)`。
 */
function candidates(line) {
  const out = []
  const backtick = /`([^`\n]+)`/g
  let m
  while ((m = backtick.exec(line))) out.push(m[1].trim())
  // 反引号内的内容算「代码引用」；反引号之外的才当 markdown 链接解析。
  // 否则 `[示例](../x.md)` 这种**写在反引号里的示例**会被当成真链接，然后按当前目录解析错位。
  const outside = line.replace(/`[^`\n]*`/g, ' ')
  const link = /\]\(([^)\s]+)\)/g
  while ((m = link.exec(outside))) out.push(m[1].trim())
  return out
}

/** 这个候选是不是「仓库内路径引用」；是则返回该路径，否则 null */
function asRepoRef(raw, mdDir) {
  if (!raw) return null
  if (WILDCARD.test(raw)) return null
  // 去掉锚点与 query
  const clean = raw.split('#')[0].split('?')[0].trim()
  if (!clean) return null
  // 外链、邮件、绝对 URL 一律跳过
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null
  // 运行期产物：仓库里本来就没有
  if (RUNTIME_ONLY.some((re) => re.test(clean))) return null
  // 模块路径（无扩展名）交给 tsc，不在这里判
  if (looksLikeModuleRef(clean)) return null
  // 必须有目录成分：要么以已知前缀开头，要么含 '/' 且不是 URL
  const isRooted = ROOT_PREFIXES.some((p) => clean.startsWith(p))
  if (isRooted) return { target: path.resolve(ROOT, clean), display: clean }
  // 相对当前 md 的写法：./x、../x、或同目录下的带扩展名文件
  if (/^\.{1,2}\//.test(clean)) {
    return { target: path.resolve(mdDir, clean), display: clean }
  }
  return null
}

function main() {
  const listOnly = process.argv.includes('--list')
  const tracked = trackedPaths()
  // 只扫**已入库**的 md：`fs.existsSync` 会连 `.deva/design/` 这类被忽略的草稿一起扫进来，
  // 而那些文件在 CI 上根本不存在。本地扫、CI 不扫 → 两边结论不同，判据就失去意义。
  const files = walkMd(ROOT, []).filter((f) => {
    if (!tracked) return true
    return tracked.files.has(path.relative(ROOT, f).replace(/\\/g, '/'))
  })
  const dangling = []
  let checked = 0

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    // 冻结快照里提旧名字是**应该的**：`notes/archived/` 是只读历史，
    // 要求它指向现存文件等于要求改写历史（见 notes/AGENTS.md「archived 是冻结快照」）。
    if (rel.startsWith('notes/archived/')) continue
    const mdDir = path.dirname(file)
    const text = fs.readFileSync(file, 'utf8')
    // 整文件声明「这里引的是别的仓库」
    const isForeign = text.includes(FOREIGN_FILE_MARK)
    const lines = stripFences(text)
    const rawLines = text.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      for (const cand of candidates(line)) {
        // 带 `repo:` 前缀的是别的仓库路径，不按本仓判
        if (FOREIGN_PREFIX.test(cand)) continue
        const ref = asRepoRef(cand, mdDir)
        if (!ref) continue
        // 整文件声明为外部仓库时：`docs/`、`packages/`、`scripts/` 这些**通用前缀**可能是别的仓库，
// 只判真正属于本仓、且不可能属于 magpie 的前缀（`.deva/`、`apps/`、`.github/`）。
        if (isForeign && !FOREIGN_SAFE_PREFIXES.some((p) => ref.display.startsWith(p))) continue
        checked++
        if (targetExists(ref.target, tracked)) continue
        // 有意保留的陈旧引用
        if (SOFT_SUFFIX.test(line.trim()) || rawLines[i].includes('doclink:ignore')) continue
        if (FORMER_NAME.test(line) && line.indexOf(ref.display) > line.indexOf('（原')) continue
        if (i > 0 && rawLines[i - 1].includes(IGNORE_MARK)) continue
        dangling.push({ file: rel, line: i + 1, ref: ref.display, text: line.trim() })
      }
    }
  }

  if (listOnly) {
    console.log(`识别到 ${checked} 处仓库内路径引用（${files.length} 个 md）`)
    return
  }

  console.log(`扫描 ${files.length} 个 md，识别 ${checked} 处仓库内路径引用`)

  if (dangling.length === 0) {
    console.log('结论：PASS —— 没有悬空引用')
    process.exit(0)
  }

  console.log(`\n结论：FAIL —— ${dangling.length} 处悬空引用\n`)
  for (const d of dangling) {
    console.log(`  ${d.file}:${d.line}`)
    console.log(`    引用：${d.ref}`)
    console.log(`    原文：${d.text}`)
    console.log('')
  }
  console.log('修法：把路径改成文件实际所在处；若是有意保留的历史记录，在该行写「（已删除）」或上一行加 <!-- doclink:ignore-next-line -->')
  process.exit(1)
}

main()