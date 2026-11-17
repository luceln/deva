/**
 * P0 复现/回归脚本（独立于 test-main.ts 的 125 条套件，专测两件事）：
 *
 *   p0fail —— 失败通道是否真的贯通：注入三种真实的「写不进去」，断言报告里必须出现对应 failures 且 ok=false。
 *             ① 目标 data/chats 是个同名**文件**（mkdir 必失败）→ sessions 一个都导不进来
 *             ② 目标 config.json 是个**目录**（原子写必失败）→ 服务商只在内存里，磁盘上一个字都没有
 *             ③ 源 media 里一个 blob 被别的进程**独占**（FILE_SHARE_NONE）→ 这个 blob 复制不进来
 *             修复前这三条全是「ok=true、failures: []」，界面写「导入完成」而数据缺块。
 *
 *   p0race —— 导入中途渲染层整段回写 models 段（「打开一个对话」就会触发）是否会把刚并入的服务商覆盖掉。
 *             修复前磁盘上会一个不剩；修复后既要保住导入成果，也不能丢掉用户这一轮的改动（theme）。
 *
 * 运行：node .deva/qa/repro-p0.cjs        （每个场景一个独立进程，模块内缓存不可重置）
 */
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync, spawn } from 'child_process'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport } from '../../apps/desktop/src/main/importer-gate'
import { registerConfigIpc } from '../../apps/desktop/src/main/services/config'

const HOME = process.env.TEST_HOME as string
const DST = process.env.DEVA_HOME as string
const SCRATCH = process.env.QA_SCRATCH as string
const SRC = path.join(HOME, '.deva')

/* ───────────── 断言与输出 ───────────── */

let fails = 0
function log(kind: 'PASS' | 'FAIL' | 'INFO', name: string, detail = ''): void {
  const line = `${kind} ${name}${detail ? ` :: ${detail}` : ''}`
  if (kind === 'FAIL') fails++
  console.log(line)
}
const pass = (n: string, d = ''): void => log('PASS', n, d)
const fail = (n: string, d = ''): void => log('FAIL', n, d)
const info = (n: string, d = ''): void => log('INFO', n, d)
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass(name, a)
  else fail(name, `实际=${a} 期望=${e}`)
}
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass(name, detail)
  else fail(name, detail)
}

/* ───────────── 小工具 ───────────── */

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}
function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 渲染层/store 的窗口桩：只要 webContents.send 不炸即可（本脚本不关心广播内容）。 */
function installWindow(): void {
  const win: any = { isDestroyed: () => false, webContents: { send: () => {} } }
  registerConfigIpc(() => win)
}

/** 取渲染层 config:set 的 IPC handler（stub-electron 暴露了注册表）。 */
function configSetHandler(): (e: unknown, patch: Record<string, unknown>) => unknown {
  const stub = require('electron') as any
  const h = stub.__test?.ipcHandlers?.get('config:set')
  if (!h) throw new Error('config:set handler 未注册')
  return h
}

/**
 * 让一个进程以 FILE_SHARE_NONE 独占打开文件（Node 的 openSync 在 Windows 上不独占，测不出来）。
 * 返回 stop()：taskkill 收尾（ps.kill 杀不掉 powershell 的子进程）。
 */
