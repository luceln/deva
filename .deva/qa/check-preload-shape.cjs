/**
 * preload 形状校验：我们二开在 `window.deva` 上暴露的东西必须**都还在**。
 *
 * 背景：`preload/index.ts` 曾把二开独有通道（导入、worktree）就地写进同一个文件，与上游改动
 * 频繁冲突。把这些块搬进 `preload/import.ts`、`preload/worktree.ts` 后，唯一的风险是**漏搬一个
 * 方法**或**键名/通道名漂移**——编译能过、界面点下去却报 `undefined is not a function`。
 *
 * 判据（**单向**：只守「我们二开该有的还在」，不限制上游新增）：
 *  1. 基线里的每个顶层键都必须存在；
 *  2. 基线里列出的命名空间，其每个方法名都必须还在；
 *  3. 二开通道字符串仍在——抓「方法还在、但通道名被改」这种更隐蔽的漂移。
 *
 * ## ⚠️ 覆盖盲区：24 个命名空间里只有 3 个守方法名，其余 21 个是 `null`
 *
 * `BASELINE` 里 `null` 的含义是「**只守这个命名空间存在，不守它有哪些方法**」。
 * 现在只有 `import`（3 个）、`worktree`（13 个）、`window`（6 个）给了具体清单——
 * 因为这三处是我们二开独有的、随时可能被上游改动「顺手」动到的东西。
 * 其余 21 个（`chat`、`memory`、`skills`、`terminal`、`git` …）沿用的是上游的方法集，共 200 多个方法名：
 * 全列进基线等于每次合并上游都要同步一份拷贝，维护成本高且容易过时，所以刻意不列。
 *
 * **代价必须知道**：`null` 的命名空间里，方法被删**不会有人发现**——脚本只看「这个键在不在」。
 *
 * **新增二开独有方法时（例如往 `memory` 里加一个上游没有的 `condense`），必须把该命名空间从
 * `null` 改成具体方法清单**。不补基线，这个方法将来被上游重写删掉时，编译、类型、driver 全绿，
 * 界面点下去才 `undefined is not a function`——正是本脚本存在的意义被绕过。
 * 改法：把 `BASELINE.memory` 从 `null` 换成数组，只列**二开独有的**方法名即可
 *（不必列全上游方法，那样又会制造上面那份维护负担）。
 *
 * 为什么不双向比：上游加一个新 IPC 通道、新命名空间方法是**正常演进**，不该让我们的 CI 变红。
 * 早期版本用集合相等（`eqSet`）双向比对，上游一加通道就报「多」，等于把上游演进当成我们的回归。
 * 现在顶层键、方法名、通道名三处都只查「缺」，多出来的一律放过，只在输出里报个数便于观察。
 *
 * 截获方式与真实暴露路径一致：给 electron 一个桩，`contextBridge.exposeInMainWorld` 记下传进来的对象。
 * 因此**不需要**在产品代码里挂任何只供测试用的导出。
 *
 * 基线变更（以后新增通道）要同步改 BASELINE，属于有意的契约变更，不是放宽检查。
 *
 * 运行：node .deva/qa/check-preload-shape.cjs
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const QA = __dirname
const ROOT = path.resolve(QA, '..', '..')

/** 拆分当时的 `window.deva` 形状基线。 */
const BASELINE = {
  platform: 'string',
  window: ['close', 'isFullScreen', 'minimize', 'onFullScreen', 'setOverlaySymbolColor', 'toggleMaximize'],
  fs: null,
  config: null,
  skills: null,
  import: ['onProgress', 'probe', 'run'],
  profile: null,
  memory: null,
  personas: null,
  mcp: null,
  secrets: null,
  provider: null,
  chat: null,
  worktree: [
    'brief',
    'create',
    'installDeps',
    'list',
    'merge',
    'mergeDryRun',
    'onChanged',
    'onProgress',
    'onSize',
    'precheck',
    'rebuild',
    'remove',
    'setTarget'
  ],
  terminal: null,
  git: null,
  tasks: null,
  clipboard: null,
  deliverables: null,
  workspace: null,
  browser: null,
  update: null,
  remote: null,
  phone: null
}

/** 二开通道名：搬模块时最容易被改错的东西。 */
const KEY_CHANNELS = [
  'import:probe',
  'import:run',
  'import:progress',
  'worktree:precheck',
  'worktree:create',
  'worktree:list',
  'worktree:merge',
  'worktree:merge-dryrun',
  'worktree:changed',
  'worktree:size',
  'worktree:progress'
]

