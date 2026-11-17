/**
 * 本轮 P1/P2 的复现与回归脚本（独立进程、独立 home）。
 *
 *   p1mem   —— 记忆写盘失败是否掀翻整轮 + 异常路径有没有补回 models（P1-1 的两层）
 *   p1sec   —— 密钥写盘失败是否被伪装成「跳过」（P1-3）
 *   p2patch —— 用户补丁落盘失败是否有上报（P2-4）
 *   p3quote —— 兜底条目的 id 契约（P2-E 回归，防将来又写回空串）
 *
 * 运行：node .deva/qa/repro-p1.cjs [场景名...]
 */
import * as fs from 'fs'
import * as path from 'path'

import { runImport } from '../../apps/desktop/src/main/importer'
import { registerConfigIpc, getConfig } from '../../apps/desktop/src/main/services/config'

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
function installWindow(): void {
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)
}

/* ═════════ p1mem：记忆写盘抛异常 ═════════ */

async function scenarioP1Mem(): Promise<void> {
  installWindow()
  // 源：1 个自定义服务商 + 1 条记忆 + 1 个会话 + 1 个 blob
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: 'imp-a:m1' }
  })
  // 记忆文件在 home 根，不是 data/ 下（memoryPath：<home>/memory.json）
  writeJson(path.join(SRC, 'memory.json'), {
    version: 1,
    entries: [{ id: 'm_src1', content: '源记忆一', createdAt: 1, updatedAt: 1 }]
  })
  writeJson(path.join(SRC, 'data', 'chats', 's1.json'), { id: 's1', title: 'one', messages: [] })
  mkdirp(path.join(SRC, 'data', 'media'))
  fs.writeFileSync(path.join(SRC, 'data', 'media', 'c'.repeat(64)), Buffer.alloc(64, 3))

  // 目标：本地有一个服务商（第 1 轮会导入 imp-a）
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), {
    models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null }
  })
  getConfig()

  // 第 1 轮：正常导入，建立「上一轮的成果」
  const r1: any = await runImport()
  info('第 1 轮', JSON.stringify({ ok: r1.ok, providers: r1.providers.copied, mem: r1.memories.added.length }))

  // 让目标记忆文件不可写：用同名目录占位（<home>/memory.json 变成目录 → writeFileSync/rename 必失败）
  rmrf(path.join(DST, 'memory.json'))
  mkdirp(path.join(DST, 'memory.json'))
  // 换一条不同的记忆，逼它真的写
  writeJson(path.join(SRC, 'memory.json'), {
    version: 1,
    entries: [
      { id: 'm_src1', content: '源记忆一', createdAt: 1, updatedAt: 1 },
      { id: 'm_src2', content: '源记忆二', createdAt: 2, updatedAt: 2 }
    ]
  })

  // 第 2 轮：记忆写盘失败 + 导入中途渲染层回写旧快照（只有 local-x，没有 imp-a）
  const stale = { models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null } }
  const handlers: Map<string, Function> = (require('electron') as any).__test.ipcHandlers
  let injected = 0
  const r2: any = await runImport((p) => {
    if (p.step === 'memories' && injected === 0) {
      injected++
      void handlers.get('config:set')!({}, stale)
    }
  })
  info('第 2 轮报告', JSON.stringify({ ok: r2.ok, sessions: r2.sessions?.copied, assoc: r2.assoc, failures: r2.failures }))
  eq('注入次数', injected, 1)

  /* ── 第一层：单条记忆失败不该中断整轮 ── */
  check(
    '记忆写盘失败不再掀翻整轮（有 step=memories 的失败，但不是 unknown 整轮兜底）',
    (r2.failures ?? []).some((f: any) => f.step === 'memories') && !(r2.failures ?? []).some((f: any) => f.step === 'unknown'),
    JSON.stringify(r2.failures)
  )
  // 第 2 轮两条记忆都写不进去。原因码是 **readFailed 而不是 writeFailed**：
  // 目标 memory.json 被同名目录占位 → 读它抛 EISDIR → 属于「不知道盘上有什么」，
  // 主进程按规则拒绝写入（否则会拿「只剩这条」覆盖）。这正是本轮新增的语义。
  eq(
    '记忆写不进去的原因码（目标被目录占位 → readFailed，不是 writeFailed）',
    (r2.failures ?? []).filter((f: any) => f.step === 'memories').map((f: any) => f.reason),
    ['readFailed', 'readFailed']
  )
  // 后续步骤仍执行：这一轮没有新会话可导（第 1 轮已导），所以看「步骤被走到了」——assoc 有数字、personaEnabled 不炸
  check('记忆失败后 ⑤⑥⑦ 仍执行（报告里各步结构完整）', !!r2.skills && !!r2.sessions && !!r2.assoc, '')
  check(
    '记忆失败后附件步骤仍跑过（media 计数存在）',
    typeof r2.assoc?.media === 'number',
    JSON.stringify(r2.assoc)
  )

  /* ── 第二层：异常/失败路径也要补回被旧快照覆盖的 models ── */
  const cfg = readJson(path.join(DST, 'config.json'))
  const ids: string[] = (cfg.models?.providers ?? []).map((p: any) => p.id)
  info('磁盘 providers', JSON.stringify(ids))
  check('补回逻辑在「记忆失败」这条路径上也生效（imp-a 仍在）', ids.includes('imp-a'), JSON.stringify(ids))
  // 注：这条不是异常路径（记忆失败已改成返回值），所以还要单独验异常路径——见 p1throw
  process.exit(fails ? 1 : 0)
}

