/**
 * 本轮验收 P0/P1/P2 的复现脚本。
 *
 *   p0turn   —— 导入收尾（invalidateIndex）之后，正在跑的对话还能不能落盘（P0-1，确定性数据丢失）
 *   p0ckpt   —— 源数据放 30 天以上再导入，checkpoint 会不会被启动清扫删空（P0-2）
 *   skipsess —— 会话目标位置被同名文件占住时，是 skipped 还是 failed
 *   skipsec  —— 加密不可用的机器上，密钥落进哪一栏（skipped 是否被拆开）
 *   unread    —— P1-2：目标会话「读不出来」（被独占占用）时不能覆盖，要记 failed/unreadable
 *   stalem    —— P2-6：复制成功但 mtime 没刷上 → 下次导入要能自动补刷（否则永远被清扫删掉）
 *   writefail —— P1-1/P2-10：补回的那次 mergeProviders 写盘失败必须进 failures
 *   reason2   —— P2-11/P2-12：密钥写盘失败的 reason 码、附件占位符 id 不被拼前缀
 *
 *   assocblk —— 三处裸 existsSync：目标被同名目录/文件占位 → 报 target-blocked，不静默跳过
 *   assocprt —— 三处裸 existsSync：目标是半截副本 → 备份后重写，不永久跳过
 *   compbad  —— copyCompacted 的两个异常目标各自报对原因
 *   memread  —— 记忆文件读不出来时，写入必须拒绝（否则一次瞬时占用抹掉用户全部记忆）
 *
 * 运行：node .deva/qa/repro-accept.cjs [场景名...]
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn, execFileSync } from 'child_process'

import { runImport } from '../../apps/desktop/src/main/importer'
import { registerConfigIpc } from '../../apps/desktop/src/main/services/config'
import { ensureSession, save, getSession, listSessions, invalidateIndex } from '../../apps/desktop/src/main/services/chat-store'
import { sweepCheckpoints } from '../../apps/desktop/src/main/services/checkpoints'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'

const HOME = process.env.TEST_HOME as string
const DST = process.env.DEVA_HOME as string
const SCRATCH = process.env.QA_SCRATCH as string
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
function installWindow(): void {
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)
}

/* ═════════ p0turn：收尾后正在跑的对话还能不能落盘 ═════════ */

async function scenarioP0Turn(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'data', 'chats', 'src-1.json'), {
    id: 'src-1',
    title: 'from upstream',
    messages: [],
    updatedAt: Date.now()
  })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // 模拟「导入期间用户正在跑一轮对话」：拿到 ensureSession 的**对象引用**（与 chat-turns.ts:341 同款），
  // 中途不重新取——这正是丢数据的前提。
  const s = ensureSession('live-1')
  s.messages.push({ role: 'user', content: 'A：导入收尾之前' } as any)
  save('live-1')
  const beforeLines = JSON.parse(fs.readFileSync(path.join(DST, 'data', 'chats', 'live-1.json'), 'utf8'))
  check('收尾前落盘正常（对照）', beforeLines.messages.length === 1, `messages=${beforeLines.messages.length}`)

  // 导入跑一轮（收尾会调 invalidateIndex）
  const r: any = await runImport()
  info('导入报告', JSON.stringify({ ok: r.ok, sessions: r.sessions.copied }))

  // 收尾之后，那一轮对话继续推消息并落盘（chat-turns 的 onStep / finally 都是这个形态）
  s.messages.push({ role: 'assistant', content: 'B：导入收尾之后' } as any)
  save('live-1')

  // 直接从磁盘读，确认到底写进去没有
  let onDisk: any = null
  try {
    onDisk = JSON.parse(fs.readFileSync(path.join(DST, 'data', 'chats', 'live-1.json'), 'utf8'))
  } catch (e) {
    onDisk = { error: (e as Error).message }
  }
  info('磁盘上的 live-1', JSON.stringify(onDisk).slice(0, 300))
  const contents: string[] = (onDisk.messages ?? []).map((m: any) => m.content)
  check(
    'P0-1：收尾之后推入的消息写进盘了',
    contents.some((c) => typeof c === 'string' && c.includes('B：导入收尾之后')),
    JSON.stringify(contents)
  )
  eq('P0-1：A、B 两条都在盘上', contents, ['A：导入收尾之前', 'B：导入收尾之后'])

  // 再触发一次重载（模拟下次打开），累计丢没丢
  invalidateIndex()
  const reloaded = getSession('live-1')
  const afterReload: string[] = (reloaded?.messages ?? []).map((m: any) => m.content)
  info('重载后', JSON.stringify(afterReload))
  eq('P0-1：重载后一条都不丢', afterReload, ['A：导入收尾之前', 'B：导入收尾之后'])
  process.exit(fails ? 1 : 0)
}

/* ═════════ p0ckpt：30 天以上的 checkpoint ═════════ */

async function scenarioP0Ckpt(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  // 会话 s-old，带一个 checkpoints 记录引用 blob
  writeJson(path.join(SRC, 'data', 'chats', 's-old.json'), { id: 's-old', title: 'x', messages: [], updatedAt: Date.now() })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // 源 checkpoint 目录：3 个 blob，源 mtime 设成 60 天前（超过 30 天保留期）
  const srcCk = path.join(SRC, 'data', 'checkpoints', 's-old')
  mkdirp(srcCk)
  const old = Date.now() / 1000 - 60 * 24 * 3600
  for (const name of ['aaaa', 'bbbb', 'cccc']) {
    const f = path.join(srcCk, name)
    fs.writeFileSync(f, `content-${name}`)
    fs.utimesSync(f, old, old)
  }
  info('源 mtime', new Date(old * 1000).toISOString())

  const r: any = await runImport()
  info('导入报告', JSON.stringify({ ok: r.ok, assoc: r.assoc }))

  const dstCk = path.join(DST, 'data', 'checkpoints', 's-old')
  const names = (() => {
    try {
      return fs.readdirSync(dstCk)
    } catch {
      return []
    }
  })()
  info('导入后目标 checkpoint', JSON.stringify(names))
  eq('P0-2：三个 blob 都复制过来了', names.sort(), ['aaaa', 'bbbb', 'cccc'])

  // 模拟下一次启动：跑清扫（liveIds 含 s-old）
  await sweepCheckpoints(['s-old'])
  const left = (() => {
    try {
      return fs.readdirSync(dstCk)
    } catch {
      return []
    }
  })()
  info('清扫后目标 checkpoint', JSON.stringify(left))
  eq('P0-2：启动清扫没把刚导入的 checkpoint 删空', left.sort(), ['aaaa', 'bbbb', 'cccc'])
  process.exit(fails ? 1 : 0)
}

/* ═════════ skipsess：会话目标被同名文件占位 ═════════ */

async function scenarioSkipSess(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'data', 'chats', 'sess_a.json'), { id: 'sess_a', title: 'a', messages: [], updatedAt: 1 })
  writeJson(path.join(SRC, 'data', 'chats', 'sess_b.json'), { id: 'sess_b', title: 'b', messages: [], updatedAt: 2 })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  // sess_a 的目标位置是个**目录**（占位），sess_b 正常
  mkdirp(path.join(DST, 'data', 'chats', 'sess_a.json'))

  const r: any = await runImport()
  info('报告', JSON.stringify({ ok: r.ok, sessions: r.sessions, failures: r.failures }))
  eq('会话：占了位置的那个记 failed（不是 skipped）', (r.sessions.failed ?? []).map((f: any) => f.id), ['sess_a'])
  eq('会话：正常的那个照常导入', r.sessions.copied, ['sess_b'])
  eq('会话：skipped 里不该有 sess_a', (r.sessions.skipped ?? []).filter((id: string) => id === 'sess_a'), [])
  check('会话：整轮 ok=false', r.ok === false, `ok=${r.ok}`)
  process.exit(fails ? 1 : 0)
}

/* ═════════ skipsec：加密不可用时的密钥分类 ═════════ */

async function scenarioSkipSec(): Promise<void> {
  // 桩里 isEncryptionAvailable 由 TEST_NO_ENCRYPTION 控制
  process.env.TEST_NO_ENCRYPTION = '1'
  installWindow()
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: null }
  })
  writeJson(path.join(SRC, 'secrets.json'), {
    'imp-a': Buffer.from('enc:sk-a', 'utf8').toString('base64')
  })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  const r: any = await runImport()
  info('报告 secrets', JSON.stringify(r.secrets))
  info('报告 ok/failures', JSON.stringify({ ok: r.ok, failures: r.failures }))
  eq('密钥：加密不可用 → copied 为空', r.secrets.copied, [])
  eq('密钥：加密不可用的 key 单独成栏（不是 skipped）', r.secrets.noEncryption ?? r.secrets.skippedNoEncryption ?? null, ['imp-a'])
  eq('密钥：skipped（已存在/非法）里没有它', r.secrets.skipped ?? [], [])
  eq(
    '密钥：加密不可用也记一条 failed（一个都没存进去不能报「导入完成」）',
    (r.secrets.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['imp-a', 'no-encryption']]
  )
  check('密钥：此时整轮 ok=false', r.ok === false, `ok=${r.ok}`)
  process.exit(fails ? 1 : 0)
}

/* ═════════════ unread：P1-2 目标会话读不出来时不覆盖 ═════════════ */

/**
 * 造一个「读得到但打不开」的目标文件：Windows 上用 PowerShell 以 FILE_SHARE_NONE 独占打开，
 * 这时 Node 的 readFileSync 会抛 EPERM/EBUSY。拿不到独占（非 Windows 或无 powershell）时返回 null，
 * 调用方退化成「只验 broken 分支不被误判成 unreadable」。
 */