async function holdExclusive(target: string): Promise<{ stop: () => void; held: boolean }> {
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
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await sleep(100)
  // 确认真的锁住了：独立读句柄应该被共享冲突拒掉
  let held = false
  try {
    fs.readFileSync(target)
  } catch {
    held = true
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
  return { stop, held }
}

/* ───────────── 场景 p0fail ───────────── */

async function scenarioP0Fail(): Promise<void> {
  installWindow()
  // 最小源：1 个自定义服务商 + 1 条它的密钥 + 1 条无主密文 + 1 个会话 + 2 个 blob
  const mediaDir = path.join(SRC, 'data', 'media')
  const chatsDir = path.join(SRC, 'data', 'chats')
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'custom-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null }
  })
  writeJson(path.join(SRC, 'secrets.json'), {
    'custom-x': Buffer.from('enc:sk-x', 'utf8').toString('base64'),
    'remote:bot_mwcyl7ok_3hrt:appSecret': Buffer.from('enc:app-secret', 'utf8').toString('base64')
  })
  writeJson(path.join(chatsDir, 's1.json'), { id: 's1', title: 'one', messages: [], updatedAt: Date.now() })
  fs.mkdirSync(mediaDir, { recursive: true })
  const blobA = path.join(mediaDir, 'a'.repeat(64))
  const blobB = path.join(mediaDir, 'b'.repeat(64))
  fs.writeFileSync(blobA, Buffer.alloc(2048, 1))
  fs.writeFileSync(blobB, Buffer.alloc(2048, 2))

  // 故障注入（目标侧）
  fs.mkdirSync(DST, { recursive: true })
  fs.mkdirSync(path.join(DST, 'data'), { recursive: true })
  // ① data/chats 变成同名文件 → mkdirSync 必失败
  fs.writeFileSync(path.join(DST, 'data', 'chats'), 'not a directory')
  // ② config.json 变成目录 → 原子写必失败
  fs.mkdirSync(path.join(DST, 'config.json'))
  fs.mkdirSync(path.join(DST, 'data', 'media'), { recursive: true })
  // ③ 源里一个 blob 被独占
  const holder = await holdExclusive(blobA)
  info('故障注入', `chats=文件 config.json=目录 blob 独占=${holder.held}`)
  check('故障注入生效：blob 确实被独占（读失败）', holder.held)

  let report: any
  try {
    report = await runImport()
  } finally {
    holder.stop()
  }
  info('报告', JSON.stringify(report).slice(0, 600))

  check('报告不是 { error }', !report?.error, JSON.stringify(report?.error))
  if (report?.error) return

  // ① 会话：必须报失败，而不是 0 新增 + ok
  const sessFailed = report.sessions?.failed ?? []
  check('会话：mkdir 失败被报为 failed', sessFailed.length >= 1, JSON.stringify(sessFailed))
  check('会话：failed 带 step/id/reason', sessFailed.every((f: any) => f.step === 'sessions' && f.id && f.reason), JSON.stringify(sessFailed))
  eq('会话：copied 为空（确实一个都没进去）', report.sessions?.copied.length, 0)

  // ② 服务商：写盘失败必须报失败
  const provFailed = report.providers?.failed ?? []
  check('服务商：config.json 写盘失败被报为 failed', provFailed.length === 1, JSON.stringify(provFailed))
  check('服务商：failed 指向 config.json', provFailed[0]?.id === '<config.json>', JSON.stringify(provFailed[0]))
  const cfgRaw = (() => {
    try {
      return fs.readFileSync(path.join(DST, 'config.json'), 'utf8')
    } catch {
      return ''
    }
  })()
  check('服务商：磁盘 config.json 里没有 custom-x 字样', !cfgRaw.includes('custom-x'), `len=${cfgRaw.length}`)

  // ③ 媒体：被独占的 blob 必须报失败
  const assocFailures = report.failures.filter((f: any) => f.step === 'assoc')
  check('附件：被独占的 blob 进了 failures', assocFailures.some((f: any) => f.id.startsWith('media:')), JSON.stringify(assocFailures))
  const mediaOk = fs.existsSync(path.join(DST, 'data', 'media', path.basename(blobA)))
  const mediaOk2 = fs.existsSync(path.join(DST, 'data', 'media', path.basename(blobB)))
  check('附件：另一个 blob 照常复制（失败不中断整轮）', mediaOk2, `b=${mediaOk2}`)
  check('附件：被独占的 blob 确实没进来', !mediaOk, `a=${mediaOk}`)

  // 总账
  check('总报告 ok=false', report.ok === false, `ok=${report.ok}`)
  const steps = new Set(report.failures.map((f: any) => f.step))
  check('failures 里三个步骤都在', steps.has('sessions') && steps.has('providers') && steps.has('assoc'), [...steps].join(','))
}

/* ───────────── 场景 p0race ───────────── */

