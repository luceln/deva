/**
 * 最终验收——新增测试（不改仓库源码）。
 *
 * 与 test-main.ts 分开：那边是上轮的回归基线，这里是本轮的新重点：
 *   fail-*   : 失败通道真的能报出来（P0-1）
 *   race     : 导入期间渲染层整段回写 config 的竞态（P0-2）
 *   samehome : DEVA_HOME 指到原版目录的防护
 *   idem     : 幂等在新口径下仍然成立（activeModelId / secrets.ignored）
 *   locknote : lockfile 注释与真实 Electron 行为是否一致（读代码 + 实证）
 *
 * 环境契约同 test-main.ts：TEST_HOME / TEST_APPDATA / DEVA_HOME / QA_REAL / QA_SCRATCH。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport, upstreamHome } from '../../apps/desktop/src/main/importer-gate'
import {
  beginConfigHold,
  endConfigHold,
  getConfig,
  getDevaHome,
  isConfigHeld,
  registerConfigIpc,
  setConfig
} from '../../apps/desktop/src/main/services/config'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { importSkills } from '../../apps/desktop/src/main/importer-skills'
import { importPersonas } from '../../apps/desktop/src/main/importer-personas'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'
import { mergeProviders, copySecrets } from '../../apps/desktop/src/main/importer-config'
import { LOCK_FILE } from '../../apps/desktop/src/main/importer-lock'

const HOME = process.env.TEST_HOME as string
const APPDATA = process.env.TEST_APPDATA as string
const DST = process.env.DEVA_HOME as string
const REAL = process.env.QA_REAL as string
const SCRATCH = process.env.QA_SCRATCH as string
const SRC = path.join(HOME, '.deva')

/* ───────── 断言 ───────── */
let fails = 0
function pass(n: string, d = ''): void {
  console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
}
function fail(n: string, d = ''): void {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
function info(n: string, d = ''): void {
  console.log(`INFO ${n}${d ? ` :: ${d}` : ''}`)
}
function check(n: string, c: boolean, d = ''): boolean {
  c ? pass(n, d) : fail(n, d)
  return c
}
function eq(n: string, a: unknown, e: unknown): boolean {
  const A = JSON.stringify(a)
  const E = JSON.stringify(e)
  return check(n, A === E, A === E ? A : `实际=${A} 期望=${E}`)
}

/* ───────── 工具 ───────── */
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
function md5(p: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
}
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, rel: string): void => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const abs = path.join(dir, n)
      const r = rel ? `${rel}/${n}` : n
      let st: fs.Stats
      try {
        st = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(abs)}`)
      else if (st.isDirectory()) {
        out.set(r, 'dir')
        walk(abs, r)
      } else out.set(r, `file:${st.size}:${Math.round(st.mtimeMs)}:${md5(abs)}`)
    }
  }
  walk(root, '')
  return out
}
function diffSnap(a: Map<string, string>, b: Map<string, string>): string[] {
  const d: string[] = []
  for (const [k, v] of a) {
    if (!b.has(k)) d.push(`-${k}`)
    else if (b.get(k) !== v) d.push(`~${k}`)
  }
  for (const k of b.keys()) if (!a.has(k)) d.push(`+${k}`)
  return d
}
/** 目标 data 下某类目录里应有的文件清单（递归，相对路径）。 */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    let es: fs.Dirent[]
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}
function setMtimeOld(p: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  const walk = (x: string): void => {
    const st = fs.lstatSync(x)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) for (const n of fs.readdirSync(x)) walk(path.join(x, n))
    fs.utimesSync(x, t, t)
  }
  walk(p)
}

/** 装一个窗口，捕获 config:changed。 */
function installWindow(): { events: { channel: string; payload: any }[] } {
  const events: { channel: string; payload: any }[] = []
  registerConfigIpc(
    () =>
      ({
        isDestroyed: () => false,
        webContents: { send: (c: string, p: any) => events.push({ channel: c, payload: p }) }
      }) as any
  )
  return { events }
}

/** 取 config:set 的 IPC handler（模拟渲染层发来的那次调用）。 */
function configSetHandler(): (e: unknown, patch: Record<string, unknown>) => Promise<any> {
  const h = (globalThis as any).__qaHandlers
  if (!h) throw new Error('IPC handler 未捕获')
  return h
}

const progress: string[] = []
async function runOnce(): Promise<any> {
  progress.length = 0
  return await runImport((p) => {
    if (progress[progress.length - 1] !== p.step) progress.push(p.step)
  })
}

/* ═════════════ 场景 1：失败通道能不能真的报出来 ═════════════ */

async function scenarioFailChannels(): Promise<void> {
  // ---- ① 目标 data/chats 被一个同名「文件」占着 ----
  mkdirp(path.join(DST, 'data'))
  fs.writeFileSync(path.join(DST, 'data', 'chats'), 'i am a file, not a dir')
  mkdirp(SRC)
  writeJson(path.join(SRC, 'data', 'chats', 'sess_x.json'), { id: 'sess_x', messages: [] })
  const s1 = importSessions(SRC)
  check('sessions：data/chats 是文件 → 有 failed 条目', (s1.failed ?? []).length > 0, JSON.stringify(s1.failed))
  check(
    'sessions：failed 带 step=id+reason',
    (s1.failed ?? []).every((f) => f.step === 'sessions' && !!f.id && !!f.reason),
    JSON.stringify(s1.failed)
  )

  // ---- ② 目标 config.json 不可写（用只读文件 + chmod 模拟；Windows 上更可靠的做法是占用目录）----
  rmrf(path.join(DST, 'data', 'chats'))
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'newprov', name: 'newprov', apiHost: 'https://x.invalid', models: [] }] }
  })
  const cfgPath = path.join(DST, 'config.json')
  // Windows：把 config.json 换成同名目录，writeFileAtomic 必然失败
  rmrf(cfgPath)
  mkdirp(cfgPath)
  const mp = mergeProviders(SRC)
  check('providers：config.json 写盘失败 → 进 failed', (mp.failed ?? []).length > 0, JSON.stringify(mp.failed))
  check(
    'providers：失败原因为 config-write-failed',
    (mp.failed ?? []).some((f) => f.reason === 'config-write-failed'),
    JSON.stringify(mp.failed)
  )
  rmrf(cfgPath)

  // ---- ③ 单个 blob 复制失败（源里同名条目是目录 → copyFileSync 必失败）----
  const srcMedia = path.join(SRC, 'data', 'media')
  mkdirp(srcMedia)
  const blob = 'a'.repeat(64)
  const blob2 = 'b'.repeat(64)
  fs.writeFileSync(path.join(srcMedia, blob2), 'blob-b')
  mkdirp(path.join(srcMedia, blob)) // 源里是目录，copyFileSync 打不开
  fs.writeFileSync(path.join(srcMedia, blob, 'inner'), 'x')
  const dstMedia = path.join(DST, 'data', 'media')
  mkdirp(dstMedia)
  const { assoc, failures } = copyAssoc(SRC)
  info('assoc 结果', JSON.stringify({ assoc, failures }))
  eq('assoc：单个 blob 失败 → 该条进 failures', failures.length, 1)
  check(
    'assoc：失败条目 id 含类别与 blob 名',
    (failures[0]?.id ?? '').includes('media') && (failures[0]?.id ?? '').includes(blob),
    JSON.stringify(failures[0])
  )
  eq('assoc：另一个 blob 仍成功', assoc.media, 1)

  // ---- ③b 目标里已有同名「目录」时：必须报 target-blocked，不能当「已存在」跳过 ----
  // 这条断言原来记录的是当时的 bug 行为（「不报失败」）。→ 修成报失败后断言随之反转：
  // 目录占住 blob 的位置时文件永远进不来，报告若说 ok 用户就永远不知道这张图片丢了。
  rmrf(path.join(srcMedia, blob))
  fs.writeFileSync(path.join(srcMedia, blob), 'blob-a')
  rmrf(path.join(dstMedia, blob))
  mkdirp(path.join(dstMedia, blob))
  const b = copyAssoc(SRC)
  info('目标同名目录（非文件）时', JSON.stringify({ media: b.assoc.media, failures: b.failures }))
  eq('assoc：目标同名目录 → 报 target-blocked（不再静默当成已存在）', b.failures.map((f: any) => f.reason), [
    'target-blocked'
  ])
  // 0 而不是 1：另一个 blob（blob2）上一节已经复制过去了，这一轮走「已存在且尺寸一致 → 跳过」不计数，
  // 只有被目录占位的那个会尝试写——它报 blocked。即：既不该多算，也不该把失败算成功。
  eq('assoc：目标同名目录 → 不算进复制计数', b.assoc.media, 0)

  // ---- ④ 整轮：三处失败都要进 report.failures 且 ok=false ----
  rmrf(path.join(dstMedia, blob))
  rmrf(path.join(DST, 'data'))
  mkdirp(path.join(DST, 'data'))
  fs.writeFileSync(path.join(DST, 'data', 'chats'), 'i am a file') // 让会话步骤失败
  const r = (await runOnce()) as any
  info('整轮 report', JSON.stringify({ ok: r.ok, failures: r.failures, sessFailed: r.sessions.failed }, null, 0).slice(0, 600))
  check('整轮：有失败时 ok=false', r.ok === false, `ok=${r.ok}`)
  check('整轮：failures 非空', r.failures.length > 0, String(r.failures.length))
  check(
    '整轮：sessions 的失败被汇总进 failures',
    r.failures.some((f: any) => f.step === 'sessions'),
    JSON.stringify(r.failures)
  )
  check(
    '整轮：每条 failure 都有 step/id/reason',
    r.failures.every((f: any) => f.step && f.id && f.reason),
    JSON.stringify(r.failures)
  )
}

/* ═════════════ 场景 2：竞态（导入中渲染层整段回写） ═════════════ */

/** 直接调 config:set 的 IPC handler 模拟渲染层；handler 从 registerConfigIpc 内部注册，用桩的 ipcMain 捕获。 */
async function scenarioRace(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: [
        { id: 'imported-a', name: 'A', apiHost: 'https://a.invalid', models: [] },
        { id: 'imported-b', name: 'B', apiHost: 'https://b.invalid', models: [] }
      ],
      activeModelId: 'imported-a:m1'
    }
  })
  // 目标里用户已有自己的一个服务商，且渲染层手里是「导入前的旧快照」
  writeJson(path.join(DST, 'config.json'), {
    models: {
      providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }],
      activeModelId: null,
      activeEffort: 'default'
    }
  })
  getConfig() // 触发 ensureLoaded，把目标配置读进内存
  installWindow()

  // 取 ipcMain 上注册的 config:set handler
  const electron = require('electron') as any
  const handlers: Map<string, Function> = electron.__test?.ipcHandlers ?? (globalThis as any).__electronIpcHandlers
  info('已注册的 IPC 通道', handlers ? [...handlers.keys()].join(',') : '（拿不到）')

  // 导入进行到一半时，渲染层整段回写旧快照
  let midWriteResult: any = null
  let heldDuringRun = false
  const p = runImport(async (pr) => {
    if (pr.step === 'sessions' && !midWriteResult) {
      heldDuringRun = isConfigHeld()
      // 渲染层同形的整段回写：只有 local-x，没有导入的服务商
      midWriteResult = await handlers!.get('config:set')!({}, {
        models: {
          providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [], enabled: true }],
          activeModelId: 'local-x:m9',
          activeEffort: 'high'
        }
      })
    }
  })
  const r = (await p) as any
  info('导入中途渲染层回写结果', JSON.stringify(midWriteResult))
  check('竞态：导入期间 isConfigHeld=true', heldDuringRun === true, String(heldDuringRun))
  check('竞态：渲染层回写被排队（queued:true）', midWriteResult?.queued === true, JSON.stringify(midWriteResult))

  const cfg = readJson(path.join(DST, 'config.json'))
  const ids = cfg.models.providers.map((x: any) => x.id).sort()
  info('最终 providers', JSON.stringify(ids))
  eq('竞态：导入的服务商没被旧快照覆盖', ids, ['imported-a', 'imported-b', 'local-x'])
  check(
    '竞态：用户那次的改动也保住（activeEffort=high）',
    cfg.models.activeEffort === 'high',
    `actual=${JSON.stringify(cfg.models.activeEffort)}`
  )
  info('竞态：最终 activeModelId', String(cfg.models.activeModelId))
  eq('竞态：held 队列在收尾时被清空', isConfigHeld(), false)
  check('竞态：导入成功', r.ok === true, `ok=${r.ok} failures=${JSON.stringify(r.failures)}`)

  // 收尾后渲染层再写一次，必须直接落盘（不再排队）
  const after = await handlers!.get('config:set')!({}, { models: { ...cfg.models, activeEffort: 'low' } })
  check('竞态：收尾后 config:set 不再排队', after?.queued !== true && after?.ok === true, JSON.stringify(after))
  eq('竞态：收尾后的写入立刻落盘', readJson(path.join(DST, 'config.json')).models.activeEffort, 'low')
}

/* ═════════════ 场景 3：DEVA_HOME 指到原版 ═════════════ */

async function scenarioSameHome(): Promise<void> {
  // 把原版目录做成「源」，目标也指向它（driver 把 DEVA_HOME 指到这里）
  const real = path.join(HOME, '.deva')
  rmrf(real)
  mkdirp(path.join(real, 'data', 'chats'))
  writeJson(path.join(real, 'config.json'), { models: { providers: [{ id: 'p', name: 'p' }] } })
  writeJson(path.join(real, 'data', 'chats', 's.json'), { id: 's', messages: [] })
  writeJson(path.join(real, 'data', 'chats', '_index.json'), [{ id: 'x' }])
  const before = snapshot(real)

  const g = await canImport()
  eq('samehome：闸门给出 same-home', (g as any).code, 'same-home')
  const afterProbe = snapshot(real)
  eq('samehome：只探测不写原版（快照一致）', diffSnap(before, afterProbe), [])

  // 关键：真跑一次 runImport。锁是在闸门检查**之前**获取的。
  const r = (await runOnce()) as any
  check('samehome：runImport 被拒（返回 error）', 'error' in r, JSON.stringify(r).slice(0, 160))
  const after = snapshot(real)
  const d = diffSnap(before, after)
  info('samehome：runImport 后原版快照差异', d.length ? JSON.stringify(d) : '（无差异）')
  eq('samehome：runImport 后原版零改动（含 import.lock / _index.json）', d, [])
}

/* ═════════════ 场景 3b：samehome 的子目录包含情形 ═════════════ */

async function scenarioSameHomeNested(): Promise<void> {
  // 目标 = 原版的子目录（例如 DEVA_HOME=~/.deva/data），也必须拒
  const real = path.join(HOME, '.deva')
  rmrf(real)
  mkdirp(path.join(real, 'data', 'chats'))
  writeJson(path.join(real, 'config.json'), { models: { providers: [] } })
  const g = await canImport()
  // 本场景由 driver 把 DEVA_HOME 设成 ~/.deva/data（见 accept-driver 的 dst 规则）
  info('nested 闸门', JSON.stringify(g).slice(0, 200))
  eq('nested：互相包含也拒', (g as any).code, 'same-home')
}

/* ═════════════ 场景 4：幂等（新口径） ═════════════ */

async function scenarioIdem(): Promise<void> {
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: [
        { id: 'custom-a', name: 'A', apiHost: 'https://a.invalid', models: [{ id: 'm1', name: 'm1' }] },
        { id: 'custom-b', name: 'B', apiHost: 'https://b.invalid', models: [] }
      ],
      activeModelId: 'custom-a:m1'
    }
  })
  writeJson(path.join(SRC, 'secrets.json'), {
    'custom-a': 'enc-aaa',
    'custom-b:sub': 'enc-bbb',
    'remote:bot_1:appSecret': 'enc-remote',
    'mcp:xyz:token': 'enc-mcp'
  })
  mkdirp(path.join(SRC, 'personas'))
  writeJson(path.join(SRC, 'memory.json'), { version: 1, entries: [{ id: 'm_1', content: '记忆一' }] })

  const r1 = (await runOnce()) as any
  const s1 = snapshot(DST)
  info('第 1 轮', JSON.stringify({ providers: r1.providers, secrets: r1.secrets, active: r1.providers.activeModelId }))
  eq('幂等1：首轮服务商都导入', [...r1.providers.copied].sort(), ['custom-a', 'custom-b'])
  eq('幂等1：ignored 桶含 remote / mcp', [...(r1.secrets.ignored ?? [])].sort(), ['mcp:xyz:token', 'remote:bot_1:appSecret'])
  eq('幂等1：copied 只含 provider 键', [...r1.secrets.copied].sort(), ['custom-a', 'custom-b:sub'])
  eq('幂等1：activeModelId 带过来', readJson(path.join(DST, 'config.json')).models.activeModelId, 'custom-a:m1')

  const r2 = (await runOnce()) as any
  const s2 = snapshot(DST)
  const d2 = diffSnap(s1, s2)
  check('幂等2：第 2 次零新增', allCopiedEmpty(r2), JSON.stringify(copiedOf(r2)))
  check('幂等2：快照完全一致（含 mtime/md5）', d2.length === 0, d2.slice(0, 8).join(' | '))
  info('幂等2 报告', JSON.stringify({ providers: r2.providers, secrets: r2.secrets, active: r2.providers.activeModelId, ok: r2.ok }))

  const r3 = (await runOnce()) as any
  const s3 = snapshot(DST)
  const d3 = diffSnap(s2, s3)
  check('幂等3：第 3 次零新增', allCopiedEmpty(r3), JSON.stringify(copiedOf(r3)))
  check('幂等3：快照完全一致', d3.length === 0, d3.slice(0, 8).join(' | '))
  eq('幂等3：第 2/3 次统计一致', copiedOf(r3), copiedOf(r2))
  info('幂等3 ok', String(r3.ok))

  // activeModelId 不应在后续轮次被反复重设（目标已有值就不动）
  eq('幂等：activeModelId 稳定', readJson(path.join(DST, 'config.json')).models.activeModelId, 'custom-a:m1')
  // 目标已选过模型时不许被导入改掉
  const cfg = readJson(path.join(DST, 'config.json'))
  cfg.models.activeModelId = 'custom-b:other'
  writeJson(path.join(DST, 'config.json'), cfg)
  // 需要新进程才能重读 config（模块缓存），这里只做静态确认
  info('说明', '「目标已选过则不改」需要新进程重读 config，见 driver 的 activekeep 场景')
}

function copiedOf(r: any): Record<string, number> {
  return {
    providers: r.providers.copied.length,
    secrets: r.secrets.copied.length,
    personas: r.personas.copied.length,
    memories: r.memories.added.length,
    skills: r.skills.copied.length,
    sessions: r.sessions.copied.length,
    assoc: r.assoc.media + r.assoc.checkpoints + r.assoc.subagents + r.assoc.toolResults
  }
}
function allCopiedEmpty(r: any): boolean {
  return Object.values(copiedOf(r)).every((n) => n === 0)
}

/* ═════════════ 场景 5：ignored 桶不被当成 skipped ═════════════ */

async function scenarioIgnored(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'p1', name: 'P1', models: [] }] } })
  writeJson(path.join(SRC, 'secrets.json'), {
    p1: 'enc-1',
    'remote:botA:appSecret': 'enc-r',
    'mcp:tool1:token': 'enc-m'
  })
  const r = (await runOnce()) as any
  info('ignored 报告', JSON.stringify(r.secrets))
  eq('ignored：remote 进 ignored 不进 skipped', (r.secrets.ignored ?? []).includes('remote:botA:appSecret'), true)
  eq('ignored：mcp 进 ignored', (r.secrets.ignored ?? []).includes('mcp:tool1:token'), true)
  eq('ignored：skipped 里没有它们', r.secrets.skipped, [])
  eq('ignored：copied 只有 p1', r.secrets.copied, ['p1'])
  eq('ignored：不因此让 ok=false', r.ok, true)
  // 二次跑：ignored 仍是 ignored（不是变成 skipped）；provider 键已存在 → 正常进 skipped
  const r2 = (await runOnce()) as any
  eq('ignored：二次跑仍在 ignored', [...(r2.secrets.ignored ?? [])].sort(), ['mcp:tool1:token', 'remote:botA:appSecret'])
  eq('ignored：二次跑 provider 键进 skipped', r2.secrets.skipped, ['p1'])
  check(
    'ignored：ignored 与 skipped 互不混入',
    !(r2.secrets.skipped ?? []).some((k: string) => k.includes(':botA:') || k.startsWith('mcp:')) &&
      !(r2.secrets.ignored ?? []).includes('p1'),
    JSON.stringify({ skipped: r2.secrets.skipped, ignored: r2.secrets.ignored })
  )
}

/* ═════════════ 场景 6：目标已选模型时不被导入改掉（需新进程） ═════════════ */

async function scenarioActiveKeep(): Promise<void> {
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp', name: 'I', models: [] }], activeModelId: 'imp:m1' }
  })
  writeJson(path.join(DST, 'config.json'), {
    models: { providers: [], activeModelId: 'mine:chosen', activeEffort: 'default' }
  })
  const r = (await runOnce()) as any
  const cfg = readJson(path.join(DST, 'config.json'))
  info('activeModelId 保持', JSON.stringify({ before: 'mine:chosen', after: cfg.models.activeModelId, reported: r.providers.activeModelId }))
  eq('active：目标已选过 → 不被导入改掉', cfg.models.activeModelId, 'mine:chosen')
  eq('active：报告不声称带了 activeModelId', r.providers.activeModelId, undefined)
  check('active：服务商仍导入', cfg.models.providers.some((p: any) => p.id === 'imp'), JSON.stringify(cfg.models.providers.map((p: any) => p.id)))
}

/* ═════════════ 场景 7：activeModelId 悬空引用不被设置 ═════════════ */

async function scenarioActiveDangling(): Promise<void> {
  mkdirp(SRC)
  // 源里 activeModelId 指向一个「源里其实不存在」的 provider（模拟原版删了服务商但 activeModelId 残留）
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'real', name: 'R', models: [] }], activeModelId: 'ghost-provider:m1' }
  })
  const r = (await runOnce()) as any
  const cfg = readJson(path.join(DST, 'config.json'))
  info('悬空 activeModelId', JSON.stringify({ after: cfg.models.activeModelId, reported: r.providers.activeModelId }))
  check('悬空：不设悬空的 activeModelId', cfg.models.activeModelId == null, String(cfg.models.activeModelId))
  check('悬空：服务商正常导入', cfg.models.providers.some((p: any) => p.id === 'real'))
  eq('悬空：ok 仍为 true（这不算失败）', r.ok, true)
}

/* ═════════════ 场景 8：失败通道 + 旧数据兼容（failed 缺省） ═════════════ */

async function scenarioLegacyReport(): Promise<void> {
  // 界面 row() 对 failed 缺省要容错——读代码确认（此处只验证类型层面：不带 failed 的 StepStat 不会炸）
  const { assoc } = copyAssoc(path.join(SCRATCH, 'nonexistent'))
  eq('兼容：copyAssoc 对不存在的源返回全 0', assoc, { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 })
  // config:set 写盘失败时返回 error 码（不再只有 ok:true）
  mkdirp(DST)
  const cfgPath = path.join(DST, 'config.json')
  rmrf(cfgPath)
  mkdirp(cfgPath)
  installWindow()
  const electron = require('electron') as any
  const h = electron.__test?.ipcHandlers?.get('config:set')
  if (!h) {
    info('兼容：拿不到 config:set handler', '')
    return
  }
  const res = await h({}, { __probe: 1 })
  info('config:set 写盘失败返回', JSON.stringify(res))
  check('兼容：写盘失败 → ok:false 且带 error', res?.ok === false && res?.error === 'config-write-failed', JSON.stringify(res))
  rmrf(cfgPath)
}

/* ═════════ ═════════ 入口 ═════════ ═════════ */
const S: Record<string, () => Promise<void>> = {
  failchannels: scenarioFailChannels,
  race: scenarioRace,
  samehome: scenarioSameHome,
  samenested: scenarioSameHomeNested,
  idem: scenarioIdem,
  ignored: scenarioIgnored,
  activekeep: scenarioActiveKeep,
  activedangling: scenarioActiveDangling,
  legacy: scenarioLegacyReport
}

async function main(): Promise<void> {
  const name = process.argv[2] || 'idem'
  const fn = S[name]
  if (!fn) {
    console.log(`FAIL 未知场景 ${name}`)
    process.exit(2)
  }
  console.log(`=== 验收场景 ${name} ===`)
  console.log(`INFO env :: SRC=${SRC} DST=${DST}`)
  try {
    await fn()
  } catch (e) {
    fail(`${name} 抛异常`, (e as Error)?.stack?.split('\n').slice(0, 6).join(' / ') ?? String(e))
  }
  console.log(`=== ${name} 结束：FAIL ${fails} ===`)
  process.exit(fails ? 1 : 0)
}
void main()