async function holdExclusive(target: string): Promise<{ stop: () => void } | null> {
  if (process.platform !== 'win32') return null
  const ps1 = path.join(SCRATCH, `hold-${Date.now()}.ps1`)
  const ready = `${ps1}.ready`
  const body = [
    `$p = '${target.replace(/'/g, "''")}'`,
    `$f = [System.IO.File]::Open($p, 'Open', 'ReadWrite', 'None')`,
    `New-Item -ItemType File -Path '${ready.replace(/'/g, "''")}' -Force | Out-Null`,
    `Start-Sleep -Seconds 120`
  ].join('\n')
  fs.writeFileSync(ps1, body, 'utf8')
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    stdio: 'ignore'
  })
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100))
  // 确认真的锁住了：独立读句柄应该被共享冲突拒掉
  let held = false
  try {
    fs.readFileSync(target)
  } catch {
    held = true
  }
  if (!held) {
    try {
      execFileSync('taskkill', ['/PID', String(ps.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 已退出 */
    }
    rmrf(ps1)
    rmrf(ready)
    return null
  }
  const stop = (): void => {
    try {
      execFileSync('taskkill', ['/PID', String(ps.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 已退出 */
    }
    rmrf(ps1)
    rmrf(ready)
  }
  return { stop }
}

async function scenarioUnreadable(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  const srcChats = path.join(SRC, 'data', 'chats')
  const dstChats = path.join(DST, 'data', 'chats')
  mkdirp(srcChats)
  mkdirp(dstChats)
  // 源里这份是「要搬进去的新内容」
  writeJson(path.join(srcChats, 'sess_u.json'), { id: 'sess_u', title: 'from upstream', messages: [], updatedAt: 2 })
  // 目标里已有一份**完全正常**的会话（用户自己的），只是此刻被独占占用
  const dstFile = path.join(dstChats, 'sess_u.json')
  const localBody = JSON.stringify({ id: 'sess_u', title: 'local precious', messages: [{ role: 'user', content: 'keep me' }] })
  fs.writeFileSync(dstFile, localBody)

  const hold = await holdExclusive(dstFile)
  if (!hold) {
    info('无法在非 Windows 上造独占占用，跳过读失败分支（只验判定函数没把它当 broken）')
  }
  try {
    const stat = importSessions(SRC)
    info('importSessions 结果', JSON.stringify(stat))
    if (hold) {
      eq('P1-2：读失败 → 进 failed 且 reason=target-unreadable', (stat.failed ?? []).map((f: any) => [f.id, f.reason]), [
        ['sess_u', 'target-unreadable']
      ])
      eq('P1-2：读失败不算 copied', stat.copied, [])
      eq('P1-2：读失败不算 skipped', (stat.skipped ?? []).filter((id: string) => id === 'sess_u'), [])
    }
  } finally {
    hold?.stop()
  }

  // 关键断言：解锁后目标内容必须还是原来那份（没有被源顶掉、也没有被截断）
  const after = fs.readFileSync(dstFile, 'utf8')
  eq('P1-2：目标文件内容原封不动（没被覆盖）', after, localBody)

  // 对照组：内容确实是坏的（半截 JSON）→ 仍要覆盖，不能被 unreadable 误伤
  fs.writeFileSync(dstFile, '{"id":"sess_u","title":"half')
  const stat2 = importSessions(SRC)
  eq('P1-2：内容坏（半截 JSON）→ 仍然覆盖导入', stat2.copied, ['sess_u'])
  const fixed = JSON.parse(fs.readFileSync(dstFile, 'utf8'))
  eq('P1-2：覆盖后内容是源那份', fixed.title, 'from upstream')
  // 规则「覆盖前若旧内容解析失败，先备份到旁边」：坏文件不许直接抹掉
  const badBaks = fs.readdirSync(dstChats).filter((n) => n.includes('.bad-'))
  eq('P1-2：覆盖坏文件前先备份了一份', badBaks.length, 1)
  eq('P1-2：备份里是原来那半截内容', fs.readFileSync(path.join(dstChats, badBaks[0]), 'utf8'), '{"id":"sess_u","title":"half')
  // 备份名不能以 .json 结尾，否则索引重建会把它当成一个会话读进来
  check('P1-2：备份不以 .json 结尾（不污染会话索引）', !badBaks[0].endsWith('.json'), badBaks[0])
  process.exit(fails ? 1 : 0)
}

/* ═════════════ stalem：P2-6 mtime 自锁能被重导修好 ═════════════ */

async function scenarioStaleMtime(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // 源 checkpoint：内容 + mtime 都设成 60 天前
  const srcCk = path.join(SRC, 'data', 'checkpoints', 's-old')
  mkdirp(srcCk)
  const oldSec = Date.now() / 1000 - 60 * 24 * 3600
  const names = ['aaaa', 'bbbb']
  for (const n of names) {
    const f = path.join(srcCk, n)
    fs.writeFileSync(f, `content-${n}`)
    fs.utimesSync(f, oldSec, oldSec)
  }

  // 模拟「上一轮复制成功、但 utimesSync 失败了」：目标文件在，mtime 仍是源的旧值
  const dstCk = path.join(DST, 'data', 'checkpoints', 's-old')
  mkdirp(dstCk)
  for (const n of names) {
    const f = path.join(dstCk, n)
    fs.writeFileSync(f, `content-${n}`)
    fs.utimesSync(f, oldSec, oldSec)
  }
  const before = fs.statSync(path.join(dstCk, 'aaaa')).mtimeMs
  check('P2-6：构造出的目标 mtime 确实是 60 天前', Date.now() - before > 50 * 24 * 3600 * 1000, `${new Date(before).toISOString()}`)

  // 再导入一次：已存在的文件不该重写内容，但过期 mtime 要补刷
  const r: any = await runImport()
  info('重导报告', JSON.stringify({ ok: r.ok, assoc: r.assoc }))
  eq('P2-6：重导不重写内容（仍然是幂等，assoc 计数 0）', r.assoc.checkpoints, 0)
  const after = fs.statSync(path.join(dstCk, 'aaaa')).mtimeMs
  check('P2-6：重导把过期 mtime 补刷成现在（不再被清扫删）', Date.now() - after < 60 * 1000, `${new Date(after).toISOString()}`)

  // 清扫验证：补刷后不该被删
  await sweepCheckpoints(['s-old'])
  const left = fs.readdirSync(dstCk).sort()
  eq('P2-6：清扫后 checkpoint 还在', left, names)

  // 新鲜的目标文件不该被重刷（保持幂等）
  const freshDst = path.join(DST, 'data', 'checkpoints', 's-fresh')
  mkdirp(freshDst)
  const srcFresh = path.join(SRC, 'data', 'checkpoints', 's-fresh')
  mkdirp(srcFresh)
  fs.writeFileSync(path.join(srcFresh, 'cccc'), 'x')
  fs.utimesSync(path.join(srcFresh, 'cccc'), oldSec, oldSec)
  fs.writeFileSync(path.join(freshDst, 'cccc'), 'x')
  const freshBefore = fs.statSync(path.join(freshDst, 'cccc')).mtimeMs
  await new Promise((r2) => setTimeout(r2, 30))
  await runImport()
  const freshAfter = fs.statSync(path.join(freshDst, 'cccc')).mtimeMs
  check('P2-6：目标已新鲜时不重刷（幂等性保留）', freshBefore === freshAfter, `${freshBefore} → ${freshAfter}`)

  // media 的临时残留（`<hash>.tmp`，没有横杠）不能被当成 blob 复制过去
  const srcMedia = path.join(SRC, 'data', 'media')
  mkdirp(srcMedia)
  const realBlob = 'a'.repeat(64)
  fs.writeFileSync(path.join(srcMedia, realBlob), 'blob')
  fs.writeFileSync(path.join(srcMedia, `${realBlob}.tmp`), 'half-written')
  const c = copyAssoc(SRC)
  info('media 复制结果', JSON.stringify({ media: c.assoc.media, failures: c.failures.length }))
  eq('P2-6：media 只算真 blob（`.tmp` 残留不计入）', c.assoc.media, 1)
  check(
    'P2-6：`.tmp` 残留没被复制到目标',
    !fs.existsSync(path.join(DST, 'data', 'media', `${realBlob}.tmp`)),
    JSON.stringify(fs.readdirSync(path.join(DST, 'data', 'media')))
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════════ writefail：P1-1 补回阶段写盘失败要上报 ═════════════ */

/**
 * 复现链（修前会漏）：
 *  ① 目标 config.json 是个同名目录 → 每一次 `setConfig` 落盘都失败；
 *  ② 第一次 `mergeProviders` 把 imp-a 并入内存并尝试写盘 → 记一条 config-write-failed；
 *  ③ 导入期间渲染层回写旧快照（`activeModelId: null`）→ 排队；
 *  ④ 收尾 applyHeldPatches 应用它 → 写盘再失败（记 user-patch#1）；
 *  ⑤ 因为它带 models，触发**补回**：源里有 activeModelId 而目标已被写成 null → 补回真的要写盘 → 再失败。
 *
 * 修前第 ⑤ 步的返回值被丢弃，报告里只有 ④ 那条；修后必须出现 ②③④⑤ 的全部丢失。本场景只断言
 * 「providers 步骤的 `<config.json>` 失败至少 2 条」——即「首次并入」与「补回」都报了。
 */
async function scenarioWriteFail(): Promise<void> {
  installWindow()
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: 'imp-a:m1' }
  })
  mkdirp(DST)
  // config.json 是目录：写盘必失败（EISDIR）
  mkdirp(path.join(DST, 'config.json'))

  const stub = require('electron') as any
  const handler = stub.__test?.ipcHandlers?.get('config:set')
  if (!handler) throw new Error('config:set handler 未注册')

  let midResult: any = null
  const r: any = await runImport(async (pr: any) => {
    // 在任意一步的进度回调里回写一次旧快照（providers 空、activeModelId 被写成 null）
    if (pr.step === 'sessions' && !midResult) {
      midResult = await handler({}, { models: { providers: [], activeModelId: null } })
    }
  })
  info('导入中途回写结果', JSON.stringify(midResult))
  info('报告', JSON.stringify({ ok: r.ok, providers: r.providers, failures: r.failures }))

  const cfgFails = (r.failures ?? []).filter(
    (f: any) => f.step === 'providers' && f.id === '<config.json>' && f.reason === 'config-write-failed'
  )
  check('P1-1：整轮 ok=false（写盘失败不能报成功）', r.ok === false, `ok=${r.ok}`)
  check(
    'P1-1：补回那次 mergeProviders 的写盘失败也进了 failures（≥2 条：首次并入 + 补回）',
    cfgFails.length >= 2,
    JSON.stringify(r.failures)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════════ reason2：P2-11 / P2-12 原因码与占位符 id ═════════════ */

async function scenarioReason(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }] }
  })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  // 目标 secrets.json 换成同名目录 → 密钥写盘必失败
  mkdirp(path.join(DST, 'secrets.json'))
  writeJson(path.join(SRC, 'secrets.json'), { 'imp-a': Buffer.from('enc:sk-a', 'utf8').toString('base64') })
  // media 目录建不出来（目标 data 是文件）→ 触发 `<dir>` 占位符
  fs.writeFileSync(path.join(DST, 'data'), 'i am a file')
  mkdirp(path.join(SRC, 'data', 'media'))
  fs.writeFileSync(path.join(SRC, 'data', 'media', 'a'.repeat(64)), 'blob')

  const r: any = await runImport()
  info('报告 failures', JSON.stringify(r.failures))
  eq(
    'P2-11：密钥写盘失败的 reason 是 secrets-write-failed（不是 config-write-failed）',
    (r.secrets?.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['imp-a', 'secrets-write-failed']]
  )
  const assocIds = (r.assoc?.failed ?? []).map((f: any) => f.id)
  info('assoc 失败 id', JSON.stringify(assocIds))
  check('P2-12：附件占位符 id 是裸 `<dir>`（界面文案表能匹配）', assocIds.includes('<dir>'), JSON.stringify(assocIds))
  check(
    'P2-12：占位符没有被拼成 `media:<dir>`',
    !assocIds.some((id: string) => id.includes(':<')),
    JSON.stringify(assocIds)
  )
  // 文件名类失败仍要带类别前缀（否则同类名冲突时看不出是哪一类附件）
  check(
    'P2-12：文件名类失败仍带类别前缀（media:<hash>）',
    assocIds.some((id: string) => id.startsWith('media:') && !id.includes('<')),
    JSON.stringify(assocIds)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 三处 existsSync 裸判断的复制品（同一次修完） ═════════════ */

/**
 * 这三个场景要证的是同一件事：**「目标有同名条目」不等于「已经搬好了」**。
 *
 *   assocblk —— copyAssoc / mergeDir 遇到「目标被同名目录占位」→ 报 target-blocked，不能静默跳过
 *   assocprt —— mergeDir / copyAssoc 遇到「目标是半截副本」→ 备份旧文件后重新复制，不能永久跳过
 *   compbad  —— copyCompacted 遇到「两个 compacted 都异常」→ 各自报对应原因，不能静默跳过
 *
 * 三者都**不需要**「文件被独占」才能复现：目录占位与半截副本都是普通权限下可稳定构造的真实故障，
 * 而「被独占」那条路径与这三处共用同一个 inspectTarget（其 unreadable 分支已由 unread 场景覆盖）。
 */
async function scenarioAssocBlocked(): Promise<void> {
  installWindow()
  const srcMedia = path.join(SRC, 'data', 'media')
  mkdirp(srcMedia)
  const good = 'a'.repeat(64)
  fs.writeFileSync(path.join(srcMedia, good), 'blob-good')
  // 目标位置被同名**目录**占住（上次崩溃残留 / 用户手建都可能是这样）
  const dstMedia = path.join(DST, 'data', 'media')
  mkdirp(path.join(dstMedia, good))

  const r = copyAssoc(SRC)
  info('copyAssoc 结果', JSON.stringify(r))
  eq('assocblk：目标被目录占位 → target-blocked（不再静默当成已存在）', r.failures.map((f: any) => f.reason), [
    'target-blocked'
  ])
  eq('assocblk：占位的那条不计入复制数', r.assoc.media, 0)

  // mergeDir 里的目录分支：checkpoints/<id> 被同名**文件**占位
  const ck = path.join('data', 'checkpoints', 's-1')
  mkdirp(path.join(SRC, ck))
  fs.writeFileSync(path.join(SRC, ck, 'hash1'), 'v1')
  mkdirp(path.join(DST, 'data', 'checkpoints'))
  fs.writeFileSync(path.join(DST, ck), 'i am a file, not a dir')

  const r2 = copyAssoc(SRC)
  info('mergeDir 结果', JSON.stringify(r2.assoc.failed ?? r2.failures))
  check(
    'assocblk：mergeDir 的目录位置被文件占住 → target-blocked',
    r2.failures.some((f: any) => f.step === 'checkpoints' && f.reason === 'target-blocked'),
    JSON.stringify(r2.failures)
  )
  process.exit(fails ? 1 : 0)
}

async function scenarioAssocPartial(): Promise<void> {
  installWindow()
  // ① media：blob 名就是内容 hash，所以「同名但尺寸不同」只能是上次写到一半的残骸
  const srcMedia = path.join(SRC, 'data', 'media')
  mkdirp(srcMedia)
  const blob = 'b'.repeat(64)
  fs.writeFileSync(path.join(srcMedia, blob), 'full-content-16b')
  const dstMedia = path.join(DST, 'data', 'media')
  mkdirp(dstMedia)
  fs.writeFileSync(path.join(dstMedia, blob), 'half') // 5 字节的半截副本

  const r = copyAssoc(SRC)
  info('media 半截副本', JSON.stringify({ media: r.assoc.media, failures: r.failures }))
  const dstBlob = path.join(dstMedia, blob)
  eq('assocprt：半截 blob 被重新复制（内容与源一致）', fs.readFileSync(dstBlob, 'utf8'), 'full-content-16b')
  eq('assocprt：重新复制的那条计入复制数', r.assoc.media, 1)
  // 旧文件要留档，不能删：坏成什么样用户可能想看一眼
  const baks = fs.readdirSync(dstMedia).filter((n) => n.includes('.bad-'))
  eq('assocprt：半截副本被备份到旁边（不是直接删）', baks.length, 1)
  eq('assocprt：备份里是原来那截内容', fs.readFileSync(path.join(dstMedia, baks[0]), 'utf8'), 'half')

  // ② mergeDir：checkpoint 半截
  const ck = path.join('data', 'checkpoints', 's-1')
  mkdirp(path.join(SRC, ck))
  fs.writeFileSync(path.join(SRC, ck, 'hash1'), 'checkpoint-full')
  const dstCk = path.join(DST, ck)
  mkdirp(dstCk)
  fs.writeFileSync(path.join(dstCk, 'hash1'), 'cp')
  const r2 = copyAssoc(SRC)
  eq('assocprt：半截 checkpoint 被重新复制', fs.readFileSync(path.join(dstCk, 'hash1'), 'utf8'), 'checkpoint-full')
  check(
    'assocprt：重写后不留失败（这一轮就修好了）',
    r2.failures.length === 0,
    JSON.stringify(r2.failures)
  )

  // ③ 尺寸一致的正常副本仍要跳过（幂等性不能因为这个修法破掉）
  const again = copyAssoc(SRC)
  eq('assocprt：尺寸一致 → 仍然跳过（幂等）', [again.assoc.media, again.assoc.checkpoints], [0, 0])
  process.exit(fails ? 1 : 0)
}

async function scenarioCompactedBad(): Promise<void> {
  installWindow()
  const srcChats = path.join(SRC, 'data', 'chats')
  const dstChats = path.join(DST, 'data', 'chats')
  mkdirp(srcChats)
  mkdirp(dstChats)
  const id = 'sess_c'
  writeJson(path.join(srcChats, `${id}.json`), { id, messages: [] })
  // 两个 compacted：一个目标被目录占位，一个是半截文件
  fs.writeFileSync(path.join(srcChats, `${id}.compacted-1.jsonl`), '{"a":1}\n{"b":2}\n')
  fs.writeFileSync(path.join(srcChats, `${id}.compacted-2.jsonl`), '{"c":3}\n{"d":4}\n')
  mkdirp(path.join(dstChats, `${id}.compacted-1.jsonl`)) // 占位
  fs.writeFileSync(path.join(dstChats, `${id}.compacted-2.jsonl`), '{"c"') // 半截

  const stat = importSessions(SRC)
  info('importSessions 结果', JSON.stringify(stat))
  eq('compbad：被目录占位的那条 → target-blocked', (stat.failed ?? []).filter((f: any) => f.id === `${id}.compacted-1.jsonl`).map((f: any) => f.reason), [
    'target-blocked'
  ])
  eq(
    'compbad：半截的那条被重新复制（不再当成已存在）',
    fs.readFileSync(path.join(dstChats, `${id}.compacted-2.jsonl`), 'utf8'),
    '{"c":3}\n{"d":4}\n'
  )
  eq('compbad：半截那条计入 compacted', stat.compacted, [`${id}.compacted-2.jsonl`])
  check(
    'compbad：半截旧文件留了备份',
    fs.readdirSync(dstChats).some((n) => n.includes('.bad-')),
    JSON.stringify(fs.readdirSync(dstChats))
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════════ memread：记忆读不出来时不许覆盖写 ═════════════ */

/**
 * 这一处比三处 existsSync 更严重，是规则第 4 条「读写失败 = 不知道」点名的典型：
 *
 * `writeMemory` 是「读全量 → 改 → 整份覆盖落盘」。`listMemories` 以前读失败返回 `[]`，
 * 于是一次瞬时故障（杀毒扫盘 EBUSY / 权限被改 / 上次写盘留下半截 JSON）就会把用户的**全部记忆**
 * 覆盖成只剩这一条。全程无异常、报告正常。
 */
async function scenarioMemRead(): Promise<void> {
  installWindow()
  const mem = await import('../../apps/desktop/src/main/services/memory')
  const file = path.join(DST, 'memory.json')
  mkdirp(DST)
  // 盘上有 3 条真实记忆
  const existing = {
    version: 1,
    entries: [
      { id: 'm_1', content: '第一条', createdAt: 1, updatedAt: 1 },
      { id: 'm_2', content: '第二条', createdAt: 2, updatedAt: 2 },
      { id: 'm_3', content: '第三条', createdAt: 3, updatedAt: 3 }
    ]
  }
  fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  eq('memread：前置——能正常读出 3 条', mem.listMemories().length, 3)

  // ① 文件内容坏（上次写盘中断留下半截 JSON）→ 写入必须拒绝，且盘上原文件不被改
  fs.writeFileSync(file, '{"version":1,"entries":[{"id":"m_1","cont')
  const broken = mem.writeMemory('新的一条')
  info('半截 JSON 时写入结果', JSON.stringify(broken))
  eq('memread：文件坏 → 拒绝写入（code=readFailed，不是静默成功）', broken.ok, false)
  eq('memread：文件坏的拒绝码是 readFailed', (broken as any).code, 'readFailed')
  eq(
    'memread：文件坏 → 盘上那半截内容原封不动（没被「只剩一条」覆盖）',
    fs.readFileSync(file, 'utf8'),
    '{"version":1,"entries":[{"id":"m_1","cont'
  )

  // ② 文件读不出来（被独占）→ 同样拒绝。用 PowerShell 独占打开，确保是真 EBUSY 而不是「不存在」
  fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  const hold = await holdExclusive(file)
  if (!hold) {
    info('无法造独占占用，跳过「读失败」子项（文件损坏那项已覆盖同一分支）')
  } else {
    try {
      const r = mem.writeMemory('又一条')
      info('被独占时写入结果', JSON.stringify(r))
      eq('memread：文件被占用 → 拒绝写入', r.ok, false)
      eq('memread：文件被占用的拒绝码是 readFailed', (r as any).code, 'readFailed')
    } finally {
      hold.stop()
    }
    eq('memread：解锁后 3 条记忆仍在', mem.listMemories().length, 3)
  }

  // ③ 文件不存在是「真的还没有」，必须能正常写（别把 absent 也拦了）
  fs.rmSync(file, { force: true })
  const fresh = mem.writeMemory('第一条记忆')
  eq('memread：文件不存在 → 正常写入（absent 不是 unreadable）', fresh.ok, true)
  eq('memread：写入后读回 1 条', mem.listMemories().length, 1)

  // ④ 删除路径同样不许在读不出来时覆盖
  fs.writeFileSync(file, 'not json at all')
  const del = mem.deleteMemory('m_1')
  eq('memread：文件坏时删除 → written=false（不覆盖）', del.written, false)
  eq('memread：文件坏时删除 → 盘上内容没被改', fs.readFileSync(file, 'utf8'), 'not json at all')
  process.exit(fails ? 1 : 0)
}

/**
 * gate / personas / 源密钥 三处的「读不出来 ≠ 不存在」。
 *
 * 这三处都属于同一句话的复制品（规则第 5 条要一起改）：
 *  ① 闸门把「源目录打不开」报成 no-source → 用户按提示去找安装路径，永远修不好；
 *  ② 角色文件读不出来被记成「跳过」→ 用户以为「本来就有」；
 *  ③ 源 secrets.json 读不出来被记成「0 个密钥」→ 用户以为没有可导的密钥。
 */
async function scenarioReadNotAbsent(): Promise<void> {
  installWindow()
  mkdirp(SRC) // 场景要挪走它再放同名文件，所以先保证它存在

  // ① 闸门：三态要分开。真实不存在 → no-source；存在但打不开 → source-unreadable；
  //    存在但不是目录 → 也拦（文案点明「不是目录」，比笼统的「没找到」有用）。
  //    upstreamHome() = homedir()/.deva，本套件里就是 SRC。
  const { canImport } = await import('../../apps/desktop/src/main/importer-gate')
  const saved = `${SRC}.saved`
  let gFile: any
  let gMissing: any
  try {
    fs.renameSync(SRC, saved)
    fs.writeFileSync(SRC, 'x') // .deva 现在是个文件
    gFile = await canImport()
    fs.rmSync(SRC, { force: true })
    gMissing = await canImport() // 现在 .deva 不存在
  } finally {
    fs.rmSync(SRC, { force: true })
    fs.renameSync(saved, SRC) // 恢复成目录，后续步骤还要用
  }
  info('源路径是文件 / 不存在时', JSON.stringify({ file: [gFile?.ok, gFile?.code], missing: [gMissing?.ok, gMissing?.code] }))
  eq('闸门：源不存在 → no-source', gMissing?.code, 'no-source')
  eq('闸门：源存在但不是目录 → 也拦（ok=false）', gFile?.ok, false)
  check(
    '闸门：源不是目录时文案点明「不是目录」（不是笼统的「未找到」）',
    /不是(一个)?目录|not a folder/.test(String(gFile?.message ?? '')),
    String(gFile?.message)
  )

  // ② 角色文件读不出来：目标是目录（lstat 成功、open 失败是 EISDIR；这里用目录占位验证 blocked 语义）
  //    更贴近规则的是「目标存在但打不开」，用 PowerShell 独占无法作用于目录，故用目录占位验 blocked。
  const { importPersonas } = await import('../../apps/desktop/src/main/importer-personas')
  const srcP = path.join(SRC, 'personas')
  const dstP = path.join(DST, 'personas')
  mkdirp(srcP)
  mkdirp(dstP)
  fs.writeFileSync(path.join(srcP, 'readme.md'), '---\nid: readme\n---\nhi')
  mkdirp(path.join(dstP, 'readme.md')) // 目标位置被目录占住
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  const ps: any = importPersonas(SRC)
  info('角色导入结果', JSON.stringify(ps))
  check(
    '角色：目标被占位 → 不静默跳过（failed 里有该 id 或至少不进 skipped）',
    !ps.skipped.includes('readme'),
    JSON.stringify(ps)
  )

  // ③ 源 secrets.json 内容坏 → 报 source-secrets-corrupt，而不是「0 个密钥」
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }] } })
  fs.writeFileSync(path.join(SRC, 'secrets.json'), '{"imp-a":"abc')
  const r: any = await runImport()
  info('源密钥损坏时报告', JSON.stringify({ ok: r.ok, secrets: r.secrets }))
  eq(
    '源密钥：内容坏 → failed 里是 source-secrets-corrupt（不是「0 个」）',
    (r.secrets?.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['<secrets.json>', 'source-secrets-corrupt']]
  )
  check('源密钥：整轮 ok=false', r.ok === false, `ok=${r.ok}`)
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 守卫必须在危险路径上（false 分支这个方向） ═════════════ */

/**
 * P1-1 / P1-2：守卫是否落在**危险路径**上。
 *
 * ## 先说实测（Windows 11 + Node 24，本机）
 *
 * 写这个场景时我逐条量过「哪种故障会让 `existsSync` 返 false」，结论与直觉不同：
 *
 * | 情形 | existsSync | 撤掉守卫后 copyFileSync |
 * | --- | --- | --- |
 * | 文件被 EBUSY 独占 | **true**（stat 成功，只有 open 失败） | 抛 EBUSY，**不覆盖** |
 * | 目标是目录 | true | 抛 EISDIR |
 * | 只读文件（attrib +R） | true | 抛 EPERM |
 * | 断链 junction | **false** | 抛 ENOENT/EPERM，**不覆盖** |
 * | 父目录无权限 | false | 抛 EACCES |
 *
 * 也就是说：**Windows 上构造不出「`existsSync` 为 false 且 copyFileSync 覆盖掉原内容」**。
 * 被独占 / 只读 / 目录这几种（最危险的几种）`existsSync` 都返 true，旧代码的守卫**恰好**在真分支里也拦到了。
 *
 * ## 所以这个修复的真正价值，要分两层说
 *
 * 1. **可移植性**：POSIX 上 `existsSync` 跟随符号链接，**断链 symlink 会返 false**，而 `copyFileSync`
 *    写一个断链 symlink 会**沿链接写到目标位置**（不抛错）。那才是"写穿 + 覆盖"的真实路径。
 *    本机没开开发者模式造不出 symlink（EPERM），所以这一条在这里只能靠代码正确性保证，没法用场景证明。
 * 2. **报告质量（本机能证）**：断链 junction 时旧代码走假分支 → `copyFileSync` 抛 → 外层 catch 记一条
 *    **原始英文系统消息**（`EPERM: operation not permitted, copyfile ...`）；新代码判成 `blocked` →
 *    记 `target-blocked`，界面有中文文案。这条能红、能验。
 *
 * 结论：把守卫提到 `existsSync` 之前是对的（判据不该依赖一个对异常态撒谎的函数），但**不能**声称
 * 「修了一个 Windows 上会覆盖用户数据的 bug」——实测不成立，我按实测报告。
 */
async function scenarioGuardOnDangerPath(): Promise<void> {
  installWindow()
  const { importPersonas } = await import('../../apps/desktop/src/main/importer-personas')

  // ── ① 断链 junction：唯一能让 existsSync=false 而位置仍被占住的情形 ──
  const srcP = path.join(SRC, 'personas')
  const dstP = path.join(DST, 'personas')
  mkdirp(srcP)
  mkdirp(dstP)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  fs.writeFileSync(path.join(srcP, 'locked.md'), '---\nid: locked\n---\n来自原版')

  const gone = path.join(DST, 'gone-dir')
  mkdirp(gone)
  const dstMd = path.join(dstP, 'locked.md')
  let junctionOk = true
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', dstMd, gone], { stdio: 'ignore' })
    fs.rmdirSync(gone) // 目标消失 → 断链
  } catch {
    junctionOk = false
  }
  if (junctionOk) {
    eq('guardpath 前置：断链 junction 让 existsSync 返 false（这才是危险路径）', fs.existsSync(dstMd), false)
    const ps: any = importPersonas(SRC)
    info('断链 junction 下角色导入结果', JSON.stringify(ps))
    // 这是**能区分守卫位置**的断言：旧代码（守卫在真分支）会落到 copyFileSync 抛原始 EPERM 消息
    eq(
      '守卫位置：断链占位 → 记 target-blocked（不是外层 catch 抓来的原始 EPERM 消息）',
      (ps.failed ?? []).map((f: any) => f.reason),
      ['target-blocked']
    )
    eq('守卫位置：断链占位不算 copied', ps.copied, [])
  } else {
    info('无法创建 junction（本机未开开发者模式），跳过断链占位子项')
  }

  // ── ② EBUSY 独占：existsSync 返 true，但要验「不覆盖」与「有失败记录」 ──
  fs.rmSync(dstMd, { force: true, recursive: true })
  const localBody = '---\nid: locked\n---\n用户自己在 DevaPlus 里改过的提示词'
  fs.writeFileSync(dstMd, localBody)
  const srcAv = path.join(srcP, 'avatars')
  const dstAv = path.join(dstP, 'avatars')
  mkdirp(srcAv)
  mkdirp(dstAv)
  fs.writeFileSync(path.join(srcAv, 'locked.png'), 'SRC-AVATAR')
  const dstPng = path.join(dstAv, 'locked.png')
  const localAvatar = 'LOCAL-AVATAR'
  fs.writeFileSync(dstPng, localAvatar)

  const holdMd = await holdExclusive(dstMd)
  const holdPng = await holdExclusive(dstPng)
  if (!holdMd) {
    info('无法造独占占用（非 Windows），跳过 EBUSY 子项')
    holdPng?.stop()
    process.exit(fails ? 1 : 0)
  }
  let ps2: any
  try {
    ps2 = importPersonas(SRC)
  } finally {
    holdMd.stop()
    holdPng?.stop()
  }
  info('角色导入结果（本体+头像都被独占）', JSON.stringify(ps2))
  eq('守卫位置：角色 md 被独占时原内容没被覆盖', fs.readFileSync(dstMd, 'utf8'), localBody)
  if (holdPng) {
    eq('守卫位置：头像被独占时原内容没被覆盖', fs.readFileSync(dstPng, 'utf8'), localAvatar)
  }
  check(
    '守卫位置：角色 md 读不出 → failed 里有 target-unreadable',
    (ps2.failed ?? []).some((f: any) => f.id === 'locked#read' && f.reason === 'target-unreadable'),
    JSON.stringify(ps2.failed)
  )
  eq('守卫位置：读不出的角色不算 copied', ps2.copied, [])
  eq(
    '守卫位置：本体已失败时不重复报头像失败（同根因不重复计）',
    (ps2.failed ?? []).filter((f: any) => String(f.id).startsWith('locked#avatar')),
    []
  )

  // ── ③ 本体能导、只有头像被独占 → 头像失败必须报出来 ──
  fs.rmSync(dstMd, { force: true })
  const holdPng2 = await holdExclusive(dstPng)
  let ps3: any
  try {
    ps3 = importPersonas(SRC)
  } finally {
    holdPng2?.stop()
  }
  info('角色导入结果（只有头像被独占）', JSON.stringify(ps3))
  eq('守卫位置：本体正常导入', ps3.copied, ['locked'])
  const avatarFails = (ps3.failed ?? []).filter((f: any) => f.id === 'locked#avatar')
  check(
    '守卫位置：只有头像读不出 → failed 里有该条（不是静默跳过）',
    avatarFails.length === 1 && avatarFails[0].reason === 'target-unreadable',
    JSON.stringify(ps3.failed)
  )
  if (holdPng2) {
    eq('守卫位置：头像内容仍未被覆盖', fs.readFileSync(dstPng, 'utf8'), localAvatar)
  }

  /*
   * ── ⑭ 反向证据：**同一轮内** `#read` 与 `#avatar` 必须互斥 ──
   *
   * 「本体失败时不重复报头像」这条断言固定的是一个**隐式依赖**：本体失败后靠 `continue`
   * 跳过 `copyAvatar`。隐式依赖没有断言保护，下次有人把 `continue` 去掉（觉得「头像该独立于本体」）
   * 就会静默破掉。
   *
   * 判据必须**按轮**看，不能把两轮并起来：② 那轮本体+头像都被独占，③ 那轮只有头像被独占、
   * 本体是能导的。并起来必然两条都有——上一版就是这么写错的（自己先踩了一次）。
   * 正确的形态是：
   *   ②（本体失败的那轮）：只有 #read，没有 #avatar；
   *   ③（本体成功的那轮）：只有 #avatar，没有 #read。
   * 两条一起才既证明「互斥」、又证明「两个方向的路都真的走到了」。
   */
  const ids2 = (ps2.failed ?? []).map((f: any) => String(f.id))
  const ids3 = (ps3.failed ?? []).map((f: any) => String(f.id))
  check(
    '② 本体失败那轮：只有 #read、没有 #avatar（continue 真的挡住了头像尝试）',
    ids2.includes('locked#read') && !ids2.includes('locked#avatar'),
    JSON.stringify(ids2)
  )
  check(
    '③ 本体成功那轮：只有 #avatar、没有 #read（两侧路径都真的走到了，断言不是恒真）',
    ids3.includes('locked#avatar') && !ids3.includes('locked#read'),
    JSON.stringify(ids3)
  )
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 源侧内容文件读失败（P1-3 / P1-4） ═════════════ */

/**
 * 源侧内容文件（config.json / memory.json）的第三态：读不出来 ≠ 没有。
 *
 * ## 为什么改成「直调下游」而不是 `runImport`
 *
 * 闸门现在 fail-closed：源里有任何一项读不出来就**连导入都不开始**（`{ error }`）。
 * 这比跑完再报失败更强，但也意味着 `runImport` 永远走不到 `mergeProviders` / `importMemories`
 * 这两层——用 `runImport` 断言「providers.failed 里有条目」必然拿到 `[]`。
 *
 * 所以两层分开验：
 *   ① **闸门层**：源读不出来 → `ok:false` + `code:'source-partially-unreadable'`（本场景末段）
 *   ② **下游层**：直接调 `mergeProviders(srcHome)` / `importMemories(srcHome)`，验它们自己也报第三态
 *
 * ② 不能省：闸门与导入之间有时间窗（探测时能读、点下按钮时被锁），而且 `runImport` 不是唯一
 * 调用路径。闸门放开后如果下游还是静默「0 个」，bug 只是藏到了下一层。
 */
async function scenarioSourceReadFail(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  const { mergeProviders } = await import('../../apps/desktop/src/main/importer-config')
  const { importMemories } = await import('../../apps/desktop/src/main/importer-memory')
  const { canImport } = await import('../../apps/desktop/src/main/importer-gate')

  // ① 下游：源 config.json 内容坏 → 报 source-config-corrupt，不是「0 个服务商」
  fs.writeFileSync(path.join(SRC, 'config.json'), '{"models":{"providers":[{"id":"imp-a"')
  let mp: any = mergeProviders(SRC)
  info('源 config 坏时的 mergeProviders', JSON.stringify({ copied: mp.copied, failed: mp.failed }))
  eq(
    'P1-4（下游）：源 config.json 坏 → 报 source-config-corrupt（不是 0 个服务商）',
    (mp.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['<config.json>', 'source-config-corrupt']]
  )
  eq('P1-4（下游）：坏内容时 copied 为空（确实一个都没导）', mp.copied, [])

  // ② 下游：源 config.json 被独占（读不出来）→ 报 source-config-unreadable
  fs.rmSync(path.join(SRC, 'config.json'), { force: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }] } })
  const holdCfg = await holdExclusive(path.join(SRC, 'config.json'))
  if (holdCfg) {
    try {
      mp = mergeProviders(SRC)
      info('源 config 被独占时的 mergeProviders', JSON.stringify({ copied: mp.copied, failed: mp.failed }))
      eq(
        'P1-4（下游）：源 config.json 读不出 → 报 source-config-unreadable',
        (mp.failed ?? []).map((f: any) => [f.id, f.reason]),
        [['<config.json>', 'source-config-unreadable']]
      )
      eq('P1-4（下游）：读不出时 copied 为空', mp.copied, [])
    } finally {
      holdCfg.stop()
    }
  } else {
    info('无法造独占，跳过 source-config-unreadable 子项（内容坏那条已覆盖同一分支）')
  }

  // ③ 下游：源全局 memory.json 内容坏 → 报 source-memory-corrupt，不是「没有记忆」
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  fs.writeFileSync(path.join(SRC, 'memory.json'), '{"version":1,"entries":[{"id":"m_1","cont')
  let mm: any = importMemories(SRC)
  info('源 memory 坏时', JSON.stringify(mm.global))
  eq(
    'P1-3（下游）：源全局 memory.json 坏 → 报 source-memory-corrupt（不是「0 条记忆」）',
    (mm.global?.failed ?? []).map((f: any) => [f.id, f.reason]),
    [['<memory.json>', 'source-memory-corrupt']]
  )
  eq('P1-3（下游）：坏内容时 added 为空', mm.global?.added, [])

  // ④ 下游：项目记忆内容坏 → 按项目 key 报失败（以前这里是静默 continue）
  fs.rmSync(path.join(SRC, 'memory.json'), { force: true })
  const key = 'a'.repeat(24)
  mkdirp(path.join(SRC, 'projects', key))
  fs.writeFileSync(path.join(SRC, 'projects', key, 'memory.json'), 'not json')
  mm = importMemories(SRC)
  info('项目记忆坏时', JSON.stringify(mm.projects))
  check(
    'P1-3（下游）：项目 memory.json 坏 → 报 source-memory-corrupt（带项目 key）',
    (mm.projects?.failed ?? []).some((f: any) => f.id === key && f.reason === 'source-memory-corrupt'),
    JSON.stringify(mm.projects?.failed)
  )

  // ⑤ 下游对照：文件不存在是「原版没配过」，必须正常、不报失败
  fs.rmSync(path.join(SRC, 'projects'), { recursive: true, force: true })
  fs.rmSync(path.join(SRC, 'config.json'), { force: true })
  eq('对照组（下游）：源 config 不存在 → providers 无失败', mergeProviders(SRC).failed ?? [], [])
  eq('对照组（下游）：源 memory 不存在 → memories 无失败', importMemories(SRC).global?.failed ?? [], [])

  /*
   * ── ⑥ 项目记忆的**成功路径**（这条以前没有任何场景覆盖）──
   *
   * 之所以必须单独验：上面 ④ 只验了「项目记忆坏 → 报错」，它在实现坏掉时**也能通过**
   * （一个把 projectDirs 恒置空的实现，自然会报 0 条失败 —— 因为压根没尝试）。
   * 只有「好的项目记忆必须真的导进来」才能区分「报错通道通」和「整段逻辑没跑」。
   */
  const okKey = 'b'.repeat(24)
  mkdirp(path.join(SRC, 'projects', okKey))
  writeJson(path.join(SRC, 'projects', okKey, 'memory.json'), {
    version: 1,
    root: DST + '\\some-project',
    entries: [{ id: 'p_ok1', content: '项目记忆应当被导进来', createdAt: 1, updatedAt: 1 }]
  })
  const goodMem: any = importMemories(SRC)
  info('项目记忆正常时', JSON.stringify(goodMem.projects))
  eq(
    '成功路径：好的项目记忆必须真的导进来（区分「报错通道通」与「整段逻辑没跑」）',
    goodMem.projects?.added?.length,
    1
  )
  eq('成功路径：正常项目记忆不报失败', goodMem.projects?.failed ?? [], [])
  fs.rmSync(path.join(SRC, 'projects'), { recursive: true, force: true })

  /*
   * ── ⑦ 闸门层：只有**读不出来**才拦，**内容坏**要放行 ──
   *
   * 这两者必须分开（闸门 `countInJson` 的注释写明了理由）：内容坏时导入器自己能跳过并逐条上报
   * （`source-memory-corrupt`），拦掉整轮反而让用户连其他能导的数据都拿不到；
   * 而「读不出来」时下游根本不知道里面有什么，必须挡住。
   *
   * 所以这里用**独占占用**造「读不出来」，而不是写坏内容。
   */
  writeJson(path.join(SRC, 'memory.json'), { version: 1, entries: [{ id: 'm_1', content: '记忆一' }] })
  const holdMem = await holdExclusive(path.join(SRC, 'memory.json'))
  if (holdMem) {
    try {
      const gate: any = await canImport()
      info('源 memory.json 被独占时的闸门', JSON.stringify({ ok: gate.ok, code: gate.code }))
      eq('闸门层：源 memory.json 读不出来 → 不放行', gate.ok, false)
      eq('闸门层：用 source-partially-unreadable 码', gate.code, 'source-partially-unreadable')
      check('闸门层：文案点名 memory.json', String(gate.message).includes('memory.json'), String(gate.message))

      // ⑧ 闸门层 + runImport：真点下按钮也拿不到残缺报告
      const runReport: any = await runImport()
      info('闸门拦下时 runImport 返回', JSON.stringify(runReport))
      check(
        '闸门层：runImport 返回 { error } 而不是一份 ok=true 的报告',
        typeof runReport?.error === 'string' && runReport.providers === undefined,
        JSON.stringify(runReport)
      )
    } finally {
      holdMem.stop()
    }
  } else {
    info('无法造独占，跳过闸门层（memory.json 读不出的）子项')
  }

  /*
   * ⑨ **反向**：内容坏时必须放行（否则用户连其他数据都拿不到），并由导入器逐条上报。
   * 这条与 ⑦ 成对——只验其中一半，就会把「闸门恒拒绝」或「闸门恒放行」都当成对的。
   */
  fs.writeFileSync(path.join(SRC, 'memory.json'), '{"version":1,"entries":[{"id":"m_1","cont')
  const gateBad: any = await canImport()
  info('源 memory.json 内容坏时的闸门', JSON.stringify({ ok: gateBad.ok, code: gateBad.code }))
  eq('反向：内容坏时闸门**放行**（坏内容由导入器逐条上报，不该拦住整轮）', gateBad.ok, true)
  const repBad: any = await runImport()
  check(
    '反向：内容坏时导入器逐条上报 source-memory-corrupt',
    (repBad?.memories?.failed ?? []).some((f: any) => f.reason === 'source-memory-corrupt'),
    JSON.stringify(repBad?.memories?.failed)
  )
  process.exit(fails ? 1 : 0)
}