let fails = 0
function pass(name, detail = '') {
  console.log(`  PASS ${name}${detail ? ' :: ' + detail : ''}`)
}
function fail(name, detail) {
  fails++
  console.log(`  FAIL ${name} :: ${detail}`)
}
/**
 * 单向包含：基线的每一项都必须在实际里。多出来的（上游新增）不算失败，只在 detail 里报个数。
 * 这是本脚本所有判据的统一口径——见文件头的「为什么不双向比」。
 */
function includesAll(name, actual, expected) {
  const a = new Set(actual)
  const missing = [...expected].filter((x) => !a.has(x))
  const extra = [...a].filter((x) => !new Set(expected).has(x))
  if (!missing.length) {
    pass(name, `${expected.length} 项齐全${extra.length ? `，另有 ${extra.length} 项上游新增（不拦截）` : ''}`)
  } else {
    fail(name, `缺=${JSON.stringify(missing)}${extra.length ? `；另有 ${extra.length} 项上游新增（不拦截）` : ''}`)
  }
}

async function main() {
  const shimPath = path.join(QA, '.electron-shim.mjs')
  const entryPath = path.join(QA, '.preload-shape-entry.ts')
  const outfile = path.join(QA, '.preload-shape.mjs')

  // 桩：记录通道名；exposeInMainWorld 把真实对象交给 globalThis.__exposed
  fs.writeFileSync(
    shimPath,
    [
      'globalThis.__channels = globalThis.__channels || []',
      'export const contextBridge = {',
      '  exposeInMainWorld: (k, obj) => { globalThis.__exposed = obj }',
      '}',
      'export const ipcRenderer = {',
      '  invoke: (ch) => { globalThis.__channels.push(ch); return Promise.resolve(null) },',
      '  on: (ch) => { globalThis.__channels.push(ch) },',
      '  removeListener: (ch) => { globalThis.__channels.push(ch) }',
      '}',
      'export const webUtils = { getPathForFile: () => "" }',
      ''
    ].join('\n')
  )
  // 入口：真实 preload 走的是 contextIsolated=true 分支；进程对象在 node 下没有 contextIsolated，补上
  fs.writeFileSync(
    entryPath,
    [
      ';(globalThis).window = globalThis',
      'if (typeof process !== "undefined") { process.contextIsolated = true }',
      "await import('../../apps/desktop/src/preload/index')",
      ''
    ].join('\n')
  )

  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    alias: { electron: shimPath },
    logLevel: 'warning'
  })

  await import('file://' + outfile.replace(/\\/g, '/'))
  const api = globalThis.__exposed
  const channels = globalThis.__channels || []

  if (api) {
    pass('preload 经 contextBridge 暴露 api', `顶层 ${Object.keys(api).length} 键`)
    includesAll('基线顶层键都还在', Object.keys(api), Object.keys(BASELINE))
    for (const [k, expected] of Object.entries(BASELINE)) {
      if (!Array.isArray(expected)) continue
      const v = api[k]
      if (!v || typeof v !== 'object') {
        fail(`命名空间 ${k} 存在且是对象`, String(v))
        continue
      }
      includesAll(`${k} 的方法都还在`, Object.keys(v), expected)
    }
  } else {
    fail('preload 经 contextBridge 暴露 api', '未截获到 exposeInMainWorld 调用')
  }

  /*
   * 通道名是**惰性**的：`ipcRenderer.invoke/on` 只在方法被调用时才执行。所以这里把每个方法都空打一次
   * （`invoke` 桩返回 null，`on` 桩只记录），才能把整张通道表采出来——这正是「方法还在、通道名被改」
   * 唯一能验的方式。on* 传一个 noop 回调，返回值（取消订阅函数）不影响采集。
   */
  if (api) {
    for (const k of Object.keys(api)) {
      const ns = api[k]
      if (!ns || typeof ns !== 'object') continue
      for (const m of Object.keys(ns)) {
        const fn = ns[m]
        if (typeof fn !== 'function') continue
        try {
          await fn(m.startsWith('on') ? () => {} : 'qa')
        } catch {
          /* 桩健全性无关：真 TypeError 会在下面的通道缺失里暴露 */
        }
      }
    }
  }

  const uniq = [...new Set(channels)]
  const missingCh = KEY_CHANNELS.filter((c) => !uniq.includes(c))
  if (!missingCh.length) pass('二开通道名未漂移', `${KEY_CHANNELS.length} 个关键通道，共 ${uniq.length} 个不同通道`)
  else fail('二开通道名未漂移', `缺=${JSON.stringify(missingCh)}`)

  for (const f of [entryPath, shimPath, outfile]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* 忽略 */
    }
  }

  if (fails) {
    console.log(`\npreload 形状校验失败：${fails} 项`)
    process.exitCode = 1
  } else {
    console.log('\npreload 形状校验通过：基线里的顶层键、命名空间方法、二开通道名都还在（上游新增不拦截）。')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})