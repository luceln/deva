/**
 * 2-B（合并写 + 读回断言）的验收脚本。架构给的 8 条场景逐条对应。
 *
 * 核心判据是 **#1 与 #7**：
 *   #1 收尾后立刻用陈旧 models 快照回写 → 必须失败（2-B 的直接目标）
 *   #7 主进程造一个不在渲染层快照里的 provider，再让渲染层用旧快照回写 → 必须失败（不变量本身）
 * 只有 #1 通过、#7 失败，说明只是又缩了一次窗口。
 *
 * 运行：node .deva/qa/repro-2b.cjs [场景名...]
 */
import * as fs from 'fs'
import * as path from 'path'

import { runImport } from '../../apps/desktop/src/main/importer'
import {
  applyHeldPatches,
  beginConfigHold,
  endConfigHold,
  getConfig,
  mergeModelsPatch,
  registerConfigIpc,
  setConfig
} from '../../apps/desktop/src/main/services/config'

const HOME = process.env.TEST_HOME as string
const DST = process.env.DEVA_HOME as string
const SRC = path.join(HOME, '.deva')

let fails = 0
const pass = (n: string, d = ''): void => console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n: string, d = ''): void => {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const info = (n: string, d = ''): void => console.log(`INFO ${n}${d ? ` :: ${d}` : ''}`)
const check = (n: string, c: boolean, d = ''): boolean => (c ? pass(n, d) : fail(n, d), c)
const eq = (n: string, a: unknown, e: unknown): boolean => {
  const A = JSON.stringify(a)
  const E = JSON.stringify(e)
  return check(n, A === E, A === E ? A : `实际=${A} 期望=${E}`)
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}
function writeJson(p: string, v: unknown): void {
  mkdirp(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}
function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
function installWindow(): Map<string, Function> {
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)
  return (require('electron') as any).__test.ipcHandlers
}
const ids = (cfg: any): string[] =>
  ((cfg?.models?.providers ?? []) as any[]).map((p) => p.id).filter(Boolean)
const prov = (id: string): any => ({ id, name: id, apiHost: `https://${id}.invalid`, models: [] })

function seed(opts: { src?: string[]; dst?: string[]; active?: string | null }): void {
  rmrf(SRC)
  rmrf(DST)
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: (opts.src ?? []).map(prov),
      activeModelId: opts.active ?? null
    }
  })
  writeJson(path.join(DST, 'config.json'), {
    models: { providers: (opts.dst ?? []).map(prov), activeModelId: null }
  })
  getConfig() // 触发载入
}

/* ═════════ #1 与 #7：陈旧快照回写 ═════════ */