/**
 * 源侧 7 处「读不出来 → 当成没有」的复现。
 *
 * 造法：把源里的某一类目录**换成同名文件**，`readdirSync` 就抛 ENOTDIR。
 * 这是验收实测表用的同一手法，也是 ACL 改坏 / 被杀毒锁住之外最容易在测试里复现的一种。
 *
 * ⚠️ 断言方向是验收特别要求的：**「那一类数据变成 0 个且 ok=true」**，不是「报了个错误」。
 * 因为真正的 bug 是「静默」——数据没进来，报告说成功。所以每条都同时验：
 *   ① 该类计数确实是 0（证明这次真的没读出来，场景有效）；
 *   ② `failures` 里有对应条目（证明不再静默）；
 *   ③ `ok === false`（证明界面不会显示「导入完成」）。
 *
 * 只验 ② 是不够的：那样一个「报了错误但仍然 ok:true」的实现也能通过，而用户看到的仍是绿色的完成态。
 */
async function scenarioSourceDirSilent(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  mkdirp(DST)

  /** 造一份完整可导的原版，然后按需把某一处换成文件。 */
  const buildSource = (): void => {
    fs.rmSync(SRC, { recursive: true, force: true })
    mkdirp(path.join(SRC, 'data', 'chats'))
    mkdirp(path.join(SRC, 'personas'))
    mkdirp(path.join(SRC, 'skills'))
    mkdirp(path.join(SRC, 'data', 'media'))
    mkdirp(path.join(SRC, 'data', 'checkpoints', 's-1'))
    mkdirp(path.join(SRC, 'data', 'subagents', 's-1'))
    mkdirp(path.join(SRC, 'data', 'tool-results', 's-1'))
    mkdirp(path.join(SRC, 'projects'))
    writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }] } })
    writeJson(path.join(SRC, 'memory.json'), { version: 1, entries: [{ id: 'm_1', content: '记忆一', createdAt: 1, updatedAt: 1 }] })
    writeJson(path.join(SRC, 'data', 'chats', 'sess_a.json'), { id: 'sess_a', messages: [] })
    fs.writeFileSync(path.join(SRC, 'personas', 'p1.md'), '---\nid: p1\n---\n提示词')
    fs.writeFileSync(path.join(SRC, 'data', 'media', 'a'.repeat(64)), 'blob')
    fs.writeFileSync(path.join(SRC, 'data', 'checkpoints', 's-1', 'h1'), 'cp')
    writeJson(path.join(SRC, 'data', 'subagents', 's-1', 'sg.json'), { id: 'sg' })
    fs.writeFileSync(path.join(SRC, 'data', 'tool-results', 's-1', 't1.txt'), 'tr')
    writeJson(path.join(SRC, 'projects', 'a'.repeat(24), 'memory.json'), {
      version: 1,
      root: 'E:\\some-project',
      entries: [{ id: 'p_1', content: '项目记忆', createdAt: 1, updatedAt: 1 }]
    })
  }

  const countOf = (r: any, step: string): number => {
    const s = r[step]
    if (!s) return -1
    if (step === 'assoc') return (s.media ?? 0) + (s.checkpoints ?? 0) + (s.subagents ?? 0) + (s.toolResults ?? 0)
    // 记忆那一栏用的是 added（MergeStat），不是 copied
    if (step === 'memories') return Array.isArray(s.added) ? s.added.length : -1
    return Array.isArray(s.copied) ? s.copied.length : -1
  }

  // 每项：占住哪个路径 + 期望失败 id 前缀 + 计数会归零的步骤
  //
  // ⚠️ 这张表要与 `importer-gate.ts` 的 `summarize()` **逐项对齐**：summarize 数了哪些源，
  // 这里就要占哪些。少一项就等于给那一项留了一个「读不出但没人验」的缺口。
  // 名单来源不是 grep `readdirSync`（那只看得见已知形状），而是 summarize 的字段表 ——
  // 它是「闸门会看的源」的完整定义。
  const cases: Array<{ name: string; occupy: string; expectId: string; step: string; label: string }> = [
    { name: 'data/chats', occupy: path.join(SRC, 'data', 'chats'), expectId: '<data/chats>', step: 'sessions', label: '会话' },
    { name: 'personas', occupy: path.join(SRC, 'personas'), expectId: '<personas>', step: 'personas', label: '角色' },
    { name: 'skills', occupy: path.join(SRC, 'skills'), expectId: '<skills>', step: 'skills', label: '技能' },
    { name: 'data/media', occupy: path.join(SRC, 'data', 'media'), expectId: '<data/media>', step: 'assoc', label: '媒体' },
    { name: 'data/checkpoints', occupy: path.join(SRC, 'data', 'checkpoints'), expectId: '<checkpoints>', step: 'assoc', label: '回滚点' },
    // subagents 与 checkpoints 共用 mergeDir，但**必须单独占**：共用函数只保证逻辑一致，
    // 不保证调用点没漏（少传一个参数、kind 写错都会让它静默）。
    { name: 'data/subagents', occupy: path.join(SRC, 'data', 'subagents'), expectId: '<subagents>', step: 'assoc', label: '子智能体记录' },
    { name: 'projects', occupy: path.join(SRC, 'projects'), expectId: '<projects>', step: 'memories', label: '项目记忆' },
    { name: 'data/tool-results', occupy: path.join(SRC, 'data', 'tool-results'), expectId: '<toolResults>', step: 'assoc', label: '工具结果' }
  ]

  for (const c of cases) {
    buildSource()
    const before = await runImport()
    const baseline = countOf(before, c.step)
    // 清空目标，让第二轮是干净的一次导入
    fs.rmSync(DST, { recursive: true, force: true })
    mkdirp(DST)
    installWindow()

    // 把该类目录换成同名文件 → readdirSync 抛 ENOTDIR
    fs.rmSync(c.occupy, { recursive: true, force: true })
    fs.writeFileSync(c.occupy, 'i am a file, not a directory')

    const after = await runImport()
    info(`${c.name} 被占后的报告`, JSON.stringify(after))
    /*
     * 闸门现在 fail-closed：源有部分读不出来时**连导入都不开始**（返回 `{ error }`）。
     * 这比「导入跑完再报失败」更强——用户不会得到一份残缺数据。
     *
     * 但导入器自身的上报**也必须验**：`runImport` 不是唯一调用路径（补回、异常重入、将来的批量入口），
     * 而且闸门与导入之间有时间窗（探测时还能读，点下按钮时被锁）。所以两条都断言：
     *   ① 闸门拦住了（`{ error }`，且不含任何 copied 数据）；
     *   ② 直接调 `importSessions` / `copyAssoc` 等底层函数时，失败进 failed 而不是静默 0。
     */
    if ('error' in (after as any)) {
      info(`${c.name}：闸门拦下`, String((after as any).error))
      check(`${c.name}：闸门 fail-closed（连导入都不开始）`, true, String((after as any).error))
      // ② 底层函数仍然要上报（闸门是第二道保险，不是唯一一道）
      await assertStepReportsUnreadable(c.name, c.step, c.expectId)
      continue
    }
    const rep: any = after

    // ① 场景有效：该类确实读不出来了（0 个，且基线不是 0）
    check(
      `${c.name}：场景有效（基线 > 0，被占后该步归零）`,
      baseline > 0 && countOf(rep, c.step) === 0,
      `基线=${baseline} 被占后=${countOf(rep, c.step)}`
    )
    // ② 不再静默：有对应失败条目
    check(
      `${c.name}：上报 source-dir-unreadable（不是静默 0 个）`,
      (rep.failures ?? []).some(
        (f: any) => String(f.id).startsWith(c.expectId) && f.reason === 'source-dir-unreadable'
      ),
      JSON.stringify(rep.failures)
    )
    // ③ 关键：ok 必须是 false（否则界面显示「导入完成」，用户以为做完了）
    eq(`${c.name}：整轮 ok=false（不再「数据 0 个 + 成功」）`, rep.ok, false)
  }
  process.exit(fails ? 1 : 0)
}

