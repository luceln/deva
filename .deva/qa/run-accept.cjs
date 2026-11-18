/**
 * 跑独立验收脚本的驱动。
 *
 * ## 为什么需要它
 *
 * `accept-merge-check.cjs` / `accept-src-readonly.cjs` 直接 `import('../../apps/desktop/src/main/...')`，
 * 而这些是 **TypeScript 源码**——node 直接跑会 `ERR_MODULE_NOT_FOUND`。验收时是临时用 esbuild 打包后跑的，
 * 脚本本身没带这一步，于是「当时验过了」的东西事后复跑不出来。
 *
 * 这和本项目反复踩的坑同形：**留下结论，但留下不了产生结论的手段**。所以这里把打包步骤做成固定的，
 * 和 `driver.cjs` 用同一套 esbuild 配置与同一个 electron 桩。
 *
 * ## 用法
 *
 *   node .deva/qa/run-accept.cjs                      跑全部 case
 *   node .deva/qa/run-accept.cjs mem-tri sec-tri      只跑指定的
 *   node .deva/qa/run-accept.cjs --list               列出可用 case
 *
 * ## 每个 case 单独进程
 *
 * 它们各自 `process.env.USERPROFILE=...` 指向临时 home；同进程连着跑会互相污染。
 * 所以一个一个 spawn，各自拿干净的 env。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const QA = __dirname
const DIST = path.join(QA, 'dist', 'accept')
const STUB = path.join(QA, 'stub-electron.cjs')

/** case → 源文件。accept-src-readonly 与 accept-ipc-pairs 不需要参数，各自单独一个。 */
const CASES = {
  'mem-tri': { file: 'accept-merge-check.cjs', argv: ['mem-tri'], what: '记忆三态（读不出 ≠ 没有）' },
  'sec-tri': { file: 'accept-merge-check.cjs', argv: ['sec-tri'], what: '密钥四态（store-unreadable ≠ absent）' },
  'model-kinds': { file: 'accept-merge-check.cjs', argv: ['model-kinds'], what: '模型失效五类' },
  'wk-mem': { file: 'accept-merge-check.cjs', argv: ['wk-mem'], what: 'worktree 会话读主仓记忆' },
  consolidate: { file: 'accept-merge-check.cjs', argv: ['consolidate'], what: '记忆写满自动归纳（需真实模型，通常会 SKIP）' },
  'src-readonly': { file: 'accept-src-readonly.cjs', argv: [], what: '导入不碰原版 ~/.deva（需真实数据）' },
  'ipc-pairs': { file: 'accept-ipc-pairs.cjs', argv: [], what: 'preload ↔ 主进程 handler 双向核对' }
}

async function buildOne(src, out) {
  fs.mkdirSync(DIST, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(QA, src)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    alias: { electron: STUB },
    logLevel: 'warning',
    // 只外置 node 内置模块；其余全部打进 bundle（与 driver.cjs 同配置）
    external: ['electron']
  })
}

function runOne(name) {
  const c = CASES[name]
  // 打包产物按**源文件名**命名（同一个源文件被多个 case 复用，只打包一次），
  // 不能按 case 名命名——之前那样写会去找 mem_tri.cjs 这种不存在的文件，全部 exit=1 且没有任何输出。
  const out = path.join(DIST, path.basename(c.file, '.cjs') + '.cjs')
  const r = spawnSync(process.execPath, [out, ...c.argv], {
    encoding: 'utf8',
    // 显式管道 + windowsHide：继承默认 stdio 串链条时父进程会等不到子进程退出（本项目实测过）
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 180000
  })
  const text = (r.stdout || '') + (r.stderr || '')
  const pass = (text.match(/^PASS/gm) || []).length
  const fail = (text.match(/^FAIL/gm) || []).length
  const skip = (text.match(/^SKIP/gm) || []).length
  return { name, code: r.status, pass, fail, skip, text }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const [k, v] of Object.entries(CASES)) console.log(`${k.padEnd(14)} ${v.what}`)
    return
  }
  const pick = args.length ? args : Object.keys(CASES)
  const unknown = pick.filter((n) => !CASES[n])
  if (unknown.length) {
    console.error(`未知 case：${unknown.join(', ')}；用 --list 看可用项`)
    process.exit(2)
  }

  console.log('== 打包（TS 源码 → cjs，electron 走桩）==')
  const built = new Set()
  for (const n of pick) {
    const c = CASES[n]
    if (built.has(c.file)) continue
    await buildOne(c.file, path.join(DIST, path.basename(c.file, '.cjs') + '.cjs'))
    built.add(c.file)
  }
  console.log('ok\n')

  const results = []
  for (const n of pick) {
    const r = runOne(n)
    results.push(r)
    const tag = r.fail === 0 && r.code === 0 ? 'OK  ' : r.code === 0 && r.skip > 0 ? 'SKIP' : 'FAIL'
    console.log(`${tag} ${n.padEnd(14)} pass=${String(r.pass).padStart(3)} fail=${r.fail} skip=${r.skip} exit=${r.code}`)
    if (tag === 'FAIL') {
      for (const line of r.text.split('\n').filter((l) => /^FAIL/.test(l))) console.log(`       ${line}`)
    }
  }

  const bad = results.filter((r) => r.fail > 0 || r.code !== 0)
  console.log(`\n共 ${results.length} 项：${results.length - bad.length} 通过，${bad.length} 有问题`)
  if (bad.length) {
    console.log('\n看详细输出：node .deva/qa/run-accept.cjs <case> 后自行查看 .deva/qa/dist/accept/ 下的产物')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