async function scenarioStaleAfterImport(): Promise<void> {
  const handlers = installWindow()

  // #1：收尾后（导入已完成、hold 已释放）立刻用陈旧快照回写
  seed({ src: ['imp-a'], dst: ['local-x'] })
  const stale1 = { models: { providers: [prov('local-x')], activeModelId: null } }
  const r1: any = await runImport()
  info('#1 导入报告', JSON.stringify({ ok: r1.ok, copied: r1.providers.copied }))
  eq('#1 导入成功', r1.providers.copied, ['imp-a'])
  const before = ids(readJson(path.join(DST, 'config.json')))
  info('#1 导入后 providers', JSON.stringify(before))

  // 收尾之后才回写（模拟「hold 释放 → 渲染层还没重载完成」那段窗口里的一次陈旧回写）
  const setHandler = handlers.get('config:set')!
  const rr: any = await setHandler({}, stale1)
  info('#1 回写结果', JSON.stringify(rr))
  const after = ids(readJson(path.join(DST, 'config.json')))
  info('#1 回写后 providers', JSON.stringify(after))
  check('#1 收尾后的陈旧快照回写没抹掉导入的 imp-a', after.includes('imp-a'), JSON.stringify(after))
  check('#1 本地 local-x 仍在', after.includes('local-x'), JSON.stringify(after))

  // #7：主进程造一个不在渲染层快照里的 provider，再让渲染层用旧快照回写
  seed({ src: [], dst: ['local-x'] })
  // 模拟「主进程侧新增了 mp-new」（导入 / 另一窗口 / 任何主进程写入）
  setConfig({ models: { providers: [prov('local-x'), prov('mp-new')], activeModelId: null } })
  const stale7 = { models: { providers: [prov('local-x')], activeModelId: null } }
  await setHandler({}, stale7)
  const after7 = ids(readJson(path.join(DST, 'config.json')))
  info('#7 回写后 providers', JSON.stringify(after7))
  check(
    '#7 不变量：渲染层删不掉它没见过的 provider（mp-new 仍在）',
    after7.includes('mp-new'),
    `实际=${JSON.stringify(after7)}`
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════ #2 异常路径（回归守卫） ═════════ */

async function scenarioThrowPath(): Promise<void> {
  installWindow()
  seed({ src: ['imp-a'], dst: ['local-x'] })
  getConfig()
  const r1: any = await runImport()
  info('第 1 轮', JSON.stringify({ ok: r1.ok, copied: r1.providers.copied }))

  const handlers = (require('electron') as any).__test.ipcHandlers
  const stale = { models: { providers: [prov('local-x')], activeModelId: null } }
  let injected = 0
  const r2: any = await runImport((p) => {
    if (p.step === 'sessions' && injected === 0) {
      injected++
      void handlers.get('config:set')!({}, stale)
      throw new Error('boom-after-inject')
    }
  })
  info('异常路径报告', JSON.stringify({ ok: r2.ok, failures: r2.failures }))
  const after = ids(readJson(path.join(DST, 'config.json')))
  check('#2 异常路径补回了 imp-a', after.includes('imp-a'), JSON.stringify(after))
  process.exit(fails ? 1 : 0)
}

/* ═════════ #3/#4/#5 守卫：合并语义的细则 ═════════ */

function scenarioMergeRules(): void {
  // ⚠️ 顺序要紧：registerConfigIpc 内部会 ensureLoaded，把当时的 config.json 载入模块级缓存，
  // 之后再写文件也不会被读。所以先落盘再装 IPC。
  seed({ src: [], dst: ['a', 'b'] })
  installWindow()

  // 确认基线：磁盘 providers = a, b
  eq('#3 基线 providers', ids(readJson(path.join(DST, 'config.json'))), ['a', 'b'])

  // #3 同 id 覆盖：渲染层改过的 host 要生效
  const m3 = mergeModelsPatch({ models: { providers: [{ ...prov('a'), apiHost: 'https://changed.invalid' }] } }) as any
  const a3 = m3.models.providers.find((p: any) => p.id === 'a')
  check('#3 同 id 用 incoming 覆盖（host 变了）', a3?.apiHost === 'https://changed.invalid', JSON.stringify(a3))
  check('#3 磁盘有而 incoming 没有的 b 被保留', m3.models.providers.some((p: any) => p.id === 'b'), '')

  // #4 新增追加
  const m4 = mergeModelsPatch({ models: { providers: [prov('a'), prov('b'), prov('c')] } }) as any
  eq('#4 新增的 c 被追加', ids({ models: m4.models }).sort(), ['a', 'b', 'c'])

  // #5 显式删除才删（removedProviders）
  const m5 = mergeModelsPatch({ models: { providers: [prov('a')] }, removedProviders: ['b'] }) as any
  eq('#5 removedProviders 里点名的 b 被删', ids({ models: m5.models }).sort(), ['a'])
  // 不声明删除时，incoming 少给一个也不能删
  const m5b = mergeModelsPatch({ models: { providers: [prov('a')] } }) as any
  eq('#5 不声明删除时 b 不被删', ids({ models: m5b.models }).sort(), ['a', 'b'])

  // models === undefined → 原样返回（尊重 undefined 删键协议）
  const m6 = mergeModelsPatch({ models: undefined, theme: 'dark' })
  check('#5 models=undefined 原样返回（不擅自合并）', (m6 as any).models === undefined, JSON.stringify(m6))

  // 单值字段 incoming 胜
  const m7 = mergeModelsPatch({ models: { providers: [], activeModelId: 'x:m1', activeEffort: 'high' } }) as any
  eq('#5 activeModelId 等单值字段 incoming 胜', [m7.models.activeModelId, m7.models.activeEffort], ['x:m1', 'high'])

  /*
   * P2-4：`removedProviders` 是内部簿记键，不能留在合并结果里——setConfig 逐键写入 config.json，
   * 留下它就会在用户手改 config.json 时出现一个无文档解释的数组，而且永远不会自己消失
   * （删键条件是「值为 undefined」，渲染层清空后是不传这个键）。
   */
  check('#5b 合并结果里没有 removedProviders 键', !('removedProviders' in m5), JSON.stringify(m5))
  process.exit(fails ? 1 : 0)
}

/* ═════════ #6 {ok:false} 时渲染层不清 ref（主进程侧的可观测面） ═════════ */

async function scenarioWriteFail(): Promise<void> {
  const handlers = installWindow()
  seed({ src: [], dst: [] })
  // 让 config.json 变成目录 → 落盘必失败
  rmrf(path.join(DST, 'config.json'))
  mkdirp(path.join(DST, 'config.json'))
  const rr: any = await handlers.get('config:set')!({}, { models: { providers: [prov('z')] }, removedProviders: ['z'] })
  info('#6 回写结果', JSON.stringify(rr))
  eq('#6 落盘失败 → ok:false', rr.ok, false)
  eq('#6 落盘失败 → error 码', rr.error, 'config-write-failed')
  check('#6 失败时没有 queued 标记（不是被暂存）', rr.queued === undefined, JSON.stringify(rr))

  // P2-4：removedProviders 不能落进磁盘的 config.json
  rmrf(path.join(DST, 'config.json'))
  await handlers.get('config:set')!({}, { models: { providers: [prov('a')] }, removedProviders: [] } as any)
  const onDisk = JSON.parse(fs.readFileSync(path.join(DST, 'config.json'), 'utf8'))
  check(
    '#6b 磁盘 config.json 里没有 removedProviders（内部簿记键不落盘）',
    !('removedProviders' in onDisk),
    JSON.stringify(onDisk).slice(0, 200)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════ #8 导入窗口内删 provider：不复活 ═════════ */

async function scenarioExcludeIds(): Promise<void> {
  const handlers = installWindow()
  seed({ src: ['imp-a', 'imp-b'], dst: ['local-x'] })
  getConfig()

  // 导入期间：用户在渲染层删掉 local-x（排队补丁里带 removedProviders）
  const stale = {
    models: { providers: [prov('local-x')], activeModelId: null },
    removedProviders: ['local-x']
  }
  const r: any = await runImport((p) => {
    if (p.step === 'sessions') void handlers.get('config:set')!({}, stale)
  })
  info('#8 报告', JSON.stringify({ ok: r.ok, copied: r.providers.copied, failures: r.failures }))
  const after = ids(readJson(path.join(DST, 'config.json')))
  info('#8 收尾后 providers', JSON.stringify(after))
  check('#8 导入的两个 provider 都在', after.includes('imp-a') && after.includes('imp-b'), JSON.stringify(after))
  check(
    '#8 用户本轮删掉的 local-x 没被补回复活',
    !after.includes('local-x'),
    `实际=${JSON.stringify(after)}`
  )
  // 读回断言不该把用户主动删的算成「丢了的导入成果」
  check(
    '#8 读回断言没把主动删除误报为 imported-provider-missing',
    !(r.failures ?? []).some((f: any) => f.reason === 'imported-provider-missing'),
    JSON.stringify(r.failures)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════ 入口 ═════════ */

const S: Record<string, () => Promise<void> | void> = {
  stale: scenarioStaleAfterImport,
  throwpath: scenarioThrowPath,
  merge: scenarioMergeRules,
  writefail: scenarioWriteFail,
  exclude: scenarioExcludeIds
}

async function main(): Promise<void> {
  const name = process.argv[2]
  const fn = S[name]
  if (!fn) {
    console.error(`未知场景 ${name}`)
    process.exit(2)
  }
  try {
    await fn()
  } catch (e) {
    fail(`${name} 抛异常`, (e as Error)?.stack?.split('\n').slice(0, 5).join(' / ') ?? String(e))
  }
  console.log(`=== ${name} 结束：FAIL ${fails} ===`)
  process.exit(fails ? 1 : 0)
}
void main()