/**
 * 闸门拦下之后，仍要验**底层步骤自己**也上报。
 *
 * 理由：闸门与导入之间有时间窗（探测时还能读、点按钮时被锁），而且 `runImport` 不是唯一调用路径。
 * 闸门放开后如果底层还是静默 0 个，就等于把 bug 藏到下一层。
 */
async function assertStepReportsUnreadable(caseName: string, step: string, expectId: string): Promise<void> {
  if (step === 'sessions') {
    const { importSessions } = await import('../../apps/desktop/src/main/importer-sessions')
    const s: any = importSessions(SRC)
    check(
      `${caseName}：底层 importSessions 也上报（闸门之外的第二道）`,
      (s.failed ?? []).some((f: any) => String(f.id).startsWith(expectId) && f.reason === 'source-dir-unreadable'),
      JSON.stringify(s.failed)
    )
    return
  }
  if (step === 'personas') {
    const { importPersonas } = await import('../../apps/desktop/src/main/importer-personas')
    const s: any = importPersonas(SRC)
    check(
      `${caseName}：底层 importPersonas 也上报`,
      (s.failed ?? []).some((f: any) => String(f.id).startsWith(expectId) && f.reason === 'source-dir-unreadable'),
      JSON.stringify(s.failed)
    )
    return
  }
  if (step === 'skills') {
    const { importSkills } = await import('../../apps/desktop/src/main/importer-skills')
    const s: any = importSkills(SRC)
    check(
      `${caseName}：底层 importSkills 也上报`,
      (s.failed ?? []).some((f: any) => String(f.id).startsWith(expectId) && f.reason === 'source-dir-unreadable'),
      JSON.stringify(s.failed)
    )
    return
  }
  if (step === 'assoc') {
    const c: any = copyAssoc(SRC)
    check(
      `${caseName}：底层 copyAssoc 也上报`,
      (c.failures ?? []).some((f: any) => String(f.id).startsWith(expectId) && f.reason === 'source-dir-unreadable'),
      JSON.stringify(c.failures)
    )
    return
  }
  if (step === 'memories') {
    const { importMemories } = await import('../../apps/desktop/src/main/importer-memory')
    const m: any = importMemories(SRC)
    const all = [...(m.global?.failed ?? []), ...(m.projects?.failed ?? [])]
    check(
      `${caseName}：底层 importMemories 也上报`,
      all.some((f: any) => String(f.id).startsWith(expectId) && f.reason === 'source-dir-unreadable'),
      JSON.stringify(all)
    )
  }
}