async function scenarioP0Race(): Promise<void> {
  installWindow()
  const setHandler = configSetHandler()
  // 源：两个自定义服务商（导入会新增），没有会话/附件，跑得很快 → 用进度回调卡住注入时机
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: [
        { id: 'custom-a', name: 'A', apiHost: 'https://a.invalid', models: [] },
        { id: 'custom-b', name: 'B', apiHost: 'https://b.invalid', models: [] }
      ],
      activeModelId: null
    }
  })
  fs.mkdirSync(DST, { recursive: true })
  // 目标：渲染层手里的「旧快照」就是这一个预置 provider（不含 custom-a/b）
  writeJson(path.join(DST, 'config.json'), {
    models: {
      providers: [{ id: 'deepseek', name: 'deepseek', apiHost: 'https://ds.invalid', models: [] }],
      activeModelId: null,
      activeEffort: 'default'
    },
    theme: 'light'
  })

  // 模拟「导入期间用户点开一个对话」：models.tsx 会把整段 models（旧快照）回写
  let injected = 0
  const staleSnapshot = {
    models: {
      providers: [{ id: 'deepseek', name: 'deepseek', apiHost: 'https://ds.invalid', models: [] }],
      activeModelId: null,
      activeEffort: 'default'
    },
    theme: 'dark' // 顺手代表「用户这一轮真的改了点东西」，收尾后不能丢
  }

  const report: any = await runImport((p: any) => {
    // 服务商并入之后、整轮结束之前——正是真实竞态的窗口
    if (p.step === 'sessions' && injected === 0) {
      injected++
      setHandler({}, staleSnapshot)
    }
  })
  info('报告', JSON.stringify(report).slice(0, 400))
  eq('注入次数', injected, 1)
  check('报告声称导入了 2 个服务商', report?.providers?.copied?.length === 2, JSON.stringify(report?.providers?.copied))

  const cfg = readJson(path.join(DST, 'config.json'))
  const ids: string[] = (cfg.models?.providers ?? []).map((p: any) => p.id)
  info('磁盘上的 providers', JSON.stringify(ids))
  check('磁盘上仍有 custom-a（未被中途回写覆盖）', ids.includes('custom-a'), JSON.stringify(ids))
  check('磁盘上仍有 custom-b（未被中途回写覆盖）', ids.includes('custom-b'), JSON.stringify(ids))
  check('磁盘上保留了本地的 deepseek', ids.includes('deepseek'), JSON.stringify(ids))
  eq('用户中途的改动（theme）没丢', cfg.theme, 'dark')
}

/* ───────────── 场景 p0home ───────────── */

/**
 * DEVA_HOME 指成原版目录时必须被拒。
 * 不做这层防护时，导入会删掉原版的 data/chats/_index.json（invalidateIndex）并把 import.lock 写进原版
 * ——「原版全程只读」的承诺在便携安装或手滑设错环境变量时不成立。
 */
async function scenarioP0Home(): Promise<void> {
  fs.mkdirSync(path.join(SRC, 'data', 'chats'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'config.json'), '{}')
  // 必须在任何 getDevaHome() 调用之前改（模块级 home 缓存）
  process.env.DEVA_HOME = SRC
  const g = await canImport()
  info('闸门结果', JSON.stringify({ ok: g.ok, code: (g as any).code, message: (g as any).message }))
  check('DEVA_HOME = 原版目录 → 拒绝导入', g.ok === false, JSON.stringify(g))
  check('拒绝原因码是 same-home', (g as any).code === 'same-home', String((g as any).code))
  check('文案点明不允许改动原版', /原版|upstream/i.test(String((g as any).message)), String((g as any).message))
  // 拒绝之后确实没有任何写入
  check('原版目录里没被写入 import.lock', !fs.existsSync(path.join(SRC, 'import.lock')))
}

/* ───────────── 入口 ───────────── */

async function main(): Promise<void> {
  const name = process.argv[2]
  if (name === 'p0fail') await scenarioP0Fail()
  else if (name === 'p0race') await scenarioP0Race()
  else if (name === 'p0home') await scenarioP0Home()
  else {
    console.error(`未知场景：${name}`)
    process.exit(2)
  }
  console.log(fails === 0 ? `=== ${name} 结束：FAIL 0 条 ===` : `=== ${name} 结束：FAIL ${fails} 条 ===`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(3)
})
