#!/usr/bin/env node
/**
 * `project-doc.ts` 沿目录链发现多份 AGENTS.md —— CI 可跑的断言（驱动真实逻辑）。
 *
 * ## 为什么这个功能必须有判据
 *
 * 原实现的注释写着「子目录里的 AGENTS.md 不预读，由提示词告知模型『处理该目录文件时一并遵循』」。
 * 那是**宣称，不是机制**：模型能不能读到子目录那份，取决于它是否主动 `read_file`，实际基本读不到。
 * 刚建的 6 个嵌套 AGENTS.md 因此在根目录干活时全部失效 —— 编译通过、类型正确、人眼看不出。
 *
 * 只有判据能守住的四件事：
 *   · 单份场景注入字符串**逐字节不变**（否则提示缓存前缀被打断，每轮全量重算）
 *   · 多份时顺序必须是「宽 → 窄」（反了就等于「远的优先」，与语义相反）
 *   · 某一份不可读时其余照常注入（不能一份坏掉整段消失）
 *   · 超总预算时的丢弃策略（整份丢宽的，不做半截截断）
 *
 * ## 判据对象
 *
 * 真实的 `project-doc.ts`，用 esbuild 打成 cjs；以及 `git show <基线>:<path>` 取出的
 * **改动前版本**，用来做逐字节对拍。不 stub 被测逻辑本身。
 *
 * ## 隔离（红线）
 *
 * 所有夹具在 `os.tmpdir()/deva-pdoc-*` 下，绝不在仓库里造文件。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist', 'pdoc')
const SRC_FILE = 'apps/desktop/src/main/services/project-doc.ts'

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass += 1
  console.log(`  PASS ${n}${d ? ' :: ' + d : ''}`)
}
const bad = (n, d) => {
  fail += 1
  console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`)
}
const eq = (n, got, want) => (got === want ? ok(n, String(got)) : bad(n, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`))
const assert = (n, cond, d) => (cond ? ok(n, d) : bad(n, d))

/** 把某个 ts 文件打成 cjs，返回 require 到的模块。 */
async function bundleOne(entryTs, outName) {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, `${outName}.entry.ts`)
  fs.writeFileSync(entry, `export * from ${JSON.stringify(entryTs)}\n`)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, `${outName}.cjs`),
    logLevel: 'error'
  })
  return require(path.join(DIST, `${outName}.cjs`))
}

/**
 * 取「改动前」的版本：从一个**固定基线 ref** 的 blob 里落一份临时 ts 再打包。
 *
 * 为什么不能用 `HEAD`：本次改动一旦提交、或进了 CI 检出，`HEAD` 就是**被测版本**本身，
 * 「单份逐字节不变」这条判据会退化成「新版 vs 新版」自比，恒真。
 * 实测过：`HEAD:project-doc.ts` 与分支上的 `project-doc.ts` 逐字节相同，
 * 于是那条守「提示缓存前缀不被破坏」的断言，实际上什么都没守。
 *
 * 基线钉成引入链式注入之前的最后一个提交（`be5925c^`）。拿不到就判 FAIL，
 * **不要静默换成 HEAD** —— 那正是本条原先的失效方式。
 */
const BASELINE_REF = process.env.QA_PDOC_BASELINE || 'be5925c^'

function bundleBaselineVersions() {
  let raw
  try {
    raw = execFileSync('git', ['show', `${BASELINE_REF}:${SRC_FILE}`], { cwd: REPO, encoding: 'utf8' })
  } catch (e) {
    throw new Error(
      `取不到基线版本 ${BASELINE_REF}:${SRC_FILE}（${e.message.split('\n')[0]}）。\n` +
        '  基线必须显式存在：拿不到就判失败，不能退回 HEAD —— HEAD 是被测版本本身，' +
        '用它做基线会让「单份逐字节不变」变成新版自比、恒真假绿。\n' +
        '  若基线提交被改写，用 QA_PDOC_BASELINE=<ref> 指定新的基线。'
    )
  }
  /*
   * 基线版本内部只 `import { join } from 'path'`，没有相对导入，所以可以原样放到临时目录打包。
   */
  const tmp = path.join(DIST, 'baseline', 'project-doc.ts')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, raw)
  return tmp
}