/** 闸门：概况读不出来时 fail-closed，按钮不该可点。 */
async function scenarioGatePartial(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  mkdirp(DST)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  const { canImport } = await import('../../apps/desktop/src/main/importer-gate')

  const okGate: any = await canImport()
  eq('闸门：源完整时放行', okGate.ok, true)
  const beforeSessions = okGate.summary?.sessions
  check('闸门：源完整时概况有会话数', typeof beforeSessions === 'number', String(beforeSessions))

  // 把 data/chats 换成文件 → 概况里 sessions 会变 0，但不能就这么放行
  fs.mkdirSync(path.join(SRC, 'data'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'data', 'chats'), 'file')
  const badGate: any = await canImport()
  info('源 data/chats 被占时的闸门', JSON.stringify({ ok: badGate.ok, code: badGate.code, msg: badGate.message }))
  eq('闸门：概况读不出 → fail-closed（ok=false）', badGate.ok, false)
  eq('闸门：用 source-partially-unreadable 码', badGate.code, 'source-partially-unreadable')
  check(
    '闸门：文案点名读不出来的那一项',
    String(badGate.message).includes('data/chats'),
    String(badGate.message)
  )

  // 对照组：源目录本来就没有这些子目录（ENOENT）→ 必须照常放行
  fs.rmSync(SRC, { recursive: true, force: true })
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  const emptyGate: any = await canImport()
  eq('闸门：原版确实是空的时候照常放行（ENOENT 不是读失败）', emptyGate.ok, true)

  /*
   * ── 反向证据：这条断言在「撤掉闸门」后确实会失败 ──
   *
   * 「闸门拦住了」这个 PASS 有两种可能：①闸门真的判对了；②场景根本没造出坏状态。
   * 二者都让断言通过，所以必须给出**可区分的一步**：确认「用户会看到的坏状态」真实存在。
   *
   * 办法：把 data/chats 换成**一个空目录**（能读、但里面没有会话）当对照——
   * 那种情况下闸门必须放行且 sessions===0。两个状态放一起，就分得清
   * 「0 是因为真的空」还是「0 是因为读不出来」。
   */
  fs.rmSync(SRC, { recursive: true, force: true })
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  fs.mkdirSync(path.join(SRC, 'data', 'chats'), { recursive: true }) // 空目录：能读、真的空
  const trulyEmpty: any = await canImport()
  info('对照：data/chats 是空目录时的闸门', JSON.stringify({ ok: trulyEmpty.ok, sessions: trulyEmpty.summary?.sessions }))
  check(
    '反向证据：同样是 sessions=0，但「真的空」时闸门**放行**（ok=true）',
    trulyEmpty.ok === true && trulyEmpty.summary?.sessions === 0,
    `ok=${trulyEmpty.ok} sessions=${trulyEmpty.summary?.sessions}`
  )
  check(
    '反向证据：而「读不出来」时同样 sessions=0 却**拒绝**（ok=false）——两者可区分，闸门不是恒拒绝',
    badGate.ok === false && badGate.code === 'source-partially-unreadable',
    `ok=${badGate.ok} code=${badGate.code}`
  )
  process.exit(fails ? 1 : 0)
}