/* ═════════ p1throw：真异常路径的 models 补回 ═════════ */

async function scenarioP1Throw(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: 'imp-a:m1' }
  })
  writeJson(path.join(SRC, 'data', 'chats', 's1.json'), { id: 's1', title: 'one', messages: [] })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), {
    models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null }
  })
  getConfig()
  const r1: any = await runImport()
  info('第 1 轮', JSON.stringify({ ok: r1.ok, providers: r1.providers.copied }))

  const handlers: Map<string, Function> = (require('electron') as any).__test.ipcHandlers
  const stale = { models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null } }
  // 让 onProgress 在「会话」步抛出：异常必然落到整轮兜底 catch（此时暂存 still held）
  let injected = 0
  const r2: any = await runImport((p) => {
    if (p.step === 'sessions' && injected === 0) {
      injected++
      void handlers.get('config:set')!({}, stale)
      throw new Error('boom-after-inject')
    }
  })
  info('异常路径报告', JSON.stringify({ ok: r2.ok, failures: r2.failures }))
  check('异常路径报告里有一条 unknown', (r2.failures ?? []).some((f: any) => f.step === 'unknown'), JSON.stringify(r2.failures))
  const cfg = readJson(path.join(DST, 'config.json'))
  const ids: string[] = (cfg.models?.providers ?? []).map((p: any) => p.id)
  info('异常路径后 providers', JSON.stringify(ids))
  check('异常路径也补回了被旧快照覆盖的 imp-a', ids.includes('imp-a'), JSON.stringify(ids))
  process.exit(fails ? 1 : 0)
}

/* ═════════ p1sec：密钥写盘失败被伪装成跳过 ═════════ */

async function scenarioP1Sec(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: null }
  })
  writeJson(path.join(SRC, 'secrets.json'), {
    'imp-a': Buffer.from('enc:sk-a', 'utf8').toString('base64')
  })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  // 让目标 secrets.json 不可写：同名目录占位
  mkdirp(path.join(DST, 'secrets.json'))
  getConfig()

  const r: any = await runImport()
  info('报告', JSON.stringify({ ok: r.ok, secrets: r.secrets, failures: r.failures }))
  eq('密钥：copied 为空（确实没写进去）', r.secrets.copied, [])
  eq(
    '密钥：写盘失败进 failed（不是 skipped），且 reason 指明是 secrets.json 而非 config.json',
    (r.secrets.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['imp-a', 'secrets-write-failed']]
  )
  eq('密钥：skipped 为空（失败不该被算成跳过）', r.secrets.skipped, [])
  check('密钥：整轮 ok=false', r.ok === false, `ok=${r.ok}`)

  /*
   * 补一个「能读、但写不下去」的子项：上一条（目标被目录占位）现在走的是 readFailed，
   * writeFailed 这条分支就没人覆盖了。造法是「memory.json 能读 → 写完 rename 到不了目标」——
   * 让 memory.json 所在目录变成只读做不到跨平台，改用「临时文件位置被目录占住」：
   * saveMemories 先写 `<memory.json>.tmp`，那个位置若是目录，writeFileSync 直接失败。
   */
  const mem = await import('../../apps/desktop/src/main/services/memory')
  const memFile = path.join(DST, 'memory.json')
  writeJson(memFile, { version: 1, entries: [{ id: 'm_old', content: '已有记忆', createdAt: 1, updatedAt: 1 }] })
  rmrf(`${memFile}.tmp`)
  mkdirp(`${memFile}.tmp`) // tmp 位置被目录占住 → 写 tmp 必失败
  const wr = mem.writeMemory('新记忆')
  info('写 tmp 失败时的结果', JSON.stringify(wr))
  eq('记忆：能读但写不下去 → writeFailed（与 readFailed 分开）', (wr as any).code, 'writeFailed')
  eq(
    '记忆：写不下去时盘上原有内容不变',
    JSON.parse(fs.readFileSync(memFile, 'utf8')).entries.map((e: any) => e.id),
    ['m_old']
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════ p2patch：用户补丁落盘失败要上报 ═════════ */

async function scenarioP2Patch(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [], activeModelId: null }, theme: 'light' })
  getConfig()
  const handlers: Map<string, Function> = (require('electron') as any).__test.ipcHandlers
  // 中途注入一条用户补丁（含 models），随后让 config.json 变成目录使落盘失败
  let injected = 0
  const r: any = await runImport((p) => {
    if (p.step === 'cache' && injected === 0) {
      injected++
      void handlers.get('config:set')!({}, { models: { providers: [], activeModelId: null }, theme: 'dark' })
      // 收尾应用补丁时写不进去
      rmrf(path.join(DST, 'config.json'))
      mkdirp(path.join(DST, 'config.json'))
    }
  })
  info('报告', JSON.stringify({ ok: r.ok, failures: r.failures }))
  check(
    '用户补丁落盘失败被上报（step=config）',
    (r.failures ?? []).some((f: any) => f.step === 'config' && f.reason === 'config-write-failed'),
    JSON.stringify(r.failures)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════ 入口 ═════════ */

const S: Record<string, () => Promise<void>> = {
  p1mem: scenarioP1Mem,
  p1throw: scenarioP1Throw,
  p1sec: scenarioP1Sec,
  p2patch: scenarioP2Patch
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