function mkFixture(root, specs) {
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, content] of specs) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (content === null) {
      // 造成「同名目录」：用于验证「非文件 → 静默跳过」
      fs.mkdirSync(abs, { recursive: true })
    } else {
      fs.writeFileSync(abs, content)
    }
  }
  return root
}

async function main() {
  console.log('== project-doc 沿目录链发现 AGENTS.md ==')
  const M = await bundleOne(path.join(SRC, 'main/services/project-doc.ts'), 'current')
  const baseTs = bundleBaselineVersions()
  const B = await bundleOne(baseTs, 'baseline')

  const root = path.join(os.tmpdir(), `deva-pdoc-${Date.now()}`)

  /* ───────── C1：单份场景逐字节对拍 ───────── */
  console.log('\n-- C1 单份场景与改动前逐字节一致 --')
  {
    const home = mkFixture(path.join(root, 'solo'), [
      ['AGENTS.md', '# 约定\n\n提交信息用中英双语。\n\n- 缩进两个空格\n- 不写分号\n']
    ])
    const nowArr = M.projectDocPromptSection(M.loadProjectDocChain(home))
    const oldArr = B.projectDocPromptSection(B.loadProjectDoc(home))
    const nowTxt = nowArr.join('\n')
    const oldTxt = oldArr.join('\n')
    if (nowTxt === oldTxt) ok('C1a 单份注入字符串逐字节相同', `${Buffer.byteLength(nowTxt)} 字节`)
    else {
      bad('C1a 单份注入字符串逐字节相同', `长度 ${oldTxt.length} → ${nowTxt.length}`)
      console.log('    --- 改前 ---\n' + JSON.stringify(oldTxt).slice(0, 400))
      console.log('    --- 改后 ---\n' + JSON.stringify(nowTxt).slice(0, 400))
    }
    eq('C1b 行数相同', nowArr.length, oldArr.length)
    eq('C1c 首行相同', nowArr[0], oldArr[0])
  }

  /* ───────── C1d：截断场景也要逐字节一致 ───────── */
  console.log('\n-- C1d 单份 + 超单份上限（截断）也逐字节一致 --')
  {
    const big = '# 长文\n' + 'a'.repeat(M.PROJECT_DOC_MAX_BYTES + 5000)
    const home = mkFixture(path.join(root, 'solo-big'), [['AGENTS.md', big]])
    const nowTxt = M.projectDocPromptSection(M.loadProjectDocChain(home)).join('\n')
    const oldTxt = B.projectDocPromptSection(B.loadProjectDoc(home)).join('\n')
    if (nowTxt === oldTxt) ok('C1d 截断场景逐字节相同', `${Buffer.byteLength(nowTxt)} 字节`)
    else bad('C1d 截断场景逐字节相同', `长度 ${oldTxt.length} → ${nowTxt.length}`)
  }

  /* ───────── C2：顺序必须由宽到窄 ───────── */
  console.log('\n-- C2 多份顺序 = 根 → 子目录（由宽到窄）--')
  {
    const home = mkFixture(path.join(root, 'multi'), [
      ['AGENTS.md', 'ROOT-DOC'],
      ['services/AGENTS.md', 'SERVICES-DOC'],
      ['services/deep/AGENTS.md', 'DEEP-DOC']
    ])
    const docs = M.loadProjectDocChain(home)
    eq('C2a 找到 3 份', docs.length, 3)
    const dirs = docs.map((d) => d.dir)
    eq('C2b 顺序为 [根, services, services/deep]', JSON.stringify(dirs), JSON.stringify(['', 'services', 'services/deep']))
    const txt = M.projectDocPromptSection(docs).join('\n')
    const iRoot = txt.indexOf('ROOT-DOC')
    const iSvc = txt.indexOf('SERVICES-DOC')
    const iDeep = txt.indexOf('DEEP-DOC')
    assert('C2c 三份内容都出现', iRoot >= 0 && iSvc >= 0 && iDeep >= 0, `${iRoot} / ${iSvc} / ${iDeep}`)
    assert('C2d 根在最前、深者在最后', iRoot < iSvc && iSvc < iDeep, `${iRoot} < ${iSvc} < ${iDeep}`)
    assert('C2e 每份都标出路径', txt.includes('（仓库根）') && txt.includes('（services）') && txt.includes('（services/deep）'), '标注齐全')
  }

  /* ───────── C2f：实际本仓库（main/services 场景）───────── */
  console.log('\n-- C2f 真实仓库：根 + apps/desktop/src/main/services --')
  {
    const docs = M.loadProjectDocChain(REPO)
    const dirs = docs.map((d) => d.dir)
    assert('C2f1 至少找到 2 份', docs.length >= 2, `${docs.length} 份：${dirs.join(' | ')}`)
    assert(
      'C2f2 含仓库根那份',
      dirs.includes(''),
      dirs.includes('') ? '有' : `实际：${JSON.stringify(dirs)}`
    )
    assert(
      'C2f3 含 apps/desktop/src/main/services',
      dirs.includes('apps/desktop/src/main/services'),
      dirs.includes('apps/desktop/src/main/services') ? '有' : `实际：${JSON.stringify(dirs)}`
    )
    const iRoot = dirs.indexOf('')
    const iSvc = dirs.indexOf('apps/desktop/src/main/services')
    assert('C2f4 根在 services 之前', iRoot < iSvc, `${iRoot} < ${iSvc}`)
    /*
     * C2f6：真实仓库里深度序列必须**单调不减**。
     *
     * 这是守「由宽到窄」的真断言。原来只有 C2f4（根在 services 之前），而 DFS 顺序下
     * 根天然排最前，所以那条抓不住问题 —— 实测 DFS 产出的深度序列是 `0, 6, 5, 6, 6, 5, 1`，
     * 深 6 的 `redesign/AGENTS.md` 排在深 1 的 `notes/AGENTS.md` 之前，
     * 但 C2f4 照样 PASS。
     */
    const depths = dirs.map((d) => (d === '' ? 0 : d.split('/').length))
    const monotonic = depths.every((v, i) => i === 0 || depths[i - 1] <= v)
    assert(
      'C2f6 真实仓库深度序列单调不减（由宽到窄，不是 DFS 序）',
      monotonic,
      `深度=${JSON.stringify(depths)} 目录=${JSON.stringify(dirs)}`
    )
    assert('C2f5 没扫进 node_modules', !dirs.some((d) => d.includes('node_modules')), dirs.filter((d) => d.includes('node_modules')).join(',') || '干净')
  }

  /* ───────── C3：某份不可读时其余照常 ───────── */
  console.log('\n-- C3 某份不可读 → 其余照常注入 --')
  {
    const home = mkFixture(path.join(root, 'bad'), [
      ['AGENTS.md', 'GOOD-ROOT'],
      // 造一个同名目录：readFile 会 EISDIR，readOne 应静默跳过
      ['broken/AGENTS.md', null],
      ['broken/child/AGENTS.md', 'GOOD-CHILD']
    ])
    const docs = M.loadProjectDocChain(home)
    const dirs = docs.map((d) => d.dir)
    assert('C3a 坏的那份被跳过', !dirs.includes('broken'), JSON.stringify(dirs))
    assert('C3b 其余两份仍在', dirs.includes('') && dirs.includes('broken/child'), JSON.stringify(dirs))
    const txt = M.projectDocPromptSection(docs).join('\n')
    assert('C3c 好内容都出现了', txt.includes('GOOD-ROOT') && txt.includes('GOOD-CHILD'), '两份都在')
  }

  /* ───────── C4：总预算按 dsh 语义整份丢弃 ───────── */
  console.log('\n-- C4 超总预算：从最宽的整份丢弃，不做半截截断 --')
  {
    const chunk = 30 * 1024 // 每份 30 KiB，三份 90 KiB > 64 KiB 预算
    const mk = (tag) => `# ${tag}\n` + String(tag).repeat(chunk / String(tag).length + 1)
    const home = mkFixture(path.join(root, 'budget'), [
      ['AGENTS.md', mk('ROOTBUDGET')],
      ['mid/AGENTS.md', mk('MIDBUDGET')],
      ['mid/deep/AGENTS.md', mk('DEEPBUDGET')]
    ])
    const docs = M.loadProjectDocChain(home)
    eq('C4a 三份都读到了', docs.length, 3)
    const { kept, dropped } = M.budgetProjectDocChain(docs)
    assert('C4b 超预算后有丢弃', dropped.length > 0, `丢弃 ${dropped.length} 份`)
    assert(
      'C4c 丢弃的是更宽的那些（第一个保留的不是根）',
      kept.length > 0 && kept[0].dir !== '',
      `保留：${kept.map((d) => d.dir || '根').join(', ')}`
    )
    const keptBytes = kept.reduce((n, d) => n + Buffer.byteLength(d.content), 0)
    assert('C4d 保留总量不超预算', keptBytes <= M.PROJECT_DOC_CHAIN_MAX_BYTES, `${keptBytes} <= ${M.PROJECT_DOC_CHAIN_MAX_BYTES}`)
    const txt = M.projectDocPromptSection(docs).join('\n')
    assert('C4e 被丢弃的路径在提示词里列出（告知模型它存在）', txt.includes('未展开') && txt.includes('AGENTS.md'), '有告知')
    assert(
      'C4f 最窄那份完整保留（不截断）',
      kept.some((d) => d.dir === 'mid/deep' && !d.truncated),
      kept.map((d) => `${d.dir}${d.truncated ? '(截断)' : ''}`).join(', ')
    )
  }

  /* ───────── C5：注入稳定性（同磁盘内容 → 逐字节相同）───────── */
  console.log('\n-- C5 注入字符串稳定（缓存前缀不被打断）--')
  {
    const home = mkFixture(path.join(root, 'stable'), [
      ['AGENTS.md', 'STABLE-ROOT'],
      ['b/AGENTS.md', 'B-DOC'],
      ['a/AGENTS.md', 'A-DOC']
    ])
    const t1 = M.projectDocPromptSection(M.loadProjectDocChain(home)).join('\n')
    const t2 = M.projectDocPromptSection(M.loadProjectDocChain(home)).join('\n')
    eq('C5a 两次读取注入串相同', t1 === t2, true)
    const dirs1 = M.loadProjectDocChain(home).map((d) => d.dir)
    const dirs2 = M.loadProjectDocChain(home).map((d) => d.dir)
    eq('C5b 两次发现顺序相同（排序确定）', JSON.stringify(dirs1), JSON.stringify(dirs2))
    assert('C5c 子目录按名字排序（a 在 b 前）', dirs1.indexOf('a') < dirs1.indexOf('b'), JSON.stringify(dirs1))
  }

  /* ───────── C6：无文件 / 空文件 → 空数组 ───────── */
  console.log('\n-- C6 边界 --')
  {
    eq('C6a null root → []', M.projectDocPromptSection(M.loadProjectDocChain(null)).length, 0)
    const empty = mkFixture(path.join(root, 'empty'), [['AGENTS.md', '   \n\n  ']])
    eq('C6b 只有空白内容的文件 → []', M.projectDocPromptSection(M.loadProjectDocChain(empty)).length, 0)
    const none = mkFixture(path.join(root, 'none'), [['x.txt', 'hi']])
    eq('C6c 没有 AGENTS.md → []', M.projectDocPromptSection(M.loadProjectDocChain(none)).length, 0)
    eq('C6d 只认 AGENTS.md（CLAUDE.md 不读）', M.loadProjectDocChain(none).length, 0)
  }

  fs.rmSync(root, { recursive: true, force: true })
  console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})