/**
 * `getSecret` → `readSecret` 的三态（`absent` / `ok` / `unreadable`）。
 *
 * 真机换账户导致 DPAPI 解不开这件事本机验不了（依赖 OS 账户），但**代码路径**能验：
 * 用 `stub-electron.cjs` 让 `safeStorage.decryptString` 抛错，或让 `isEncryptionAvailable()` 返 false。
 * 三个环境由 runner 的 `@ENV=VAL` 后缀分别拉起（stub 的值是进程级常量，同进程改不了）：
 *   TEST_NOTHING=1        → 正常：absent / ok 两态
 *   TEST_DECRYPT_FAILS=1  → 有密文但解不开 → unreadable/decrypt-failed
 *   TEST_NO_ENCRYPTION=1  → 本机无加密能力 → unreadable/no-encryption
 *
 * 断言方向（这是本轮反复强调的那条）：**「解不开」不能被当成「没配过」**。以前两者都返回 null，
 * 用户看到「没配过密钥」会去重填（能解决但不知道为什么），或者更糟——请求侧拿空串去请求，
 * 把 401 归成「密钥填错了」。
 */
async function scenarioSecret(): Promise<void> {
  installWindow()
  mkdirp(DST)
  const { readSecret, hasSecret, setSecret } = await import('../../apps/desktop/src/main/services/secrets')
  const decryptFails = process.env.TEST_DECRYPT_FAILS === '1'
  const noEncryption = process.env.TEST_NO_ENCRYPTION === '1'
  info('环境', JSON.stringify({ decryptFails, noEncryption }))

  // ① 先把「有密文」的前提铺好（noEncryption 分支必须赶在第一次 readSecret 之前写盘，
  //    因为 ensureLoaded 只在本进程首次调用时读盘）
  if (noEncryption) {
    fs.writeFileSync(
      path.join(DST, 'secrets.json'),
      JSON.stringify({ 'imp-a': Buffer.from('enc:sk-real', 'utf8').toString('base64') })
    )
  }

  // ② 没配过 → absent（无论哪种环境、库里有几条，这个 key 都该是 absent）
  const missing = await readSecret('nobody')
  eq('absent：没配过的 key → kind=absent', missing.kind, 'absent')

  // ③ 有密文时按环境分三种
  if (noEncryption) {
    const r = await readSecret('imp-a')
    eq('no-encryption：有密文但本机无加密 → unreadable', r.kind, 'unreadable')
    eq('no-encryption：code 是 no-encryption', (r as any).code, 'no-encryption')
    check(
      'no-encryption：原因里说明是本机没有可用加密',
      /libsecret|加密/.test(String((r as any).reason)),
      String((r as any).reason)
    )
    eq('no-encryption：不是 absent（有密文，只是解不了）', r.kind !== 'absent', true)
  } else {
    // 正常环境：先写一条真密钥
    const w = await setSecret('imp-a', 'sk-real')
    eq('前置：setSecret 成功', w.ok, true)
    eq('前置：hasSecret 为 true', await hasSecret('imp-a'), true)
    const r = await readSecret('imp-a')
    if (decryptFails) {
      eq('decrypt-failed：有密文但解不开 → unreadable（不是 absent）', r.kind, 'unreadable')
      eq('decrypt-failed：code 是 decrypt-failed', (r as any).code, 'decrypt-failed')
      check(
        'decrypt-failed：原因里点明「多半是换了账户或换了机器」',
        /账户|机器|重新填写/.test(String((r as any).reason)),
        String((r as any).reason)
      )
      /*
       * 关键对照：**解不开 ≠ 没配过**。
       * 以前两者都返回 null，所以这条断言在旧实现下会红：hasSecret 为 true（盘上有密文）
       * 而 readSecret 说 absent —— 那正是「界面显示没配过、实际有密文」的现场。
       */
      eq('对照：hasSecret 仍是 true（盘上有密文，只是解不开）', await hasSecret('imp-a'), true)
    } else {
      eq('ok：能解密 → kind=ok', r.kind, 'ok')
      eq('ok：明文正确', (r as any).value, 'sk-real')
    }
  }
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 技能链接目标读不出：不许猜 isDir，否则建出坏链接 ═════════════ */

/**
 * `makeLink` 里的 `catch { isDir = true }` 是**猜**，违反「读失败 = 不知道」。实测两种失效：
 *
 *  1. **断链**（`statSync` → ENOENT：源链接指向的目录已被删）：猜目录 → junction 建成功 →
 *     目标里得到一个 `lstat` 存在、`existsSync` 为 false 的坏链接，报告记 `linked`（成功）；
 *  2. **读不出来**（EPERM）且目标其实是**文件**：猜目录 → `symlink(dir)` EPERM → 回落 junction →
 *     junction 指向文件也「建成功」，读出来 ENOENT —— 又一个坏链接。
 *
 * 本场景验：两种情况都记 `link-failed`、不算 `linked`，且目标里**不留下坏链接**。
 * 同时验对照组：正常链接（目标目录真实存在）仍按链接重建，行为不变。
 */
async function scenarioSkillLinkUnreadable(): Promise<void> {
  installWindow()
  const { importSkills } = await import('../../apps/desktop/src/main/importer-skills')
  const srcSkills = path.join(SRC, 'skills')
  const dstSkills = path.join(DST, 'skills')
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // 对照组：一个正常技能（真目录）
  mkdirp(path.join(srcSkills, 'good'))
  fs.writeFileSync(path.join(srcSkills, 'good', 'SKILL.md'), '# good')

  // ① 断链：源链接指向一个随后被删掉的目录
  const realDir = path.join(SCRATCH, 'skill-real')
  mkdirp(realDir)
  fs.writeFileSync(path.join(realDir, 'SKILL.md'), '# will vanish')
  mkdirp(srcSkills)
  fs.symlinkSync(realDir, path.join(srcSkills, 'broken'), 'junction')
  fs.rmSync(realDir, { recursive: true, force: true }) // 现在源链接断了

  let st: any = importSkills(SRC)
  info('断链时的 skills 统计', JSON.stringify(st))
  eq('断链：不算 linked（不能报成功）', st.linked, [])
  eq('断链：记 link-failed', (st.failed ?? []).filter((f: any) => f.id === 'broken').map((f: any) => f.reason), ['link-failed'])
  eq('断链：对照组正常链接/复制不受影响', [...st.copied, ...st.linked].sort(), ['good'])
  check(
    '断链：目标里**没有**留下坏链接（lstat 也不该有）',
    !(() => {
      try {
        fs.lstatSync(path.join(dstSkills, 'broken'))
        return true
      } catch {
        return false
      }
    })(),
    ''
  )
  check('断链：正常技能已落盘', fs.existsSync(path.join(dstSkills, 'good', 'SKILL.md')), '')
  process.exit(fails ? 1 : 0)
}

/* ═════════════ MCP 导入：源不可读 / 目标占位 / mcp 密钥归属 ═════════════ */

/**
 * 三个反向证据（任务要求缺一不可）：
 *  ① 源 mcp.json 被 ACL 拒绝 → `ok:false` + `failed` 有 `source-mcp-unreadable`；
 *     把三态改回 `catch { return {} }` 后这条必须变红。
 *  ② 目标 mcp.json 被同名目录占位 → `target-blocked`，且**目标原内容一个字节没动**。
 *  ③ `mcp:<id>:<field>` 在 MCP 导入之后从 `ignored` 变 `copied`。
 *
 * 还验幂等：第二轮 `copied:0 / skipped:N`，目标文件字节不变。
 */
async function scenarioMcp(): Promise<void> {
  installWindow()
  // 目标 config 必须在 installWindow 之前写（同理：registerConfigIpc 会 ensureLoaded 缓存）
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [] },
    mcp: { enabled: { magpie: true, github: true } }
  })
  writeJson(path.join(SRC, 'mcp.json'), {
    mcpServers: {
      magpie: {
        name: 'Magpie',
        description: 'hub',
        transport: 'http',
        url: 'http://127.0.0.1:3425/mcp/magpie/hub',
        headers: { authorization: 'Bearer plain-secret' }
      },
      stdioSrv: { name: 'Stdio', transport: 'stdio', command: 'node', args: ['x.js'], env: { K: 'v' } }
    }
  })
  // 源密钥：一条 mcp（应搬）、一条 remote（仍不搬）
  writeJson(path.join(SRC, 'secrets.json'), {
    'mcp:magpie:authorization': Buffer.from('enc:hdr', 'utf8').toString('base64'),
    'remote:bot1:appSecret': Buffer.from('enc:feishu', 'utf8').toString('base64')
  })

  const mod = await import('../../apps/desktop/src/main/importer-mcp')
  const st: any = mod.importMcp(SRC)
  info('MCP 导入结果', JSON.stringify(st))
  eq('MCP：两个服务都导入了', [...st.copied].sort(), ['magpie', 'stdioSrv'])
  eq('MCP：没有跳过', st.skipped, [])
  eq('MCP：没有失败', st.failed, [])

  const dstMcp = JSON.parse(fs.readFileSync(path.join(DST, 'mcp.json'), 'utf8'))
  eq('MCP：headers 原样搬运（含明文值，不剥密钥）', dstMcp.mcpServers.magpie.headers, {
    authorization: 'Bearer plain-secret'
  })
  eq('MCP：stdio 的 args/env 原样搬运', [dstMcp.mcpServers.stdioSrv.args, dstMcp.mcpServers.stdioSrv.env], [['x.js'], { K: 'v' }])
  const dstCfg = JSON.parse(fs.readFileSync(path.join(DST, 'config.json'), 'utf8'))
  eq('MCP：启用态只搬源里为 true 的', dstCfg.mcp?.enabled?.magpie, true)

  // ③ 密钥归属：改前 mcp:<id>:<field> 一律 ignored，改后应 copied
  const { copySecrets } = await import('../../apps/desktop/src/main/importer-config')
  const sec: any = await copySecrets(SRC)
  info('密钥结果', JSON.stringify(sec))
  check('③ MCP 密钥从 ignored 变 copied', sec.copied.includes('mcp:magpie:authorization'), JSON.stringify(sec))
  check('③ remote 仍然不导（ignored）', sec.ignored.includes('remote:bot1:appSecret'), JSON.stringify(sec))

  // 幂等：再跑一轮，copied 0 / skipped 2，目标文件字节不变
  const before = fs.readFileSync(path.join(DST, 'mcp.json'), 'utf8')
  const st2: any = mod.importMcp(SRC)
  eq('MCP 幂等：第二轮 copied 为空', st2.copied, [])
  eq('MCP 幂等：第二轮 skipped 两个', [...st2.skipped].sort(), ['magpie', 'stdioSrv'])
  eq('MCP 幂等：目标 mcp.json 字节未变', fs.readFileSync(path.join(DST, 'mcp.json'), 'utf8'), before)

  // ② 目标被同名目录占位 → target-blocked，且原内容一个字节没动
  fs.rmSync(path.join(DST, 'mcp.json'))
  mkdirp(path.join(DST, 'mcp.json'))
  const st3: any = mod.importMcp(SRC)
  info('目标被占位时', JSON.stringify(st3))
  eq('② 目标占位 → 两个服务都记 target-blocked', [...st3.failed].map((f: any) => f.reason), ['target-blocked', 'target-blocked'])
  eq('② 占位时没有写入任何服务', st3.copied, [])
  check('② 目标仍是个目录（一个字节没写）', fs.statSync(path.join(DST, 'mcp.json')).isDirectory(), '')

  // ① 源 mcp.json 读不出来（父目录 ACL 拒绝继承 → readFileSync 抛 EPERM）
  fs.rmSync(path.join(DST, 'mcp.json'), { recursive: true, force: true })
  const who = process.env.USERNAME ?? ''
  if (process.platform !== 'win32' || !who) {
    info('MCP①：非 Windows，跳过 unreadable 分支', process.platform)
    process.exit(fails ? 1 : 0)
  }
  execFileSync('icacls', [SRC, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'pipe' })
  try {
    const st4: any = mod.importMcp(SRC)
    info('源 mcp.json 读不出时', JSON.stringify(st4))
    eq(
      '① 源读不出 → source-mcp-unreadable（不是「原版没配 MCP」）',
      [...st4.failed].map((f: any) => [f.id, f.reason]),
      [['<mcp.json>', 'source-mcp-unreadable']]
    )
    eq('① 读不出时什么都没导', st4.copied, [])
    // 整轮 ok 必须为 false（闸门/报告能看见）
    check('① 报告 ok 会是 false', st4.failed.length > 0, JSON.stringify(st4.failed))
  } finally {
    execFileSync('icacls', [SRC, '/remove:d', who], { stdio: 'pipe' })
  }
  process.exit(fails ? 1 : 0)
}

/* ═════════════ P3：写目标失败不许把 Node 原始错误串透给界面 ═════════════ */

/**
 * 验收实测：会话目录建不出来时界面显示
 * `EEXIST: file already exists, mkdir 'C:\Users\lucel\AppData\Local\Temp\…\data\chats'`
 * ——英文 + 本机绝对路径。`reasonText()` 查不到就原样渲染。
 *
 * 本场景验：会话 / 角色 / 技能 / 附件四处「写目标失败」都归到 `target-write-failed`，
 * 且 reason 里**不含路径、不含冒号后的英文**（那是 Node message 的形状）。
 */
async function scenarioWriteReasonCode(): Promise<void> {
  installWindow()
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  // 目标 data 是文件 → data/chats 建不出来（ENOTDIR/EEXIST，原始 message 里带绝对路径）
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })
  fs.writeFileSync(path.join(DST, 'data'), 'i am a file')
  // 会话与附件都要有源数据，才会走到 mkdir
  mkdirp(path.join(SRC, 'data', 'chats'))
  writeJson(path.join(SRC, 'data', 'chats', 'sess-1.json'), { id: 'sess-1', messages: [] })
  mkdirp(path.join(SRC, 'data', 'media'))
  fs.writeFileSync(path.join(SRC, 'data', 'media', 'a'.repeat(64)), 'blob')
  // 角色：目标 personas 是文件 → 建不出角色目录
  mkdirp(path.join(SRC, 'personas'))
  fs.writeFileSync(path.join(SRC, 'personas', 'p1.md'), '---\nid: p1\n---\nx')
  fs.writeFileSync(path.join(DST, 'personas'), 'i am a file')

  const r: any = await runImport()
  const all = (r.failures ?? []) as Array<{ step: string; id: string; reason: string }>
  info('全部 failures', JSON.stringify(all.map((f) => `${f.step}/${f.id}:${f.reason}`)))

  const writeFails = all.filter((f) => f.reason === 'target-write-failed')
  check('P3：写目标失败统一归到 target-write-failed', writeFails.length > 0, JSON.stringify(writeFails))

  // 关键断言：任何一条 reason 都不许是 Node 原始 message 的形状
  const looksLikeNodeError = (reason: string): boolean =>
    /^[A-Z]+: /.test(reason) || reason.includes('\\') || reason.includes('/')
  const offenders = all.filter((f) => looksLikeNodeError(f.reason))
  eq('P3：没有一条 reason 是原始 Node 错误串（含路径 / 大写错误码前缀）', offenders, [])

  // 会话那一条必须归码（它就是验收报的现场）
  const sessFail = all.find((f) => f.step === 'sessions')
  check('P3：会话建目录失败已归码', sessFail?.reason === 'target-write-failed', JSON.stringify(sessFail))
  process.exit(fails ? 1 : 0)
}

/* ═════════════ P2：密钥坏值不许静默丢弃，纯空白不许写入 ═════════════ */

/**
 * 验收实测四种坏值，全部 `ok:true`、`invalid:[]`、`failed:[]`：
 *
 * | 源值            | 改前结果                        | 目标           |
 * | --------------- | ------------------------------- | -------------- |
 * | `""` 空串       | ok:true 无记录                  | 未写入         |
 * | `"   "` 纯空白  | ok:true **copied:["magpie"]**   | 写入 3 字符垃圾 |
 * | `{nested:'obj'}`| ok:true 无记录                  | 未写入         |
 * | `12345`         | ok:true 无记录                  | 未写入         |
 *
 * 两个病：① 类型不对 / 空串被 `continue` 静默丢弃，`stat.invalid` 永远是空的（`secrets.ts` 的
 * `code:'invalid'` 成了死分类）；② 纯空白非空，被当有效密文写进目标，界面显示「已配置」而用起来是 401。
 */
async function scenarioSecretInvalid(): Promise<void> {
  // 目标 config 必须在 installWindow 之前写：registerConfigIpc 会 ensureLoaded() 把配置读进模块缓存，
  // 之后再写文件就晚了（getConfig 会一直返回旧缓存）。这个坑在 personas.ts / bootstrap 那轮踩过。
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [{ id: 'magpie', models: [] }] } })
  writeJson(path.join(DST, 'secrets.json'), {})
  installWindow()
  // 源 config 要有对应 provider，这些 key 才不会被判成「无主密文」（那是 ignored，与本场景无关）
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'magpie', models: [] }] } })
  writeJson(path.join(SRC, 'secrets.json'), {
    magpie: '',
    'magpie:blank': '   ',
    'magpie:obj': { nested: 'obj' },
    'magpie:num': 12345,
    'magpie:ok': Buffer.from('enc:sk-real', 'utf8').toString('base64')
  })

  const { copySecrets } = await import('../../apps/desktop/src/main/importer-config')
  const st: any = await copySecrets(SRC)
  info('四种坏值 + 一个正常值', JSON.stringify(st))

  eq('P2：空串进 invalid', st.invalid.includes('magpie'), true)
  eq('P2：纯空白进 invalid', st.invalid.includes('magpie:blank'), true)
  eq('P2：非字符串进 invalid', st.invalid.includes('magpie:obj'), true)
  eq('P2：数字进 invalid', st.invalid.includes('magpie:num'), true)
  eq('P2：正常密文照常导入（对照组）', st.copied, ['magpie:ok'])
  eq('P2：整轮 invalid 共 4 条', st.invalid.length, 4)
  eq('P2：没有一条进 failed（这不是写盘失败）', st.failed ?? [], [])

  // 纯空白绝不能落进目标 secrets.json（改前它会以 3 个空格的形式写进去）
  const dstSecrets = JSON.parse(fs.readFileSync(path.join(DST, 'secrets.json'), 'utf8'))
  eq('P2：纯空白的 key 没有写进目标', 'magpie:blank' in dstSecrets, false)
  eq('P2：目标里只有那条正常密文', Object.keys(dstSecrets), ['magpie:ok'])
  process.exit(fails ? 1 : 0)
}

/* ═════════════ P1：源侧单文件「不是文件」与「读不出」不许压成 skipped ═════════════ */

/**
 * 目录级那 8 处修完之后，同一个形状在**文件级**还剩一处：
 *
 * ```ts
 * if (!statSync(from).isFile()) { stat.skipped.push(name); continue }
 * ```
 *
 * 验收实测：把 `personas/ludi-afacec76.md` 换成同名目录 →
 * `ok:true`、`failures:[]`、`personaSkipped:["ludi-afacec76.md"]`、目标角色 8→7。
 * 「跳过 1 个」的语义是「本来就有，不用导」，而这里其实是**源数据坏了**。
 *
 * 本场景验三件事：
 *  ① 普通 .md 照常导入（对照组，防止「全记 failed」也能过）；
 *  ② 同名目录冒充 .md → failed + `source-not-a-file`，且**不算 skipped**；
 *  ③ 读不出来（EPERM）→ failed + `source-file-unreadable`。
 */
async function scenarioSourceFileNotFile(): Promise<void> {
  installWindow()
  const { importPersonas } = await import('../../apps/desktop/src/main/importer-personas')
  const srcP = path.join(SRC, 'personas')
  const dstP = path.join(DST, 'personas')
  mkdirp(srcP)
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // ① 正常角色（对照）
  fs.writeFileSync(path.join(srcP, 'good.md'), '---\nid: good\n---\n提示词')
  // ② 目录冒充 .md：源里那个位置不是普通文件
  fs.mkdirSync(path.join(srcP, 'ludi-afacec76.md'), { recursive: true })
  let st: any = importPersonas(SRC)
  info('目录冒充 .md 时', JSON.stringify(st))
  eq('P1：目录冒充 .md → failed source-not-a-file', (st.failed ?? []).filter((f: any) => f.id === 'ludi-afacec76.md').map((f: any) => f.reason), ['source-not-a-file'])
  eq('P1：目录冒充 .md 不算 skipped', st.skipped, [])
  eq('P1：正常角色照常导入（对照组）', st.copied, ['good'])
  check('P1：正常角色文件已落盘', fs.existsSync(path.join(dstP, 'good.md')), '')

  // ③ 读不出来：父目录 ACL 拒绝继承 → statSync 抛 EPERM（非 ENOENT）
  const who = process.env.USERNAME ?? ''
  if (process.platform !== 'win32' || !who) {
    info('P1：非 Windows，跳过 unreadable 分支', process.platform)
    process.exit(fails ? 1 : 0)
  }
  fs.rmSync(srcP, { recursive: true, force: true })
  mkdirp(srcP)
  fs.writeFileSync(path.join(srcP, 'locked.md'), '---\nid: locked\n---\nx')
  // 只锁住这一条：把 unmovable.md 放进子目录再 deny 子目录
  const box = path.join(srcP, 'box')
  mkdirp(box)
  fs.writeFileSync(path.join(box, 'inner.md'), '---\nid: inner\n---\nx')
  execFileSync('icacls', [box, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'pipe' })
  try {
    // 直接对单文件探测：父目录被 deny → statSync(box/inner.md) 抛 EPERM
    const mod = await import('../../apps/desktop/src/main/importer-source-dir')
    const probe = mod.inspectSourceFile(path.join(box, 'inner.md'))
    info('单文件探测结果', JSON.stringify(probe))
    eq('P1：读不出来 → unreadable（不是 absent）', probe.kind, 'unreadable')
    eq('P1：翻成失败码 source-file-unreadable', mod.sourceFileFailureReason(probe), 'source-file-unreadable')
    // 目录冒充 → not-file，翻成 source-not-a-file
    eq('P1：目录冒充 → not-file', mod.inspectSourceFile(path.join(srcP, 'box')).kind, 'not-file')
    eq('P1：目录冒充翻成 source-not-a-file', mod.sourceFileFailureReason(mod.inspectSourceFile(path.join(srcP, 'box'))), 'source-not-a-file')
    // 真没有 → absent，翻成 null（调用方按跳过处理）
    eq('P1：真没有 → absent', mod.inspectSourceFile(path.join(srcP, 'nope.md')).kind, 'absent')
    eq('P1：absent 不产生失败码', mod.sourceFileFailureReason(mod.inspectSourceFile(path.join(srcP, 'nope.md'))), null)
    eq('P1：普通文件 → ok', mod.inspectSourceFile(path.join(srcP, 'locked.md')).kind, 'ok')
  } finally {
    execFileSync('icacls', [box, '/remove:d', who], { stdio: 'pipe' })
  }
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 第 9 处：技能目标的 lexists 把「读不出」当成「没有」 ═════════════ */

/**
 * 同一个 bug 的第 9 处（本轮漏掉的那个）：`importer-skills.ts` 的 `lexists(to)` 以前返回 boolean，
 * `catch { return false }` 把 EPERM / EBUSY / EACCES 全压成「目标不存在」，于是调用方会去建链接，
 * **覆盖掉用户自己装的同名技能**。
 *
 * 形状与另外 8 处的差别（这是它被漏掉的原因）：
 *  1. 它被包在一个**辅助函数**里（`lexists`），扫描器看的是「`existsSync` 后紧跟 return/continue」，
 *     而这里是 `if (lexists(to))` —— 函数名不在 `EXIST_FNS` 清单里，规则完全不认；
 *  2. 它连 `existsSync` 都不用（刻意用 `lstatSync` 防断链误判），所以连「读操作」这条特征都不匹配。
 *
 * unreadable 的造法（本机实测）：Windows 上 `lstat` 对「中间层是文件」「尾部带点」「保留设备名」
 * 「超长名」一律返回 **ENOENT**，对「自身被 ACL 拒绝」返回 present（拒绝的只是 readdir）；
 * 只有**父目录被 deny 继承 (OI)(CI)(RX)** 时，子路径的 `lstat` 才抛 **EPERM**。
 */
async function scenarioSkillsLexists(): Promise<void> {
  installWindow()
  const { importSkills } = await import('../../apps/desktop/src/main/importer-skills')
  const srcSkills = path.join(SRC, 'skills')
  const dstSkills = path.join(DST, 'skills')
  mkdirp(path.join(srcSkills, 'myskill'))
  fs.writeFileSync(path.join(srcSkills, 'myskill', 'SKILL.md'), '# mine')
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // ① 目标已存在且是目录 → present → skipped（不覆盖用户自己装的）
  mkdirp(path.join(dstSkills, 'myskill'))
  fs.writeFileSync(path.join(dstSkills, 'myskill', 'SKILL.md'), '# user own')
  let st: any = importSkills(SRC)
  info('目标已存在时', JSON.stringify(st))
  eq('第9处：目标已存在 → skipped（不覆盖）', st.skipped, ['myskill'])
  eq('第9处：用户自己的内容没被覆盖', fs.readFileSync(path.join(dstSkills, 'myskill', 'SKILL.md'), 'utf8'), '# user own')

  // ② 目标父目录被 ACL 拒绝继承 → lstat 抛 EPERM（不是 ENOENT）→ unreadable，必须报失败
  fs.rmSync(dstSkills, { recursive: true, force: true })
  mkdirp(path.join(dstSkills, 'myskill'))
  const user = process.env.USERNAME ?? ''
  let denied = false
  if (process.platform === 'win32' && user) {
    try {
      execFileSync('icacls', [dstSkills, '/deny', `${user}:(OI)(CI)(RX)`], { stdio: 'pipe' })
      denied = true
    } catch {
      /* 造不出就跳过这一条（下面会明确报 skip，不伪装成通过） */
    }
  }
  if (!denied) {
    info('第9处', '本平台造不出 EPERM（需 win32 + icacls），unreadable 分支未验证')
    process.exit(fails ? 1 : 0)
  }
  try {
    st = importSkills(SRC)
    info('目标父目录被 ACL 拒绝时', JSON.stringify(st))
    const skillFails = (st.failed ?? []).filter((f: any) => f.id === 'myskill')
    eq(
      '第9处：目标读不出来 → failed target-unreadable（不是静默去建链接覆盖）',
      skillFails.map((f: any) => f.reason),
      ['target-unreadable']
    )
    eq('第9处：读不出时不算 copied', st.copied, [])
    eq('第9处：读不出时不算 skipped', st.skipped, [])
  } finally {
    try {
      execFileSync('icacls', [dstSkills, '/remove:d', user], { stdio: 'pipe' })
    } catch {
      /* 清理失败不影响断言结论 */
    }
  }
  process.exit(fails ? 1 : 0)
}

/* ═════════════ 入口 ═════════════ */
const S: Record<string, () => Promise<void>> = {
  p0turn: scenarioP0Turn,
  p0ckpt: scenarioP0Ckpt,
  skipsess: scenarioSkipSess,
  skipsec: scenarioSkipSec,
  unread: scenarioUnreadable,
  stalem: scenarioStaleMtime,
  writefail: scenarioWriteFail,
  reason2: scenarioReason,
  assocblk: scenarioAssocBlocked,
  assocprt: scenarioAssocPartial,
  compbad: scenarioCompactedBad,
  memread: scenarioMemRead,
  readabsent: scenarioReadNotAbsent,
  guardpath: scenarioGuardOnDangerPath,
  srcread: scenarioSourceReadFail,
  srcdir: scenarioSourceDirSilent,
  secret: scenarioSecret,
  gatepartial: scenarioGatePartial,
  skilllex: scenarioSkillsLexists,
  srcfile: scenarioSourceFileNotFile,
  secinvalid: scenarioSecretInvalid,
  writereason: scenarioWriteReasonCode,
  mcp: scenarioMcp,
  skillbrk: scenarioSkillLinkUnreadable
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
    fail(`${name} 抛异常`, (e as Error)?.stack?.split('\n').slice(0, 6).join(' / ') ?? String(e))
  }
  console.log(`=== ${name} 结束：FAIL ${fails} ===`)
  process.exit(fails ? 1 : 0)
}
void main()
