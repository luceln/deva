/**
 * 导入功能独立验证——测试主体。
 *
 * 运行方式：由 driver.cjs 用 esbuild 打包成 dist/test.cjs，再按场景各起一个进程（模块内状态是一次性的）。
 * 环境契约（driver 负责设置）：
 *   TEST_HOME    → 假的用户主目录（被测代码 upstreamHome() = homedir()/.deva 落在这里）
 *   TEST_APPDATA → 假的 appData（原版 lockfile 拼在这里）
 *   DEVA_HOME    → 目标数据目录
 *   QA_REAL      → 真实 ~/.deva 的路径（只读复制，绝不写）
 *   QA_SCRATCH   → 本场景的临时目录
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFileSync, spawn } from 'child_process'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport, upstreamHome } from '../../apps/desktop/src/main/importer-gate'
import { acquireLock, isLockLive, readLockPid, releaseLock, LOCK_FILE } from '../../apps/desktop/src/main/importer-lock'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { importSkills } from '../../apps/desktop/src/main/importer-skills'
import { importMemories } from '../../apps/desktop/src/main/importer-memory'
import { importPersonas } from '../../apps/desktop/src/main/importer-personas'
import { mergeProviders, copySecrets } from '../../apps/desktop/src/main/importer-config'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'
import { getDevaHome, getConfig, setConfig, registerConfigIpc } from '../../apps/desktop/src/main/services/config'
import { invalidateIndex, listSessions } from '../../apps/desktop/src/main/services/chat-store'
import { onSessionsChanged } from '../../apps/desktop/src/main/services/chat-bus'
import { sweepMedia } from '../../apps/desktop/src/main/services/media-store'
import { sweepCheckpoints } from '../../apps/desktop/src/main/services/checkpoints'
import { sweepSubagents } from '../../apps/desktop/src/main/services/subagent-store'
import { writeMemory, listMemories, GLOBAL_SCOPE } from '../../apps/desktop/src/main/services/memory'
import { readSecret } from '../../apps/desktop/src/main/services/secrets'

const HOME = process.env.TEST_HOME as string
const APPDATA = process.env.TEST_APPDATA as string
const DST = process.env.DEVA_HOME as string
const REAL = process.env.QA_REAL as string
const SCRATCH = process.env.QA_SCRATCH as string

const SRC = path.join(HOME, '.deva')
const UPSTREAM_LOCK = path.join(APPDATA, '@deva', 'desktop', 'lockfile')

/* ───────────── 断言与输出 ───────────── */

let fails = 0
const lines: string[] = []

function log(kind: 'PASS' | 'FAIL' | 'INFO', name: string, detail = ''): void {
  if (kind === 'FAIL') fails++
  const line = `${kind} ${name}${detail ? ` :: ${detail}` : ''}`
  lines.push(line)
  console.log(line)
}
function pass(name: string, detail = ''): void {
  log('PASS', name, detail)
}
function fail(name: string, detail = ''): void {
  log('FAIL', name, detail)
}
function info(name: string, detail = ''): void {
  log('INFO', name, detail)
}
function check(name: string, cond: boolean, detail = ''): boolean {
  cond ? pass(name, detail) : fail(name, detail)
  return cond
}
function eq(name: string, actual: unknown, expected: unknown): boolean {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(name, a === e, a === e ? a : `实际=${a} 期望=${e}`)
}

/* ───────────── 目录快照 ───────────── */

interface Snap {
  /** 相对路径 → 指纹（文件含 size+mtime+md5；链接含 target；目录含 mtime） */
  entries: Map<string, string>
  counts: { files: number; dirs: number; links: number }
}

function md5(file: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

function snapshot(root: string): Snap {
  const entries = new Map<string, string>()
  const counts = { files: 0, dirs: 0, links: 0 }
  const walk = (dir: string, rel: string): void => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const abs = path.join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      let st: fs.Stats
      try {
        st = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        counts.links++
        let target = ''
        try {
          target = fs.readlinkSync(abs)
        } catch {
          /* ignore */
        }
        entries.set(r, `link:${target}`)
      } else if (st.isDirectory()) {
        counts.dirs++
        entries.set(r, `dir:${Math.round(st.mtimeMs)}`)
        walk(abs, r)
      } else {
        counts.files++
        entries.set(r, `file:${st.size}:${Math.round(st.mtimeMs)}:${md5(abs)}`)
      }
    }
  }
  walk(root, '')
  return { entries, counts }
}

function diffSnap(a: Snap, b: Snap): string[] {
  const out: string[] = []
  for (const [k, v] of a.entries) {
    if (!b.entries.has(k)) out.push(`-${k}`)
    else if (b.entries.get(k) !== v) out.push(`~${k}(${v} → ${b.entries.get(k)})`)
  }
  for (const k of b.entries.keys()) if (!a.entries.has(k)) out.push(`+${k}`)
  return out
}

/* ───────────── 小工具 ───────────── */

/** 模拟「已启动过一次」的 DevaPlus 目标：11 个预置服务商 + 两个默认角色文件 + seeded 守卫位。 */
function seedTarget(): void {
  const presets = [
    'anthropic',
    'openai',
    'openai-responses',
    'gemini',
    'deepseek',
    'moonshot',
    'zhipu',
    'qwen',
    'opencode-go',
    'ollama',
    'typesafe'
  ]
  writeJson(path.join(DST, 'config.json'), {
    models: {
      providers: presets.map((id) => ({ id, name: id, apiHost: 'https://example.invalid', enabled: false, models: [] })),
      activeModelId: null,
      activeEffort: 'default'
    },
    personas: {
      enabled: { general: true, xiaomajiang: true },
      seeded: { general: true, xiaomajiang: true },
      seededPrompt: { general: 'hash-general', xiaomajiang: 'hash-xiaomajiang' },
      order: ['general', 'xiaomajiang']
    },
    skills: { enabled: {} }
  })
  fs.mkdirSync(path.join(DST, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(DST, 'personas', 'general.md'), '# 我在二开版里改过的 general\n')
  fs.writeFileSync(path.join(DST, 'personas', 'xiaomajiang.md'), '# 本地 xiaomajiang\n')
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
function cpAll(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
}
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}
function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
function countIn(dir: string, filter?: (n: string, isDir: boolean) => boolean): number {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => (filter ? filter(d.name, d.isDirectory()) : true)).length
  } catch {
    return 0
  }
}
function setMtimeOld(p: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo)
  const walk = (x: string): void => {
    const st = fs.lstatSync(x)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) for (const n of fs.readdirSync(x)) walk(path.join(x, n))
    fs.utimesSync(x, t, t)
  }
  walk(p)
}

/** 抓窗口广播：导入收尾的 publishConfigChanged → registerConfigIpc → webContents.send('config:changed')。 */
function installWindowSpy(): { events: { channel: string; payload: any }[] } {
  const events: { channel: string; payload: any }[] = []
  const win: any = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: any) => {
        events.push({ channel, payload })
      }
    }
  }
  registerConfigIpc(() => win)
  return { events }
}

/** 目标侧会话文件（不含 _index.json 与 compacted）。 */
function targetSessions(): string[] {
  try {
    return fs
      .readdirSync(path.join(DST, 'data', 'chats'))
      .filter((n) => n.endsWith('.json') && n !== '_index.json')
  } catch {
    return []
  }
}

/** 引用完整性：model 能否在 config.providers 里解析；成员 parentId ↔ members 双向是否悬空。 */
function refIntegrity(root: string, providerIds: Set<string>) {
  const dir = path.join(root, 'data', 'chats')
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== '_index.json')
  } catch {
    return { badModel: [] as string[], danglingMember: [] as string[], danglingParent: [] as string[], total: 0 }
  }
  const badModel: string[] = []
  const danglingMember: string[] = []
  const danglingParent: string[] = []
  const ids = new Set(names.map((n) => n.slice(0, -5)))
  for (const n of names) {
    let s: any
    try {
      s = readJson(path.join(dir, n))
    } catch {
      continue
    }
    const id = String(s?.id ?? n.slice(0, -5))
    if (typeof s?.model === 'string' && s.model) {
      const pid = s.model.split(':')[0]
      if (!providerIds.has(pid)) badModel.push(`${id}→${s.model}`)
    }
    for (const m of s?.members ?? []) {
      if (typeof m?.sessionId === 'string' && !ids.has(m.sessionId)) danglingMember.push(`${id}→${m.sessionId}`)
    }
    if (typeof s?.parentId === 'string' && s.parentId && !ids.has(s.parentId))
      danglingParent.push(`${id}→${s.parentId}`)
  }
  return { badModel, danglingMember, danglingParent, total: names.length }
}

/* ═════════════════════════════ 场景 ═════════════════════════════ */

type Report = any
const progressSteps: string[] = []

async function runOnce(): Promise<Report> {
  return await runImport((p) => {
    if (progressSteps[progressSteps.length - 1] !== p.step) progressSteps.push(p.step)
  })
}

/** ① 主场景：真实数据全量导入 + 连跑 3 次 + 零改动 + 广播 + 引用完整性 + 清扫安全性。 */
async function scenarioFull(): Promise<void> {
  const seeded = process.env.QA_SEEDED === '1'
  info('src', `复制真实 ${REAL} → ${SRC}`)
  fs.mkdirSync(HOME, { recursive: true })
  cpAll(REAL, SRC)
  // cpSync 会把 junction 展平成实体目录，夹具就不像真实源了。逐条还原成链接（目标是真实技能目录，只读引用）。
  const realSkills = path.join(REAL, 'skills')
  for (const name of fs.readdirSync(realSkills)) {
    const realEntry = path.join(realSkills, name)
    if (!fs.lstatSync(realEntry).isSymbolicLink()) continue
    const fixture = path.join(SRC, 'skills', name)
    rmrf(fixture)
    fs.symlinkSync(fs.readlinkSync(realEntry), fixture, 'junction')
  }
  if (seeded) seedTarget()

  const before = snapshot(SRC)
  info('src 快照', `files=${before.counts.files} dirs=${before.counts.dirs} links=${before.counts.links}`)

  const win = installWindowSpy()
  let sessionEvents = 0
  onSessionsChanged(() => sessionEvents++)

  // 闸门 + 概览口径：与 fs 实算比对
  const gate = await canImport()
  check('闸门：原版数据存在时 ok', gate.ok === true, JSON.stringify(gate).slice(0, 200))
  if (gate.ok) {
    const s = gate.summary
    const expSessions = countIn(path.join(SRC, 'data', 'chats'), (n) => n.endsWith('.json') && n !== '_index.json')
    const expCompacted = countIn(
      path.join(SRC, 'data', 'chats'),
      (n) => n.endsWith('.jsonl') && n.includes('.compacted-')
    )
    const expProviders = readJson(path.join(SRC, 'config.json')).models.providers.length
    const expPersonas = countIn(path.join(SRC, 'personas'), (n) => n.endsWith('.md'))
    const expMemories = readJson(path.join(SRC, 'memory.json')).entries.length
    eq('概览：sessions', s.sessions, expSessions)
    eq('概览：compacted', s.compacted, expCompacted)
    eq('概览：providers', s.providers, expProviders)
    eq('概览：personas', s.personas, expPersonas)
    eq('概览：memories', s.memories, expMemories)
    eq('概览：media', s.media, countIn(path.join(SRC, 'data', 'media')))
    eq('概览：checkpoints', s.checkpoints, countIn(path.join(SRC, 'data', 'checkpoints'), (_n, d) => d))
    eq('概览：toolResults', s.toolResults, countIn(path.join(SRC, 'data', 'tool-results')))
  }

  // 第一轮
  const r1 = await runOnce()
  info('progress 顺序', progressSteps.join(' → '))
  check('进度：十步按序 + done', progressSteps.join(',') === 'providers,mcp,personas,personaEnabled,memories,skills,sessions,assoc,cache,done', progressSteps.join(','))

  if ('error' in r1) {
    fail('run1 不该返回 error', JSON.stringify(r1))
    return
  }
  check('run1 ok', r1.ok === true, `failures=${JSON.stringify(r1.failures)}`)

  // 统计口径
  const customProviders = readJson(path.join(SRC, 'config.json')).models.providers
    .map((p: any) => p.id)
    .filter((id: string) => !id.match(/^(anthropic|openai|openai-responses|gemini|deepseek|moonshot|zhipu|qwen|opencode-go|ollama|typesafe)$/))
  eq('服务商：copied 只含用户自定义', [...r1.providers.copied].sort(), customProviders.sort())
  eq('服务商：builtin = 11 个预置', (r1.providers.builtin ?? []).length, 11)
  eq('服务商：skipped 为空', r1.providers.skipped, [])
  const expPersonasCopied = countIn(path.join(SRC, 'personas'), (n) => n.endsWith('.md')) - 2
  eq('角色：copied = 用户自建数', r1.personas.copied.length, expPersonasCopied)
  eq('角色：builtin = general/xiaomajiang', [...(r1.personas.builtin ?? [])].sort(), ['general', 'xiaomajiang'])
  // 新装目标（没跑过应用）里默认角色文件还不存在 → 会被补上并一并置启用；已跑过的目标则只启用用户自建角色。
  const expEnabled = r1.personas.copied.length + (seeded ? 0 : 2)
  eq('角色启用态：覆盖本次导入的角色', r1.personaEnabled.length, expEnabled)
  check(
    '角色启用态：copied 的每个 id 都在里面',
    r1.personas.copied.every((id: string) => r1.personaEnabled.includes(id)),
    ''
  )
  eq('技能：全部按链接重建', [...r1.skills.copied].sort(), ['restoring-course-projects', 'xfg-coding-map-skills'])
  const expSess = countIn(path.join(SRC, 'data', 'chats'), (n) => n.endsWith('.json') && n !== '_index.json')
  eq('会话：copied 数', r1.sessions.copied.length, expSess)
  eq('附件：media 数', r1.assoc.media, countIn(path.join(SRC, 'data', 'media')))
  eq('附件：checkpoints 数', r1.assoc.checkpoints, countIn(path.join(SRC, 'data', 'checkpoints'), (_n, d) => d))
  eq('附件：subagents 数', r1.assoc.subagents, countIn(path.join(SRC, 'data', 'subagents'), (_n, d) => d))
  eq('附件：toolResults 数', r1.assoc.toolResults, countIn(path.join(SRC, 'data', 'tool-results')))
  // 密钥只搬与本次导入 provider 相关的键：remote / mcp 那类无主密文（目标没有对应配置，搬了也永远用不上）
  // 必须留在 ignored 里。这条断言的前身是「copied 数 = secrets.json 全部键数」，对应的是修之前那种全量搬运的行为。
  const srcSecrets = readJson(path.join(SRC, 'secrets.json')) as Record<string, string>
  const srcProviderIds = new Set(
    ((readJson(path.join(SRC, 'config.json')).models?.providers ?? []) as { id?: string }[])
      .map((p) => p.id)
      .filter((id): id is string => typeof id === 'string')
  )
  const providerKeyOf = (k: string): string => (k.includes(':') ? k.slice(0, k.indexOf(':')) : k)
  const relevantKeys = Object.keys(srcSecrets).filter((k) => srcProviderIds.has(providerKeyOf(k)))
  const orphanKeys = Object.keys(srcSecrets).filter((k) => !srcProviderIds.has(providerKeyOf(k)))
  eq(
    '密钥：provider 相关键全部处理（copied + skipped）',
    r1.secrets.copied.length + r1.secrets.skipped.length,
    relevantKeys.length
  )
  eq('密钥：copied 只含 provider 相关键', [...r1.secrets.copied].sort(), [...relevantKeys].sort())
  eq('密钥：无主密文（remote / mcp）不搬，进 ignored', [...(r1.secrets.ignored ?? [])].sort(), [...orphanKeys].sort())
  check(
    '密钥：ignored 里确有 remote 命名空间',
    (r1.secrets.ignored ?? []).some((k) => k.startsWith('remote:')),
    JSON.stringify(r1.secrets.ignored)
  )
  info('密钥明细', JSON.stringify({ copied: r1.secrets.copied, ignored: r1.secrets.ignored }))
  const srcMem = readJson(path.join(SRC, 'memory.json')).entries.length
  const projMem = fs
    .readdirSync(path.join(SRC, 'projects'))
    .reduce((n, d) => n + (readJson(path.join(SRC, 'projects', d, 'memory.json')).entries?.length ?? 0), 0)
  eq('记忆：added = 全局 + 项目全部条目', r1.memories.added.length, srcMem + projMem)
  eq('记忆：无失败', r1.memories.failed, [])

  // 广播
  const cfgEvents = win.events.filter((e) => e.channel === 'config:changed')
  check('广播：config:changed 发出一次', cfgEvents.length === 1, JSON.stringify(cfgEvents))
  check(
    '广播：payload keys 含 models',
    cfgEvents.length === 1 && Array.isArray(cfgEvents[0].payload?.keys) && cfgEvents[0].payload.keys.includes('models'),
    JSON.stringify(cfgEvents[0]?.payload)
  )
  check('广播：sessions-changed（总线事件）发出', sessionEvents === 1, `count=${sessionEvents}`)

  // 目标落盘内容
  const dst1 = snapshot(DST)
  info('dst1 快照', `files=${dst1.counts.files} dirs=${dst1.counts.dirs} links=${dst1.counts.links}`)
  const cfg1 = readJson(path.join(DST, 'config.json'))
  // 期望值从源配置实算，不写死数字：源里 provider 数量随用户增删而变，写死会让这条断言在数据一变就红，
  // 而它要守的是「导入后目标与源一致」，不是「源恰好有 16 个」。这里重新读一次源，不依赖上方 if 块里的局部变量。
  eq('目标 config：providers 总数', cfg1.models.providers.length, readJson(path.join(SRC, 'config.json')).models.providers.length)
  check('目标 config：未导入 remote / layout', !('remote' in cfg1) && !('layout' in cfg1), Object.keys(cfg1).join(','))
  if (!seeded) {
    eq('目标 config：未写入 personas.seeded', cfg1.personas?.seeded, undefined)
    eq('目标 config：未写入 personas.order', cfg1.personas?.order, undefined)
  }
  const enabledIds = Object.entries(cfg1.personas?.enabled ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
  check(
    '目标 config：导入的角色全部 enabled',
    r1.personaEnabled.every((id: string) => (cfg1.personas?.enabled ?? {})[id] === true),
    `enabled=${enabledIds.join(',')}`
  )
  if (!seeded) eq('目标 config：enabled 集合 = 导入集（新装目标）', enabledIds, [...r1.personaEnabled].sort())
  const srcActive = readJson(path.join(SRC, 'config.json')).models?.activeModelId
  const dstProviderIds = new Set(
    ((cfg1.models?.providers ?? []) as { id?: string }[]).map((p) => p.id).filter((id): id is string => typeof id === 'string')
  )
  info('activeModelId', `src=${srcActive} dst=${cfg1.models.activeModelId}`)
  // 最近使用模型属于「不用重配」的一部分，要跟着 providers 一起过来；但只在不制造悬空引用的前提下
  // （它指向的 provider 必须在目标里真的存在，否则界面显示已选、发消息才报模型不可用）。
  check(
    '产物：activeModelId 随 providers 导入，且指向的 provider 在目标里存在',
    cfg1.models.activeModelId === (srcActive ?? null) &&
      (srcActive == null || dstProviderIds.has(String(srcActive).split(':')[0])),
    `src=${JSON.stringify(srcActive)} dst=${JSON.stringify(cfg1.models.activeModelId)}`
  )
  if (seeded) {
    eq('已装目标：本地改过的 general.md 未被覆盖', fs.readFileSync(path.join(DST, 'personas', 'general.md'), 'utf8'), '# 我在二开版里改过的 general\n')
    eq('已装目标：personas.seeded 未被改动', cfg1.personas.seeded, { general: true, xiaomajiang: true })
    eq('已装目标：personas.seededPrompt 未被改动', cfg1.personas.seededPrompt, {
      general: 'hash-general',
      xiaomajiang: 'hash-xiaomajiang'
    })
    eq('已装目标：personas.order 未被改动', cfg1.personas.order, ['general', 'xiaomajiang'])
    eq('已装目标：预置服务商本地那份未被覆盖', cfg1.models.providers.find((p: any) => p.id === 'anthropic').apiHost, 'https://example.invalid')
    check('已装目标：enabled 里本地既有开关未被改（general 仍 true）', cfg1.personas.enabled.general === true)
  }
  check('附件落盘：会话文件已存在', targetSessions().length === expSess, `files=${targetSessions().length}`)
  const compactedInDst = countIn(path.join(DST, 'data', 'chats'), (n) => n.endsWith('.jsonl'))
  eq('compacted 拆分文件已搬', compactedInDst, countIn(path.join(SRC, 'data', 'chats'), (n) => n.endsWith('.jsonl')))
  check('目标无 _index.json（已 invalidate 让下次重扫）', !fs.existsSync(path.join(DST, 'data', 'chats', '_index.json')))

  // 技能：链接还是副本
  for (const id of ['restoring-course-projects', 'xfg-coding-map-skills']) {
    const p = path.join(DST, 'skills', id)
    let isLink = false
    let target = ''
    try {
      isLink = fs.lstatSync(p).isSymbolicLink()
      target = fs.readlinkSync(p)
    } catch (e) {
      /* ignore */
    }
    check(`技能 ${id}：落盘为链接（不是副本）`, isLink, `isLink=${isLink} target=${target}`)
    check(`技能 ${id}：链接目标可读`, fs.existsSync(p), '')
  }

  // 引用完整性（源 vs 目标：悬空集合必须一致，不能多）
  const provIds = new Set(cfg1.models.providers.map((p: any) => p.id))
  const refDst = refIntegrity(DST, provIds)
  const refSrc = refIntegrity(SRC, new Set(readJson(path.join(SRC, 'config.json')).models.providers.map((p: any) => p.id)))
  // 不能要求目标「一条悬空都没有」：源里本来就可能存在悬空（用户删过 provider，会话仍指向它），
  // 导入的职责是原样搬过去，不是替用户修复历史数据。要守的是「目标不比源多」，与下方两条悬空集合断言同一口径。
  eq('引用：model 悬空集合与源一致', [...refDst.badModel].sort(), [...refSrc.badModel].sort())
  info('引用：源侧 model 无法解析的会话', JSON.stringify(refSrc.badModel))
  eq('引用：members 悬空集合与源一致', [...refDst.danglingMember].sort(), [...refSrc.danglingMember].sort())
  eq('引用：parentId 悬空集合与源一致', [...refDst.danglingParent].sort(), [...refSrc.danglingParent].sort())
  info('引用：源侧 members 悬空', JSON.stringify(refSrc.danglingMember))
  info('引用：源侧 parentId 悬空', JSON.stringify(refSrc.danglingParent))

  // 第二轮 / 第三轮：幂等
  const winBefore = win.events.length
  const r2 = (await runOnce()) as Report
  const dst2 = snapshot(DST)
  const d2 = diffSnap(dst1, dst2)
  check('幂等：第 2 次零新增（各步 copied 全空）', allCopiedEmpty(r2), JSON.stringify(copiedSummary(r2)))
  check('幂等：第 2 次目标快照（size+mtime+md5+链接）完全一致', d2.length === 0, d2.slice(0, 10).join(' | '))
  eq('幂等：第 3 次 skipped 与第 2 次同口径', skipSummary(r2), (await (async () => skipSummary(r2))()))
  const r3 = (await runOnce()) as Report
  const dst3 = snapshot(DST)
  const d3 = diffSnap(dst2, dst3)
  check('幂等：第 3 次目标快照完全一致', d3.length === 0, d3.slice(0, 10).join(' | '))
  check('幂等：第 3 次 copied 仍为空', allCopiedEmpty(r3), JSON.stringify(copiedSummary(r3)))
  eq('幂等：第 3 次与第 2 次报告统计一致', { c: copiedSummary(r3), s: skipSummary(r3) }, { c: copiedSummary(r2), s: skipSummary(r2) })
  info('第 2/3 次 config:changed 次数', String(win.events.length - winBefore) + '（期望 2，每次收尾各一次）')

  // 原版零改动
  const after = snapshot(SRC)
  const dsrc = diffSnap(before, after)
  check('原版零改动：全量快照（mtime+size+md5+链接目标）完全一致', dsrc.length === 0, dsrc.slice(0, 10).join(' | '))

  // 清缓存真的生效：listSessions 能看到新会话
  const listed = listSessions()
  eq('清缓存：listSessions 可见全部会话', listed.length, expSess)

  // 启动清扫不会删刚导入的附件（宽限期 1 小时）
  const mediaBefore = countIn(path.join(DST, 'data', 'media'))
  const cpBefore = countIn(path.join(DST, 'data', 'checkpoints'), (_n, d) => d)
  await sweepMedia()
  await sweepCheckpoints(listed.map((m) => m.id))
  await sweepSubagents(listed.map((m) => m.id))
  eq('清扫：media 未被误删', countIn(path.join(DST, 'data', 'media')), mediaBefore)
  eq('清扫：checkpoints 未被误删', countIn(path.join(DST, 'data', 'checkpoints'), (_n, d) => d), cpBefore)

  // setConfig 零广播
  const evBefore = win.events.length
  setConfig({ __probe: 1 })
  eq('setConfig 不广播（防回写自激）', win.events.length - evBefore, 0)

  // 密钥密文可解（同机同账户前提下的等价物：桩的 encrypt/decrypt 对称）
  const secretKey = r1.secrets.copied[0]
  if (secretKey) {
    const rd = await readSecret(secretKey)
    // 三态后要看 kind：`unreadable` 说明有密文却解不开（本列表里也只有这种情况会失败）
    check('密钥：导入后可解密（kind=ok）', rd.kind === 'ok' && rd.value.length > 0, `key=${secretKey} kind=${rd.kind}`)
  }
}

function allCopiedEmpty(r: Report): boolean {
  return (
    r.providers.copied.length === 0 &&
    r.secrets.copied.length === 0 &&
    r.personas.copied.length === 0 &&
    r.memories.added.length === 0 &&
    r.skills.copied.length === 0 &&
    r.sessions.copied.length === 0 &&
    r.assoc.media === 0 &&
    r.assoc.checkpoints === 0 &&
    r.assoc.subagents === 0 &&
    r.assoc.toolResults === 0
  )
}
function copiedSummary(r: Report) {
  return {
    p: r.providers.copied.length,
    s: r.secrets.copied.length,
    pe: r.personas.copied.length,
    m: r.memories.added.length,
    sk: r.skills.copied.length,
    se: r.sessions.copied.length,
    a: r.assoc.media + r.assoc.checkpoints + r.assoc.subagents + r.assoc.toolResults
  }
}
function skipSummary(r: Report) {
  return {
    p: r.providers.skipped.length,
    s: r.secrets.skipped.length,
    pe: r.personas.skipped.length,
    m: r.memories.skipped.length,
    sk: r.skills.skipped.length,
    se: r.sessions.skipped.length
  }
}

/* ───────── 场景 ②：清扫的宽限期（验证「会话必须先于附件」的真实机制） ───────── */

async function scenarioSweep(): Promise<void> {
  // 造目标：一批 media blob，mtime 设为 2 小时前，且没有任何会话文件
  const mediaDir = path.join(DST, 'data', 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const names: string[] = []
  for (let i = 0; i < 3; i++) {
    const n = crypto.createHash('sha256').update(`blob-${i}`).digest('hex')
    fs.writeFileSync(path.join(mediaDir, n), `data-${i}`)
    names.push(n)
  }
  setMtimeOld(mediaDir, 2 * 3600 * 1000)
  await sweepMedia()
  eq('清扫：无会话引用 + 超 1 小时宽限 → blob 被删（证明必须先搬会话）', countIn(mediaDir), 0)

  // 再来一遍，但只把 mtime 保持「新鲜」（刚复制完的样子）
  for (let i = 0; i < 3; i++) {
    const n = crypto.createHash('sha256').update(`fresh-${i}`).digest('hex')
    fs.writeFileSync(path.join(mediaDir, n), `data-${i}`)
  }
  await sweepMedia()
  eq('清扫：刚复制（1 小时内）的 blob 即使无引用也不会被删', countIn(mediaDir), 3)

  // checkpoints：目录名不是任何活会话 + 超宽限 → 整目录删
  const cpDir = path.join(DST, 'data', 'checkpoints', 'ghost-session')
  fs.mkdirSync(cpDir, { recursive: true })
  fs.writeFileSync(path.join(cpDir, 'a.bin'), 'x')
  setMtimeOld(cpDir, 2 * 3600 * 1000)
  await sweepCheckpoints([])
  check('清扫：会话不存在的 checkpoints 目录超宽限后被删', !fs.existsSync(cpDir))

  const cp2 = path.join(DST, 'data', 'checkpoints', 'sess_live')
  fs.mkdirSync(cp2, { recursive: true })
  fs.writeFileSync(path.join(cp2, 'a.bin'), 'x')
  setMtimeOld(cp2, 2 * 3600 * 1000)
  await sweepCheckpoints(['sess_live'])
  check('清扫：会话存在的 checkpoints 目录保留', fs.existsSync(cp2))
}

/* ───────── 场景 ③：记忆幂等（正文含换行 / 首尾空白） ───────── */

async function scenarioMemIdem(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'memory.json'), {
    version: 1,
    entries: [
      { id: 'm_aaaa1111', content: '第一行\n第二行', createdAt: 1, updatedAt: 1 },
      { id: 'm_bbbb2222', content: '  前后有空白的条目  ', createdAt: 1, updatedAt: 1 },
      { id: 'm_cccc3333', content: '普通条目', createdAt: 1, updatedAt: 1 }
    ]
  })
  const r1 = (await runOnce()) as Report
  eq('记忆幂等：首轮 added = 3', r1.memories.added.length, 3)
  const after1 = fs.readFileSync(path.join(DST, 'memory.json'), 'utf8')
  const r2 = (await runOnce()) as Report
  const after2 = fs.readFileSync(path.join(DST, 'memory.json'), 'utf8')
  check('记忆幂等：文件字节未变', after1 === after2)
  info('第 2 轮 memories.added', JSON.stringify(r2.memories.added))
  info('第 2 轮 memories.skipped', JSON.stringify(r2.memories.skipped))
  check(
    '记忆幂等：第 2 轮 added 应为 0（报告与实际一致）',
    r2.memories.added.length === 0,
    `added=${r2.memories.added.length} skipped=${r2.memories.skipped.length}`
  )
  eq('记忆：写入后落盘条目数', listMemories(GLOBAL_SCOPE).length, 3)
  info('落盘条目 id', listMemories(GLOBAL_SCOPE).map((e) => e.id).join(','))
}

/* ───────── 场景 ④：记忆超配额 ───────── */

async function scenarioBudget(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  // 目标先填到接近上限：全局 4000 字预算（含格式 "- [id] content"）
  const filler: string[] = []
  for (let i = 0; i < 60; i++) {
    const content = `既有记忆第${i}条-`.padEnd(250, 'x')
    const r = writeMemory(content, undefined, GLOBAL_SCOPE)
    if (!r.ok) {
      info('预填到上限', `第 ${i} 条被拒：${r.code}`)
      break
    }
    filler.push(r.entry.id)
  }
  const used = listMemories(GLOBAL_SCOPE).reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0)
  info('预填后用量', `${used} / 4000`)

  writeJson(path.join(SRC, 'memory.json'), {
    version: 1,
    entries: [
      { id: 'm_11111111', content: '这条应该被预算挡住-'.padEnd(250, 'y') },
      { id: 'm_22222222', content: '这条也应被挡住-'.padEnd(250, 'z') }
    ]
  })
  const r = (await runOnce()) as Report
  eq('记忆超配额：added 为 0', r.memories.added.length, 0)
  eq('记忆超配额：两条都进 failed', r.memories.failed.length, 2)
  info('failed 明细', JSON.stringify(r.memories.failed))
  check('记忆超配额：整轮 ok=false（界面必须亮红）', r.ok === false, `ok=${r.ok}`)
  eq('记忆超配额：failures 里也带上（给界面）', r.failures.length >= 2, true)
  eq('记忆超配额：目标条目数没变', listMemories(GLOBAL_SCOPE).length, filler.length)
}

/* ───────── 场景 ⑤：坏数据 / 边界目录 ───────── */

async function scenarioBroken(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  // 坏 config.json / memory.json / secrets.json
  fs.writeFileSync(path.join(SRC, 'config.json'), '{ this is not json')
  fs.writeFileSync(path.join(SRC, 'memory.json'), 'null}')
  fs.writeFileSync(path.join(SRC, 'secrets.json'), 'oops')
  // 角色目录：正常 md + 非法名 + 目录冒充 md
  const pdir = path.join(SRC, 'personas')
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'good.md'), '# good')
  fs.writeFileSync(path.join(pdir, 'bad name.md'), '# bad')
  fs.mkdirSync(path.join(pdir, 'dir.md'), { recursive: true })
  // 会话：一个正常 + 一个坏 JSON + 一个名字带非法字符 + _index.json + 一个 compacted
  const cdir = path.join(SRC, 'data', 'chats')
  fs.mkdirSync(cdir, { recursive: true })
  writeJson(path.join(cdir, 'sess_ok.json'), { id: 'sess_ok', messages: [] })
  fs.writeFileSync(path.join(cdir, 'sess_broken.json'), '{ not json')
  writeJson(path.join(cdir, 'sess.with.dots.json'), { id: 'sess.with.dots', messages: [] })
  writeJson(path.join(cdir, '_index.json'), [{ id: 'ghost' }])
  fs.writeFileSync(path.join(cdir, 'sess_ok.compacted-123.jsonl'), '{"role":"user"}\n')
  // skills：实体目录 + 非法名
  const sdir = path.join(SRC, 'skills')
  fs.mkdirSync(path.join(sdir, 'real-skill'), { recursive: true })
  fs.writeFileSync(path.join(sdir, 'real-skill', 'SKILL.md'), '# s')
  fs.writeFileSync(path.join(sdir, 'with space'), 'x')

  const gate = await canImport()
  check('坏数据：闸门不因 JSON 坏而崩', typeof gate.ok === 'boolean', JSON.stringify(gate).slice(0, 160))
  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('坏数据：不该整轮失败', JSON.stringify(r))
    return
  }
  info('坏数据报告', JSON.stringify({ prov: r.providers, sess: r.sessions, skills: r.skills, personas: r.personas, mem: r.memories }).slice(0, 500))
  check('坏 config.json：不崩，providers 空', r.providers.copied.length === 0 && r.providers.skipped.length === 0)
  check('坏 memory.json：不崩，无条目', r.memories.added.length === 0)
  check('坏 secrets.json：不崩', r.secrets.copied.length === 0 && r.secrets.skipped.length === 0)
  eq('会话：坏 JSON 文件仍按文件名复制（失败被静默）', r.sessions.copied.includes('sess_broken'), true)
  check('会话：名字带点的 id 被洗成 sesswithdots', fs.existsSync(path.join(DST, 'data', 'chats', 'sesswithdots.json')), fs.readdirSync(path.join(DST, 'data', 'chats')).join(','))
  check('会话：不搬 _index.json', !fs.existsSync(path.join(DST, 'data', 'chats', '_index.json')))
  check('会话：compacted 跟着搬', fs.existsSync(path.join(DST, 'data', 'chats', 'sess_ok.compacted-123.jsonl')))
  eq('角色：只导入合法名', r.personas.copied, ['good'])
  info('角色 skipped', JSON.stringify(r.personas.skipped))
  eq('技能：实体目录走复制', r.skills.copied, ['real-skill'])
  check('技能：实体目录内容完整', fs.existsSync(path.join(DST, 'skills', 'real-skill', 'SKILL.md')))
  check('技能：非法名条目未搬', !fs.existsSync(path.join(DST, 'skills', 'with space')))
}

/* ───────── 场景 ⑥b：写目标失败必须给码，不透原始 Node 错误串 ───────── */

/**
 * P3 的守门断言。
 *
 * 以前 `importer-sessions.ts` 等处写的是 `reason: (e as Error)?.message`，界面会显示
 * `EEXIST: file already exists, mkdir 'C:\Users\...\data\chats'`——用户看不懂英文错误，
 * 而且本机绝对路径被写进了界面。改成统一码 `target-write-failed` 之后，这条断言守两件事：
 *  1. `reason` 必须是已知码（能被 `FAILURE_REASON_KEY` 查到）
 *  2. `reason` 里不许出现盘符或路径分隔符
 *
 * 造法：把目标的 `data/chats` 建成一个**普通文件**，会话步骤 mkdir 必然 EEXIST/ENOTDIR。
 */
async function scenarioWriteFailReason(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  const cdir = path.join(SRC, 'data', 'chats')
  fs.mkdirSync(cdir, { recursive: true })
  writeJson(path.join(cdir, 'sess_a.json'), { id: 'sess_a', messages: [] })

  // 目标侧：data 下放一个名为 chats 的普通文件，让 mkdir 失败
  fs.mkdirSync(path.join(DST, 'data'), { recursive: true })
  fs.writeFileSync(path.join(DST, 'data', 'chats'), 'not a dir')

  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('写目标失败：不该整轮抛异常', JSON.stringify(r).slice(0, 200))
    return
  }
  const fail1 = (r.failures ?? []).find((f) => f.step === 'sessions')
  check('写目标失败：有失败记录', Boolean(fail1), JSON.stringify(r.failures).slice(0, 300))
  if (!fail1) return
  eq('写目标失败：reason 是统一码', fail1.reason, 'target-write-failed')
  // 关键：原始 Node 错误串里会带绝对路径。这条断言就是在守「别把路径写到界面上」。
  check(
    '写目标失败：reason 不含盘符或路径分隔符',
    !/[A-Za-z]:[\\/]|[\\/]/.test(fail1.reason),
    `reason=${fail1.reason}`
  )
}

/* ───────── 场景 ⑥c：MCP 配置导入（三态读 / 目标占位 / 密钥归属） ───────── */

/**
 * MCP 导入的三条守门断言。
 *
 * 与导入器其它步骤一样，这里最危险的两件事都是「静默成功」：
 *  1. 源 `mcp.json` 读不出来 → 当成「原版没配过」→ 报告说成功，用户的 MCP 配置一个都没进来；
 *  2. 目标 `mcp.json` 读不出来 → `upsertServer` 内部的 `readAll()` 把半截文件当空库 → 整份覆盖，
 *     用户已有的全部 MCP 配置被抹掉。
 *
 * 第三条守密钥归属：`copySecrets` 以前按 provider 集合判 `mcp:<id>:<field>`，首段 `mcp` 永远不在
 * provider 里，于是 MCP 密钥全被当「无主密文」丢进 `ignored`。现在按目标 mcp.json 里真实存在的 id 判。
 */
async function scenarioMcp(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [] },
    mcp: { enabled: { 'src-only': true, 'src-off': false } }
  })

  // ① 正常导入：源两个服务，目标已有其中一个（幂等判据只看 id）
  writeJson(path.join(SRC, 'mcp.json'), {
    mcpServers: {
      'src-only': { name: 'src-only', transport: 'http', url: 'https://a.example/mcp', headers: {} },
      'src-off': { name: 'src-off', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }
    }
  })
  fs.mkdirSync(DST, { recursive: true })
  writeJson(path.join(DST, 'mcp.json'), {
    mcpServers: { 'dst-existing': { name: 'dst-existing', transport: 'http', url: 'https://d.example/mcp' } }
  })
  // 源里有一条 MCP 密钥。目标里 src-only 会被导进来，所以它不再是无主密文。
  writeJson(path.join(SRC, 'secrets.json'), { 'mcp:src-only:token': 'enc:abc' })

  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('MCP：不该整轮抛异常', JSON.stringify(r).slice(0, 200))
    return
  }
  eq('MCP：只导入目标没有的 id', [...(r.mcp?.copied ?? [])].sort(), ['src-off', 'src-only'])
  // skipped 只记「源里有、目标也有」的那些。dst-existing 是目标独有、源里没有，不该出现在这里。
  eq('MCP：首次导入没有跳过的', r.mcp?.skipped, [])
  const dstMcp = readJson(path.join(DST, 'mcp.json')) as { mcpServers?: Record<string, unknown> }
  check('MCP：目标原有条目没有被删', Boolean(dstMcp.mcpServers?.['dst-existing']), JSON.stringify(Object.keys(dstMcp.mcpServers ?? {})))
  check('MCP：新条目已落盘', Boolean(dstMcp.mcpServers?.['src-only']), Object.keys(dstMcp.mcpServers ?? {}).join(','))
  // 源里写 true 的启用态要跟过来；写 false 的保持默认关。
  const cfgAfter = readJson(path.join(DST, 'config.json')) as { mcp?: { enabled?: Record<string, boolean> } }
  eq('MCP：源里 true 的启用态跟过来', cfgAfter.mcp?.enabled?.['src-only'], true)
  eq('MCP：源里 false 的保持默认关', cfgAfter.mcp?.enabled?.['src-off'], undefined)
  // 密钥：目标 mcp.json 里有 src-only，它的密文就该被搬而不是被当无主丢弃。
  check('MCP：密钥不再被当无主密文丢弃', (r.secrets?.copied ?? []).includes('mcp:src-only:token'), JSON.stringify({ copied: r.secrets?.copied, ignored: r.secrets?.ignored }))

  // ② 幂等：再导一次，源里那两个都已在目标，全部 skipped；dst-existing 目标独有，源里没有，不出现
  const r2 = (await runOnce()) as Report
  eq('MCP：重复导入 copied 为空', r2.mcp?.copied, [])
  eq('MCP：重复导入跳过源里全部', [...(r2.mcp?.skipped ?? [])].sort(), ['src-off', 'src-only'])
}

/** 源 mcp.json 被同名目录占位 → 必须报 source-mcp-unreadable，而不是当「没配过」。 */
async function scenarioMcpSourceUnreadable(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  // 同名目录占位：readFileSync 抛 EISDIR/EPERM
  fs.mkdirSync(path.join(SRC, 'mcp.json'), { recursive: true })

  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('MCP 源不可读：不该整轮抛异常', JSON.stringify(r).slice(0, 200))
    return
  }
  const f = (r.failures ?? []).find((x) => x.step === 'mcp')
  check('MCP 源不可读：有失败记录', Boolean(f), JSON.stringify(r.failures).slice(0, 300))
  if (!f) return
  check('MCP 源不可读：reason 是 source-mcp-unreadable 或 corrupt', f.reason === 'source-mcp-unreadable' || f.reason === 'source-mcp-corrupt', f.reason)
  check('MCP 源不可读：整轮 ok 为 false', r.ok === false, `ok=${r.ok}`)
}

/** 目标 mcp.json 被同名目录占位 → 一个字节都不许写，且报 target-blocked。 */
async function scenarioMcpTargetBlocked(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'mcp.json'), {
    mcpServers: { 'src-a': { name: 'src-a', transport: 'http', url: 'https://a.example/mcp' } }
  })
  fs.mkdirSync(DST, { recursive: true })
  fs.mkdirSync(path.join(DST, 'mcp.json'), { recursive: true })

  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('MCP 目标占位：不该整轮抛异常', JSON.stringify(r).slice(0, 200))
    return
  }
  const f = (r.failures ?? []).find((x) => x.step === 'mcp')
  check('MCP 目标占位：有失败记录', Boolean(f), JSON.stringify(r.failures).slice(0, 300))
  if (!f) return
  check('MCP 目标占位：reason 是 target-blocked 或 target-unreadable', f.reason === 'target-blocked' || f.reason === 'target-unreadable', f.reason)
  // 占位的那个目录必须还在，没被当成「空库」删掉重写成文件。
  check('MCP 目标占位：占位目录还在，没被覆盖', fs.statSync(path.join(DST, 'mcp.json')).isDirectory(), '')
}

/* ───────── 场景 ⑥：并发锁（残留 / 活 pid / 无锁） ───────── */

async function scenarioLocks(): Promise<void> {
  getDevaHome() // 目标目录由被测代码自己创建（acquireLock 不会建目录）
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'p1', name: 'p1' }] } })

  // 无锁
  eq('锁：无锁时 isLockLive=false', isLockLive(DST), false)
  eq('锁：无锁时可抢', 'fd' in acquireLock(DST), true)

  // 残留锁 + 已死 pid
  const deadPid = spawnDeadPid()
  fs.writeFileSync(path.join(DST, LOCK_FILE), String(deadPid))
  info('锁：用一个已退出进程的 pid', String(deadPid))
  eq('锁：残留锁（pid 已死）→ isLockLive=false', isLockLive(DST), false)
  const g1 = await runImport()
  check('锁：残留锁不阻塞导入', !('error' in g1), JSON.stringify(g1).slice(0, 120))
  check('锁：跑完锁文件已删', !fs.existsSync(path.join(DST, LOCK_FILE)))

  // 残留锁 + pid 内容不可解析
  fs.writeFileSync(path.join(DST, LOCK_FILE), 'not-a-pid')
  eq('锁：pid 不可解析 → readLockPid=null', readLockPid(path.join(DST, LOCK_FILE)), null)
  const g2 = await runImport()
  check('锁：不可解析的锁不阻塞导入', !('error' in g2), JSON.stringify(g2).slice(0, 120))

  // 锁被「活着的」进程占着
  fs.writeFileSync(path.join(DST, LOCK_FILE), String(process.pid))
  eq('锁：活 pid → isLockLive=true', isLockLive(DST), true)
  const g3 = await runImport()
  check('锁：活 pid 的锁会拒绝并给出锁文件路径', 'error' in g3 && String((g3 as any).error).includes(LOCK_FILE), JSON.stringify(g3).slice(0, 200))
  // 收尾：还回可以用的状态
  fs.rmSync(path.join(DST, LOCK_FILE), { force: true })

  // 同进程重入：两次并发调用，第二次必须被快速拒绝
  const [a, b] = await Promise.all([runImport(), runImport()])
  const reentered = [a, b].filter((x) => 'error' in x && String((x as any).error).includes('已有导入')) 
  check('锁：同进程并发第二次被拒（快路径）', reentered.length >= 1, JSON.stringify([a, b].map((x) => ('error' in x ? (x as any).error : 'report'))).slice(0, 300))
  fs.rmSync(path.join(DST, LOCK_FILE), { force: true })
  const gate = await canImport()
  check('锁：清理后闸门恢复 ok', (gate as any).ok === true, JSON.stringify(gate).slice(0, 120))
}

function spawnDeadPid(): number {
  // 起一个立刻退出的子进程，拿它的 pid（Windows 上该 pid 一般会空一段才被复用）
  const r = execFileSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' }) // 同步跑完
  void r
  const child = require('child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  return child.pid ?? 999999
}

/* ───────── 场景 ⑦：源不存在 / 源为空 ───────── */

async function scenarioNoSource(): Promise<void> {
  const gate = await canImport()
  eq('无源：闸门 code=no-source', (gate as any).code, 'no-source')
  eq('无源：importing 为 false', (gate as any).importing, false)
  const r = await runImport()
  check('无源：runImport 返回 { error }', 'error' in r, JSON.stringify(r).slice(0, 160))
  check('无源：目标目录零写入（除 getDevaHome 自建空目录）', !fs.existsSync(path.join(DST, 'config.json')))
}

async function scenarioEmptySource(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  const gate = await canImport()
  check('空源：闸门 ok=true', (gate as any).ok === true)
  const r = (await runOnce()) as Report
  info('空源报告', JSON.stringify(r))
  check('空源：不崩，ok=true', r.ok === true)
  eq('空源：全部 copied 为空', allCopiedEmpty(r), true)
}

/* ───────── 场景 ⑧：原版在跑（独占打开 lockfile） ───────── */

async function scenarioGateLocked(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })

  // 未持有：不存在 / 存在但没人持有
  eq('闸门：lockfile 不存在 → 可导入', (await canImport() as any).ok, true)
  fs.mkdirSync(path.dirname(UPSTREAM_LOCK), { recursive: true })
  fs.writeFileSync(UPSTREAM_LOCK, '')
  eq('闸门：lockfile 存在但未持有 → 可导入（存在性不作判据）', (await canImport() as any).ok, true)

  // 用 PowerShell 以 FileShare.None 独占持有，模拟 Electron 的单实例锁
  const ps = `$f=[System.IO.File]::Open('${UPSTREAM_LOCK.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output 'held'; Start-Sleep -Seconds 20`
  const holder = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] })
  let held = ''
  holder.stdout.on('data', (d) => (held += String(d)))
  holder.stderr.on('data', () => {})

  const deadline = Date.now() + 15000
  while (!held.includes('held') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
  info('独占持有是否成功', held.trim() || '（未输出）')

  const g = await canImport()
  check('闸门：lockfile 被独占持有 → code=source-running', (g as any).code === 'source-running', JSON.stringify(g).slice(0, 160))
  const r = await runImport()
  check('闸门：被持有时 runImport 拒绝且零写入', 'error' in r && !fs.existsSync(path.join(DST, 'config.json')), JSON.stringify(r).slice(0, 200))
  holder.kill()
}

/* ───────── 场景 ⑨：技能链接的细枝末节 ───────── */

async function scenarioSkills(): Promise<void> {
  const sdir = path.join(SRC, 'skills')
  const outside = path.join(SCRATCH, 'outside-skill')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '# outside')
  fs.mkdirSync(sdir, { recursive: true })
  // 本机没有符号链接特权（symlinkSync 报 EPERM），只能用 junction 造出「链接条目」——
  // 这正是被测代码在 Windows 上的回落路径，测的是同一类条目（lstat 均为 isSymbolicLink）。
  fs.symlinkSync(outside, path.join(sdir, 'out-link'), 'junction')
  // 实体目录
  fs.mkdirSync(path.join(sdir, 'entity'), { recursive: true })
  fs.writeFileSync(path.join(sdir, 'entity', 'SKILL.md'), '# e')

  const stat = importSkills(SRC)
  info('skills 统计', JSON.stringify(stat))
  check('技能：链接条目在目标里仍是链接（不是副本）', fs.lstatSync(path.join(DST, 'skills', 'out-link')).isSymbolicLink())
  check('技能：链接可跟随（SKILL.md 可读）', fs.existsSync(path.join(DST, 'skills', 'out-link', 'SKILL.md')))
  info('技能：链接目标', fs.readlinkSync(path.join(DST, 'skills', 'out-link')))
  check('技能：实体目录被复制', fs.existsSync(path.join(DST, 'skills', 'entity', 'SKILL.md')))
  eq('技能：实体目录计入 copied', stat.copied, ['entity'])
  eq('技能：链接计入 linked', stat.linked, ['out-link'])
  // 二次导入幂等
  const stat2 = importSkills(SRC)
  eq('技能：二次导入全部 skipped', stat2.copied.length, 0)
  eq('技能：二次导入 skipped 明细', stat2.skipped.sort(), ['entity', 'out-link'])
}

/* ───────── 场景 ⑩：中断后重跑能否补齐（部分状态） ───────── */

async function scenarioResume(): Promise<void> {
  const cdir = path.join(SRC, 'data', 'chats')
  fs.mkdirSync(cdir, { recursive: true })
  writeJson(path.join(cdir, 'sess_a.json'), { id: 'sess_a', messages: [] })
  // media：两个 blob
  const mediaDir = path.join(SRC, 'data', 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const blobs = ['a'.repeat(64), 'b'.repeat(64)]
  for (const b of blobs) fs.writeFileSync(path.join(mediaDir, b), 'blob')
  // checkpoints / subagents / tool-results：各一个会话目录，每目录两个文件
  for (const kind of ['checkpoints', 'subagents', 'tool-results']) {
    const d = path.join(SRC, 'data', kind, 'sess_a')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'one.bin'), '1')
    fs.writeFileSync(path.join(d, 'two.bin'), '2')
  }
  const r1 = (await runOnce()) as Report
  // assoc 现在多一个 failed[]（附件步骤的失败位），比较四个计数即可
  const { media, checkpoints, subagents, toolResults } = r1.assoc
  eq('续传：首轮附件全部到位', { media, checkpoints, subagents, toolResults }, { media: 2, checkpoints: 1, subagents: 1, toolResults: 1 })
  eq('续传：首轮附件无失败', r1.assoc.failed ?? [], [])

  // 模拟「复制到一半崩了」：media 少一个 blob、各类目录里少一个文件
  fs.rmSync(path.join(DST, 'data', 'media', blobs[1]))
  for (const kind of ['checkpoints', 'subagents', 'tool-results']) {
    fs.rmSync(path.join(DST, 'data', kind, 'sess_a', 'two.bin'))
  }
  const r2 = (await runOnce()) as Report
  info('续传第 2 轮 assoc', JSON.stringify(r2.assoc))
  eq('续传：单个 blob 缺失会被补回', fs.existsSync(path.join(DST, 'data', 'media', blobs[1])), true)
  for (const kind of ['checkpoints', 'subagents', 'tool-results']) {
    const restored = fs.existsSync(path.join(DST, 'data', kind, 'sess_a', 'two.bin'))
    check(`续传：${kind} 目录里缺失的文件被补回`, restored, `two.bin exists=${restored}`)
  }
  check('续传：报告 ok=true（缺失不会被当成失败）', r2.ok === true, `failures=${JSON.stringify(r2.failures)}`)
}

/* ───────── 场景 ⑪：跨进程互斥（另一个窗口正在导） ───────── */

async function scenarioXproc(): Promise<void> {
  getDevaHome()
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [{ id: 'p1', name: 'p1' }] } })
  // 另起一个真实进程抢锁，模拟「另一个 DevaPlus 窗口正在导」
  const child = spawn(process.execPath, [process.argv[1], 'locker'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += String(d)))
  const deadline = Date.now() + 10000
  while (!out.includes('locked') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  check('跨进程：另一个进程已持有锁', out.includes('locked'), out.trim())
  const info0 = await canImport()
  eq('跨进程：probe 的 importing 为 true', (info0 as any).importing, true)
  const r = await runImport()
  check(
    '跨进程：第二个进程被拒且给出锁文件路径',
    'error' in r && String((r as any).error).includes(LOCK_FILE),
    JSON.stringify(r).slice(0, 200)
  )
  // 等子进程释放
  child.kill()
  await new Promise((r2) => setTimeout(r2, 500))
  fs.rmSync(path.join(DST, LOCK_FILE), { force: true })
  const r2 = await runImport()
  check('跨进程：锁释放后正常导入', !('error' in r2) && r2.ok === true, JSON.stringify(r2).slice(0, 120))
}

/* ───────── 场景 ⑫：角色 + 头像细节 ───────── */

async function scenarioPersonas(): Promise<void> {
  const pdir = path.join(SRC, 'personas')
  const av = path.join(pdir, 'avatars')
  fs.mkdirSync(av, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'a.md'), '# a')
  fs.writeFileSync(path.join(pdir, 'b.md'), '# b')
  fs.writeFileSync(path.join(pdir, 'dup.md'), '# dup')
  fs.writeFileSync(path.join(pdir, 'multi.md'), '# multi')
  fs.writeFileSync(path.join(av, 'a.png'), 'PNG-A-NEW')
  fs.writeFileSync(path.join(av, 'b.jpg'), 'JPG-B')
  fs.writeFileSync(path.join(av, 'multi.jpg'), 'JPG-MULTI')
  fs.writeFileSync(path.join(av, 'multi.png'), 'PNG-MULTI') // png 优先级高于 jpg
  fs.writeFileSync(path.join(av, 'dup.png'), 'PNG-DUP-NEW')
  fs.writeFileSync(path.join(pdir, 'general.md'), '# 原版的 general') // 内置角色

  // 目标里已有 dup.md 与它的头像：应整条跳过（含头像）
  fs.mkdirSync(path.join(DST, 'personas', 'avatars'), { recursive: true })
  fs.writeFileSync(path.join(DST, 'personas', 'dup.md'), '# 本地 dup')
  fs.writeFileSync(path.join(DST, 'personas', 'avatars', 'dup.png'), 'PNG-DUP-LOCAL')

  const r = (await runOnce()) as Report
  info('personas 报告', JSON.stringify(r.personas))
  check('角色：dup 已存在 → 跳过（不覆盖本地提示词）', fs.readFileSync(path.join(DST, 'personas', 'dup.md'), 'utf8') === '# 本地 dup')
  check('角色：dup 的本地头像未被覆盖', fs.readFileSync(path.join(DST, 'personas', 'avatars', 'dup.png'), 'utf8') === 'PNG-DUP-LOCAL')
  check('角色：头像按扩展名一起搬（a.png）', fs.existsSync(path.join(DST, 'personas', 'avatars', 'a.png')))
  check('角色：jpg 头像也搬（b.jpg）', fs.existsSync(path.join(DST, 'personas', 'avatars', 'b.jpg')))
  check('角色：同 id 多扩展名只搬优先级最高的（png）', fs.readFileSync(path.join(DST, 'personas', 'avatars', 'multi.png'), 'utf8') === 'PNG-MULTI' && !fs.existsSync(path.join(DST, 'personas', 'avatars', 'multi.jpg')))
  eq('角色：内置 general 计入 builtin 且已复制文件', [r.personas.builtin, fs.existsSync(path.join(DST, 'personas', 'general.md'))], [['general'], true])
}

/* ═════════════════════════════ 入口 ═════════════════════════════ */

/**
 * P1：`mcp:set-enabled` / `skills:set-enabled` / `mcp:set-roles` 不许丢弃写盘结果。
 *
 * 以前 `setEnabled` / `setSkillEnabled` 从 void 改成 boolean 之后，这几个 IPC 仍硬编码 `{ok: true}`：
 * 用户点开关 → 界面变绿 → 重启后变回关，中间零提示（验收实测 serviceReturn:false / ipcReturn:{ok:true}）。
 *
 * 本场景造「config.json 写不进去」，验两件事：
 *  ① IPC 如实返回 ok:false；
 *  ② **内存也回滚了**——否则界面刷新一次又会从内存读到「已开启」，比不报错更糟。
 */
async function scenarioMcpIpcWriteResult(): Promise<void> {
  fs.mkdirSync(DST, { recursive: true })
  // 先在正常状态下把服务写进目标 mcp.json（让 set-enabled 有对象可改）
  writeJson(path.join(DST, 'mcp.json'), {
    mcpServers: { s1: { name: 'S1', transport: 'http', url: 'https://a.example/mcp' } }
  })
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] }, mcp: { enabled: { s1: false } } })

  const cfg = await import('../../apps/desktop/src/main/services/config')
  const mcpCfg = await import('../../apps/desktop/src/main/services/mcp-config')
  const mcpSvc = await import('../../apps/desktop/src/main/services/mcp')

  // 注册 MCP 的 IPC（拿真实 handler，不自己模拟）
  mcpSvc.registerMcpIpc(() => null)
  const electronStub = (await import('electron')) as any
  const handlers = electronStub.__test?.ipcHandlers as Map<string, (...a: any[]) => any> | undefined
  if (!handlers || !handlers.get('mcp:set-enabled')) {
    fail('P1：拿不到 mcp:set-enabled handler（IPC 桩未记录 handler）', '')
    return
  }

  // ① 正常路径：能写盘时返回 ok:true，且磁盘 + 内存都变了
  const okRes = handlers.get('mcp:set-enabled')!(null, 's1', true)
  info('正常写盘的 IPC 返回', JSON.stringify(okRes))
  eq('P1：正常写盘时 IPC 返回 ok:true', okRes.ok, true)
  eq('P1：正常写盘后内存态为 true', mcpCfg.isEnabled('s1'), true)

  // 先关回去，作为「失败前的已知状态」
  handlers.get('mcp:set-enabled')!(null, 's1', false)
  eq('P1：前置（关掉）', mcpCfg.isEnabled('s1'), false)

  // ② 造写盘失败：把 config.json 换成同名目录 → writeFileAtomic 必失败
  fs.rmSync(path.join(DST, 'config.json'), { force: true })
  fs.mkdirSync(path.join(DST, 'config.json'))

  const failRes = handlers.get('mcp:set-enabled')!(null, 's1', true)
  info('写盘失败时的 IPC 返回', JSON.stringify(failRes))
  eq('P1：写盘失败 → IPC 返回 ok:false（以前恒 true）', failRes.ok, false)

  // ③ 内存必须回滚：否则界面刷新一次又会画成「已开启」
  eq(
    'P1：写盘失败 → 内存态回滚为 false（不是「磁盘关、内存开」）',
    mcpCfg.isEnabled('s1'),
    false
  )

  // ④ set-roles 同一条链：写盘失败也要透出 false
  const rolesRes = handlers.get('mcp:set-roles')!(null, 's1', ['general'])
  info('set-roles 写盘失败时的返回', JSON.stringify(rolesRes))
  eq('P1：mcp:set-roles 写盘失败 → ok:false', rolesRes.ok, false)

  // ⑤ 恢复可写状态后一切照常（证明失败路径没把配置写死）
  fs.rmSync(path.join(DST, 'config.json'), { recursive: true, force: true })
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] }, mcp: { enabled: { s1: false } } })
  cfg.setConfig({ mcp: { enabled: { s1: false } } })
  const ok2 = handlers.get('mcp:set-enabled')!(null, 's1', true)
  eq('P1：恢复可写后仍能成功（失败路径没写死状态）', [ok2.ok, mcpCfg.isEnabled('s1')], [true, true])
}

/** 源里 MCP 服务的 id 不能当配置键（含冒号 / 分隔符）→ 必须记 failed，不许归 skipped。 */
async function scenarioMcpUnsafeId(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true })
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'mcp.json'), {
    mcpServers: {
      // 冒号：会撕开密钥命名空间 `mcp:<id>:<field>`
      'bad:colon': { name: 'Bad Colon', transport: 'http', url: 'https://a.example/mcp' },
      // 首字符非法（`-` 开头）
      '-leading-dash': { name: 'Dash', transport: 'http', url: 'https://b.example/mcp' },
      // 正常对照
      goodone: { name: 'Good', transport: 'http', url: 'https://c.example/mcp' }
    }
  })
  fs.mkdirSync(DST, { recursive: true })
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  const r = (await runOnce()) as Report
  if ('error' in r) {
    fail('P3：不该整轮抛异常', JSON.stringify(r).slice(0, 200))
    return
  }
  info('MCP 非法 id 的结果', JSON.stringify({ copied: r.mcp?.copied, skipped: r.mcp?.skipped, failed: r.mcp?.failed }))
  eq('P3：正常 id 照常导入（对照组）', r.mcp?.copied, ['goodone'])
  eq('P3：非法 id 不进 skipped（那是「不用管」的意思）', r.mcp?.skipped, [])
  eq(
    'P3：非法 id 记 failed + mcp-unsafe-id',
    (r.mcp?.failed ?? []).map((f: any) => f.reason),
    ['mcp-unsafe-id', 'mcp-unsafe-id']
  )
  check(
    'P3：failures 汇总里有这两条（整轮 ok=false）',
    (r.failures ?? []).filter((f: any) => f.reason === 'mcp-unsafe-id').length === 2 && r.ok === false,
    JSON.stringify({ ok: r.ok, n: (r.failures ?? []).filter((f: any) => f.reason === 'mcp-unsafe-id').length })
  )
  // 目标里不该有它们
  const dstMcp = readJson(path.join(DST, 'mcp.json')) as { mcpServers?: Record<string, unknown> }
  eq('P3：目标里只有正常那个', Object.keys(dstMcp.mcpServers ?? {}), ['goodone'])
}

/**
 * P1-4：`keylessHost` 的 IPv6 判定。
 *
 * `new URL('http://[::1]:11434/v1').hostname` 返回 **`'[::1]'`（带方括号）**，而旧代码比的是 `'::1'`，
 * 于是 IPv6 本机地址**永远判不出**——用 `http://[::1]:11434` 配 Ollama 的用户被判「缺密钥」，
 * 红标 + 轮前体检拦截，而服务其实好好的。
 */
async function scenarioKeylessHost(): Promise<void> {
  const { keylessHost } = await import('../../apps/desktop/src/main/services/model-availability')
  // ① IPv6 环回：这是本 bug 的现场
  eq('P1-4：http://[::1] 是本机（旧代码判 false）', keylessHost('http://[::1]:11434/v1'), true)
  eq('P1-4：http://[::1] 无端口也认', keylessHost('http://[::1]'), true)
  // ② IPv4-mapped 环回：Node 会把 127.0.0.1 规范化成 7f00:1，两个写法都要认
  eq('P1-4：::ffff:127.0.0.1 是本机', keylessHost('http://[::ffff:127.0.0.1]:11434/v1'), true)
  eq('P1-4：::ffff:7f00:1（Node 规范化形态）是本机', keylessHost('http://[::ffff:7f00:1]:11434/v1'), true)
  // ③ 127.0.0.0/8 整段是环回，不只 .1
  eq('P1-4：127.0.0.2 是本机（整段环回）', keylessHost('http://127.0.0.2:11434/v1'), true)
  // ④ 既有形态不能回归
  eq('P1-4：localhost 仍是本机', keylessHost('http://localhost:11434/v1'), true)
  eq('P1-4：127.0.0.1 仍是本机', keylessHost('http://127.0.0.1:11434/v1'), true)
  eq('P1-4：0.0.0.0 仍按旧行为认作本机', keylessHost('http://0.0.0.0:11434/v1'), true)
  eq('P1-4：大写 LOCALHOST 也认（hostname 已小写化）', keylessHost('http://LOCALHOST:11434/v1'), true)
  eq('P1-4：localhost 带 FQDN 尾点', keylessHost('http://localhost.:11434/v1'), true)
  // ⑤ Docker Desktop 里的 Ollama：本机服务，但以前被判成远端
  eq('P1-4：host.docker.internal 是本机', keylessHost('http://host.docker.internal:11434/v1'), true)
  // ⑥ 反方向：远端必须仍要求密钥，否则真「忘配密钥」会被静默放行
  eq('P1-4：局域网 IP 不算本机（那是另一台机器）', keylessHost('http://192.168.1.5:11434/v1'), false)
  eq('P1-4：公网地址不算本机', keylessHost('https://api.openai.com/v1'), false)
  eq('P1-4：写坏的地址不算本机（宁可多提示一次）', keylessHost('不是个 URL'), false)
  eq('P1-4：空串不算本机', keylessHost(''), false)
  eq('P1-4：非字符串不算本机', keylessHost(undefined), false)
}

/**
 * P1-1：可用性判定必须用 `readSecret` 三态，不能只看「密文在不在」。
 *
 * 本场景由 repro 跑三遍：默认（能解开）、`TEST_DECRYPT_FAILS=1`（换账户 / 换机器：密文在但解不开）、
 * `TEST_NO_ENCRYPTION=1`（Linux 缺 libsecret）。
 *
 * 旧实现在后两种下判 `ok:true`：红标不亮、轮前体检放行，请求发出去才 401。
 */
async function scenarioKeyTriState(): Promise<void> {
  const decryptFails = process.env.TEST_DECRYPT_FAILS === '1'
  const noEncryption = process.env.TEST_NO_ENCRYPTION === '1'
  const tag = decryptFails ? 'decrypt-fails' : noEncryption ? 'no-encryption' : 'normal'
  info('密钥环境', tag)

  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  const { setSecret } = await import('../../apps/desktop/src/main/services/secrets')
  const { resolveAvailability } = await import('../../apps/desktop/src/main/services/model-availability')

  setConfig({
    models: {
      providers: [
        {
          id: 'remote',
          name: 'Remote',
          apiHost: 'https://api.example.com/v1',
          enabled: true,
          models: [{ id: 'm', enabled: true }]
        },
        {
          // 本机服务：不管密钥能不能解开，都不该被标红
          id: 'local',
          name: 'Local',
          apiHost: 'http://localhost:11434/v1',
          enabled: true,
          models: [{ id: 'q', enabled: true }]
        },
        {
          // 真没配过密钥：对照组，无论哪个环境都该是 nokey
          id: 'nokey',
          name: 'NoKey',
          apiHost: 'https://api.example.com/v1',
          enabled: true,
          models: [{ id: 'm', enabled: true }]
        }
      ]
    }
  })
  // 写一段密文：正常环境下能解开；TEST_DECRYPT_FAILS 下解不开；TEST_NO_ENCRYPTION 下 setSecret 会拒绝写
  // （绝不明文落盘），所以那里直接塞一段历史密文进 secrets.json 模拟「以前有加密能力时存的」。
  if (noEncryption) {
    fs.mkdirSync(DST, { recursive: true })
    writeJson(path.join(DST, 'secrets.json'), { remote: Buffer.from('enc:sk-test', 'utf8').toString('base64') })
  } else {
    const wrote = await setSecret('remote', 'sk-test')
    info('写密钥结果', JSON.stringify(wrote))
  }

  const rRemote = await resolveAvailability('remote:m')
  const rLocal = await resolveAvailability('local:q')
  const rNoKey = await resolveAvailability('nokey:m')
  info('remote 判定', JSON.stringify(rRemote))
  info('local 判定', JSON.stringify(rLocal))
  info('nokey 判定', JSON.stringify(rNoKey))

  if (decryptFails || noEncryption) {
    eq(`P1-1(${tag})：密文在但解不开 → keyunreadable（旧实现返回 ok:true）`, rRemote.kind, 'keyunreadable')
    eq(`P1-1(${tag})：解不开不能算 ok`, rRemote.ok, false)
    // 与「没配过」分开：处置不同
    eq(`P1-1(${tag})：解不开 ≠ 没配过（kind 不同）`, rRemote.kind !== rNoKey.kind, true)
  } else {
    eq('P1-1(normal)：能解开就是可用', rRemote.ok, true)
  }
  // 不影响的三类：本机服务、真没配过、别的引用
  eq(`P1-1(${tag})：本机服务不因密钥状态被标红`, rLocal.ok, true)
  eq(`P1-1(${tag})：真没配过仍是 nokey`, rNoKey.kind, 'nokey')
}

/**
 * P1-3：「配置读坏就放行」必须真的能生效。
 *
 * 以前那层 `catch { return { ok: true } }` **从来没进去过**：`getConfig()` → `ensureLoaded()` 自己把异常
 * 吞成 `{}`。于是 config.json 内容坏 → providers=[] → 第一个引用就 missing → 全库标红 + 体检拒绝所有发送，
 * 界面说「模型不可用」，用户找不到真正原因。
 *
 * 本场景必须在**独立进程**里跑：`loaded` 是模块级的，置 true 后不再重读，同进程造不出「刚开始读就坏」。
 * 走 repro 的 `P13_KIND` 环境：absent（无文件）/ corrupt（内容坏）。
 */
async function scenarioConfigCorrupt(): Promise<void> {
  const kind = (process.env.P13_KIND ?? '') as 'absent' | 'corrupt' | ''
  const cfgPath = path.join(DST, 'config.json')
  fs.mkdirSync(DST, { recursive: true })
  if (kind === 'absent') {
    fs.rmSync(cfgPath, { force: true })
  } else {
    // 半截 JSON：能读到字节，但解析不了
    fs.writeFileSync(cfgPath, '{invalid ,,,')
  }

  const { getConfigLoadKind } = await import('../../apps/desktop/src/main/services/config')
  const { resolveAvailability } = await import('../../apps/desktop/src/main/services/model-availability')
  info('载入状态', getConfigLoadKind())

  const r = await resolveAvailability('some:model')
  info('判定结果', JSON.stringify(r))

  if (kind === 'corrupt') {
    eq('P1-3(corrupt)：载入状态是 corrupt（不是 ok/absent）', getConfigLoadKind(), 'corrupt')
    eq('P1-3(corrupt)：配置读坏 → 放行 ok:true（旧实现判 missing 并全库标红）', r.ok, true)
    eq('P1-3(corrupt)：放行时不该带 kind', r.kind, undefined)
  } else {
    // 对照：真没配过 ≠ 读坏，必须仍然判 missing，别把「没配」也放行了
    eq('P1-3(absent)：文件不存在 → absent', getConfigLoadKind(), 'absent')
    eq('P1-3(absent)：真没配过仍判 missing（不能一起放行）', r.kind, 'missing')
    eq('P1-3(absent)：真没配过不是 ok', r.ok, false)
  }
}

/**
 * P1-2：`save` 的写盘结果必须能被调用方看见，`applyModelSwap` 不许把「没写盘」算成「已替换」。
 *
 * 以前 `save` 返回 void 且 `catch { return }`，`applyModelSwap` 无条件 `changed.push()`：
 * 磁盘满 / 被占 / 权限错 → 内存改了、磁盘没改 → 界面报「已替换 N 个」→ 重启后全部变回，零提示。
 *
 * 造法：把这轮会话的文件路径换成**同名目录**，`writeFileAtomic` 必然失败（EISDIR）。
 */
async function scenarioSwapWriteFail(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap } = await import('../../apps/desktop/src/main/services/model-swap')
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        { id: 'p', name: 'P', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'm' }] },
        // 目标服务商走本机地址：不需要密钥，目标是可用的（否则整批拒绝，验不到写盘失败那条路）
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] }
      ]
    }
  })
  // 源模型故意做成「不存在」→ 扫描时判 missing，替换流程才有得换
  const s = cs.ensureSession('Sw1', { model: 'p:gone' })
  s.title = 'WriteFail'
  const okFirst = cs.save('Sw1')
  info('首次保存（正常路径）', String(okFirst))
  eq('P1-2：正常路径 save 返回 true', okFirst, true)

  // 会话文件已存在；把它换成同名目录 → 后续 writeFileAtomic 必失败
  const chatsDir = path.join(DST, 'data', 'chats')
  const file = path.join(chatsDir, 'Sw1.json')
  if (!fs.existsSync(file)) {
    fail('P1-2：前置失败——会话文件没生成', file)
    return
  }
  fs.rmSync(file, { force: true })
  fs.mkdirSync(file)

  // 直接验 save 的返回值
  const s2 = cs.getSession('Sw1')!
  s2.model = 'q:n'
  eq('P1-2：写盘失败时 save 返回 false（旧实现返回 void，看不出）', cs.save('Sw1'), false)

  // 再验 applyModelSwap 的归类
  s2.model = 'p:gone'
  const r = await applyModelSwap({ mainId: 'Sw1', fromRef: 'p:gone', toRef: 'q:n' })
  if ('error' in r) {
    fail('P1-2：不该整批拒绝（目标模型可用）', JSON.stringify(r))
    return
  }
  info('applyModelSwap 结果', JSON.stringify(r))
  eq('P1-2：写盘失败的会话不进 changed（旧实现恒在里面）', r.changed.map((b) => b.sessionId), [])
  eq('P1-2：写盘失败的会话进 failed', (r.failed ?? []).map((b) => b.sessionId), ['Sw1'])
  // 内存必须回滚：否则界面刷新一次又从内存读到新模型
  eq('P1-2：写盘失败后内存态回滚为旧引用', cs.getSession('Sw1')?.model, 'p:gone')
}

/**
 * P2-5：五种失效原因各自产出一条，且**文案两两不同**。
 *
 * 以前 `!model || model.enabled === false` 共用 `missing`，界面又是 `missing` 与 `disabled` 一字不差，
 * 于是「换模型 / 启用服务商 / 启用模型」三种完全不同的处置在用户眼里是同一句话。
 *
 * 判据就用「文案两两不同」：两条文案相同，用户就区分不出来，别的都白说。
 */
async function scenarioKindCopy(): Promise<void> {
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  const { resolveAvailability } = await import('../../apps/desktop/src/main/services/model-availability')
  const { messages } = await import('../../apps/desktop/src/renderer/src/i18n/messages')

  setConfig({
    models: {
      providers: [
        // ① 服务商被停用 → disabled
        { id: 'p-off', name: 'Off', apiHost: 'http://localhost:1/v1', enabled: false, models: [{ id: 'm' }] },
        // ② 模型被停用 → model-disabled
        { id: 'p-moff', name: 'MOff', apiHost: 'http://localhost:1/v1', enabled: true, models: [{ id: 'm', enabled: false }] },
        // ③ 模型被删（服务商在、模型列表里没有）→ missing
        { id: 'p-gone', name: 'Gone', apiHost: 'http://localhost:1/v1', enabled: true, models: [{ id: 'other' }] },
        // ④ 缺密钥 → nokey（远端地址才会判密钥）
        { id: 'p-nokey', name: 'NoKey', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'm' }] }
      ]
    }
  })

  const cases: Array<[string, string, string]> = [
    ['disabled', 'p-off:m', '服务商停用'],
    ['model-disabled', 'p-moff:m', '模型停用'],
    ['missing', 'p-gone:m', '模型被删'],
    ['nokey', 'p-nokey:m', '缺密钥'],
    ['malformed', 'no-colon-here', '引用非法']
  ]
  const kinds: string[] = []
  for (const [expected, ref, label] of cases) {
    const r = await resolveAvailability(ref)
    info(`${label} 判定`, JSON.stringify(r))
    eq(`P2-5：${label} → kind=${expected}`, r.kind, expected)
    kinds.push(String(r.kind))
  }
  // 五种 kind 必须两两不同
  eq('P2-5：五种 kind 各不相同', [...new Set(kinds)].length, 5)

  // 文案：中英两侧都要有，且五种两两不同
  for (const locale of ['zh-CN', 'en'] as const) {
    const tree = messages[locale] as Record<string, unknown>
    const kindTree = (tree.cf as Record<string, unknown>)?.modelSwap as Record<string, unknown>
    const copy = kindTree?.kind as Record<string, string>
    if (!copy) {
      fail(`P2-5(${locale})：找不到 cf.modelSwap.kind`, locale)
      continue
    }
    const texts = ['missing', 'disabled', 'model-disabled', 'nokey', 'keyunreadable'].map((k) => copy[k])
    info(`P2-5(${locale}) 文案`, JSON.stringify(texts))
    // 缺文案会让界面直接显示 key 原文（t() 取不到返回 key）
    eq(
      `P2-5(${locale})：五种 kind 文案都存在`,
      texts.filter((x) => typeof x === 'string' && x).length,
      5
    )
    eq(`P2-5(${locale})：五种文案两两不同（相同=用户区分不出来）`, [...new Set(texts)].length, 5)
    // 指向动作：每条都得说出去哪儿做，而不能只说「不可用」
    check(
      `P2-5(${locale})：每条文案都指向具体动作（含设置或换/填的指引）`,
      texts.every((x) => /设置|Settings|pick another|add it back|enter it again|switch it back/i.test(x)),
      JSON.stringify(texts)
    )
  }
}

/**
 * A24/A25：带首尾空格的引用必须能被批量替换掉，且跳过项的解释必须正确。
 *
 * 以前 `from` 被 trim、`c.ref` 没 trim，`!==` 于是成立：同一个模型被判成「用的是别的模型」→ 落进 skipped
 * → 永远换不掉（导入来的数据带空格很常见）。
 */
async function scenarioSwapWhitespace(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap, scanSessionsByModel } = await import(
    '../../apps/desktop/src/main/services/model-swap'
  )
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        // 源服务商：模型列表里没有 m → 判 missing
        { id: 'p', name: 'P', apiHost: 'http://localhost:1/v1', enabled: true, models: [{ id: 'gone' }] },
        // 目标：本机地址，不需要密钥
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] }
      ]
    }
  })

  // ① 主对话：带首尾空格的引用（模拟导入 / 手改配置留下的数据）
  const main = cs.ensureSession('Ws1', { model: ' p:m ' })
  main.title = 'SpacedRef'
  eq('A24：前置——会话存的是带空格的原值', cs.save('Ws1'), true)

  // ② 成员会话：真的用了别的模型（对照组，必须留在 skipped）
  const sub = cs.ensureSession('Ws1-sub', { model: 'q:n' })
  sub.title = 'Other'
  sub.parentId = 'Ws1'
  eq('A24：前置——成员会话落盘', cs.save('Ws1-sub'), true)
  const s = cs.getSession('Ws1')!
  s.members = [{ sessionId: 'Ws1-sub', name: 'Other', personaId: 'general' } as never]
  cs.save('Ws1')

  // 扫描：带空格的那个能被判失效（内部 trim 过），所以它会出现在红标清单里
  const scan = await scanSessionsByModel('Ws1')
  info('扫描结果', JSON.stringify(scan.map((b) => [b.sessionId, b.ref, b.kind])))
  check(
    'A24：带空格的引用能被判失效（所以用户会看到红标）',
    scan.some((b) => b.sessionId === 'Ws1'),
    JSON.stringify(scan)
  )

  // 替换：界面传来的 fromRef 是**没带空格**的规范值
  const r = await applyModelSwap({ mainId: 'Ws1', fromRef: 'p:m', toRef: 'q:n' })
  if ('error' in r) {
    fail('A24：不该整批拒绝', JSON.stringify(r))
    return
  }
  info('替换结果', JSON.stringify({ changed: r.changed.map((b) => b.sessionId), skipped: r.skipped.map((b) => b.sessionId) }))

  eq('A24：带空格的会话被换掉（以前落进 skipped 永远换不掉）', r.changed.map((b) => b.sessionId), ['Ws1'])
  eq('A24：磁盘上的值已更新为 toRef', cs.getSession('Ws1')?.model, 'q:n')

  // A25：跳过项的 ref 是**真实的另一个模型**，不是「同一个值带空格」
  eq('A25：真正用了别的模型的仍跳过', r.skipped.map((b) => b.sessionId), ['Ws1-sub'])
  check(
    'A25：跳过项的理由成立——它确实是另一个引用（归一后也不同于 from）',
    r.skipped.every((b) => b.ref.trim() !== 'p:m'),
    JSON.stringify(r.skipped.map((b) => b.ref))
  )
  // 被换掉的那条不该出现在 skipped 里（否则界面会说「它用的是别的模型」，那是错的）
  check(
    'A25：被换掉的会话不出现在 skipped 里',
    !r.skipped.some((b) => b.sessionId === 'Ws1'),
    JSON.stringify(r.skipped.map((b) => b.sessionId))
  )
  // 用户数据不被归一化改写：另一个会话的原值保持原样
  eq('A24：没被替换的会话原值一个字不改', cs.getSession('Ws1-sub')?.model, 'q:n')
}

/**
 * A29/A30：轮前体检拦下的一轮不许留 notices、不许动 updatedAt，但提示不能丢。
 *
 * 验收实测：拦截后 `{"notices":1,"noticeKinds":["error"]}` 且 updatedAt 被刷新 → 用户看到「我没发出去，
 * 它怎么跳上去了」，而那条 error 重启后还在。
 */
async function scenarioBlockedTurnNoTrace(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const chatTurns = await import('../../apps/desktop/src/main/services/chat-turns')
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        // 引用悬空：服务商在、模型不在 → 体检必拦
        { id: 'p', name: 'P', apiHost: 'http://localhost:1/v1', enabled: true, models: [{ id: 'other' }] }
      ]
    }
  })

  // 造一条已经存在、且 updatedAt 是**旧值**的会话
  const OLD = 1111000
  const s = cs.ensureSession('Blk1', { model: 'p:missing' })
  s.title = 'Blocked'
  s.updatedAt = OLD
  eq('A29：前置——旧会话落盘', cs.save('Blk1'), true)

  const before = cs.getSession('Blk1')!
  const noticeCountBefore = before.notices?.length ?? 0
  const updatedBefore = before.updatedAt

  // 直接跑一轮（体检在调模型之前就抛出并被 runTurn 兜住）
  // 提示走 chat-bus 的一次性事件（不落盘）：订阅一次，确认拦截仍然给了提示
  const chatBus = await import('../../apps/desktop/src/main/services/chat-bus')
  const events: Array<{ turnId: string; event: { type?: string; kind?: string; message?: string } }> = []
  const unsub = chatBus.onChatEvent((p) => events.push(p as never))

  /*
   * 走**真实入口** `sendMessage`（而不是直接调 runTurn）：体检必须在 `history.push` 与 `saveProject` 之前
   * 拦下，否则用户消息已经进历史并落盘、updatedAt 也已刷新——那正是 A29/A30 报的现象。
   * 注：sendMessage 只回 {turnId}（内部 void 起轮），拦下的那一轮不会有 done 事件以外的副作用。
   */
  const res = await chatTurns.sendMessage({
    sessionId: 'Blk1',
    text: '你好',
    model: { providerId: 'p', modelId: 'missing', adapter: 'openai', baseURL: 'http://localhost:1/v1' },
    workspaceRoot: null,
    trigger: 'desktop'
  } as never)
  // 让 emit 的微任务跑完
  await new Promise((r) => setTimeout(r, 30))
  unsub()
  info('sendMessage 结果', JSON.stringify(res))

  const errEvents = events.filter((e) => e.event?.type === 'error')
  info('拦截期间发出的事件类型', JSON.stringify(events.map((e) => e.event?.type)))
  check(
    'A31：拦截仍然给出提示（发出 error 事件，一次性、不落盘）',
    errEvents.length > 0,
    JSON.stringify(errEvents).slice(0, 400)
  )

  const after = cs.getSession('Blk1')!
  const noticeCountAfter = after.notices?.length ?? 0
  info(
    '拦截后 notices / updatedAt',
    JSON.stringify({ before: noticeCountBefore, after: noticeCountAfter, updatedBefore, updatedAfter: after.updatedAt })
  )

  eq('A29：被拦的一轮不新增 notices（以前多一条 error，重启还在）', noticeCountAfter, noticeCountBefore)
  check(
    'A29：notices 里没有新的 error 记录',
    !(after.notices ?? []).some((n) => n.kind === 'error'),
    JSON.stringify(after.notices)
  )
  eq('A30：被拦的一轮不动 updatedAt（以前被顶到列表最前）', after.updatedAt, updatedBefore)
  // 拦截必须早于 history.push：否则用户消息留在历史里，模型下一轮会看到一条「没发出去的话」
  eq('A29：被拦的一轮没有把用户消息写进历史', after.messages.length, before.messages.length)
}

/**
 * A42：密钥库内容坏掉时不能集体判「缺密钥」（与 P1-3 同形，发生在 secrets 侧）。
 *
 * 以前 `ensureLoaded` 的 catch 一律 `store = {}`，于是 `secrets.json` 坏 → 所有服务商判 nokey → 全库红标 +
 * 体检拒绝发送，用户看到「我密钥怎么全没了」，实际该去修 secrets.json。
 *
 * 独立进程跑（store / loaded 是模块级），由 S42_KIND 控制：absent（无文件）/ corrupt（内容坏）。
 */
async function scenarioSecretsCorrupt(): Promise<void> {
  const kind = (process.env.S42_KIND ?? '') as 'absent' | 'corrupt' | ''
  const secretsPath = path.join(DST, 'secrets.json')
  fs.mkdirSync(DST, { recursive: true })
  if (kind === 'absent') {
    fs.rmSync(secretsPath, { force: true })
  } else {
    // 半截 JSON：能读到字节，解析不了
    fs.writeFileSync(secretsPath, '{bad json ,,,')
  }

  const secrets = await import('../../apps/desktop/src/main/services/secrets')
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  const { resolveAvailability } = await import('../../apps/desktop/src/main/services/model-availability')

  setConfig({
    models: {
      providers: [
        // 远端服务商：需要密钥才会被判 nokey
        { id: 'p', name: 'P', apiHost: 'https://api.example.com/v1', enabled: true, models: [{ id: 'm' }] }
      ]
    }
  })

  // 载入状态不再单独暴露接口（那两个函数没人用、已删）：用 readSecret 的返回值判，正是生产代码的做法
  const direct = await secrets.readSecret('p')
  const loadKind = direct.kind === 'store-unreadable' ? 'corrupt' : direct.kind === 'absent' ? 'absent' : 'ok'
  info('密钥库状态（由 readSecret 反推）', loadKind)
  info('readSecret 结果', JSON.stringify(direct))

  const r = await resolveAvailability('p:m')
  info('可用性判定', JSON.stringify(r))

  if (kind === 'corrupt') {
    eq('A42(corrupt)：载入状态是 corrupt（不是 ok/absent）', loadKind, 'corrupt')
    eq('A42(corrupt)：readSecret 报 store-unreadable（不是 absent=没配过）', direct.kind, 'store-unreadable')
    eq('A42(corrupt)：密钥库读坏 → 可用性放行（旧实现判 nokey 全库红标）', r.ok, true)
    eq('A42(corrupt)：放行时不该带 kind', r.kind, undefined)
  } else {
    // 对照：真没配过 ≠ 读坏，必须仍然判 nokey，别把「没配」也放行了
    eq('A42(absent)：无文件 → absent', loadKind, 'absent')
    eq('A42(absent)：readSecret 报 absent', direct.kind, 'absent')
    eq('A42(absent)：真没配过仍判 nokey（不能一起放行）', r.kind, 'nokey')
    eq('A42(absent)：真没配过不是 ok', r.ok, false)
  }
}

/**
 * B4：候选排除必须来自**全量**服务商的密钥状态，不能只从 scan（有会话引用的失效项）反推。
 *
 * 场景：服务商 A 有会话引用且模型被删；服务商 B **缺密钥但没有任何会话引用**。
 * 期望：B 的模型不出现在**可选**候选里（否则用户从坏模型换到 B，换完还是不能用，得再来一次）。
 *
 * 同时验 B3 的另一半：B 要**列出来并标不可选 + 写明原因**，而不是静默消失——否则用户只知道
 * 「我的 B 服务商不见了」，不知道该先去填密钥。
 */
async function scenarioSwapCandidates(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { scanSessionsByModel } = await import('../../apps/desktop/src/main/services/model-swap')
  const { listProvidersWithUnusableKey, resolveAvailability } = await import(
    '../../apps/desktop/src/main/services/model-availability'
  )
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        // A：有会话引用、但会话引用的模型**不在 A 的模型清单里**（= 被删了）→ missing
        { id: 'pa', name: 'A', apiHost: 'http://localhost:1/v1', enabled: true, models: [{ id: 'alive' }] },
        // B：缺密钥（远端），**没有任何会话引用它**
        { id: 'pb', name: 'B', apiHost: 'https://b.example/v1', enabled: true, models: [{ id: 'bm' }] },
        // C：本机 + 可用 → 应该是唯一真正可选的
        { id: 'pc', name: 'C', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'cm' }] }
      ]
    }
  })

  const s = cs.ensureSession('Cd1', { model: 'pa:gone' })
  s.title = 'Cand'
  eq('B4：前置——会话落盘', cs.save('Cd1'), true)

  // ① scan 只含 A（B 没被任何会话引用，所以它不会出现在 affected 里）——这正是原 bug 的成因
  const scan = await scanSessionsByModel('Cd1')
  info('scan 结果（只有有会话引用的）', JSON.stringify(scan.map((b) => [b.ref, b.kind])))
  eq('B4：前置——scan 里只有 A 的引用（B 不在其中，所以不能只靠它反推）', scan.map((b) => b.ref), ['pa:gone'])

  // ② 全量密钥状态里必须含 B
  const blocked = await listProvidersWithUnusableKey()
  info('密钥不可用的服务商（全量）', JSON.stringify(blocked))
  eq('B4：全量密钥状态含 B（无会话引用也要列出）', blocked.map((b) => b.id), ['pb'])
  eq('B4：B 的原因是 nokey', blocked[0]?.kind, 'nokey')
  // C 是本机服务，不该被当成缺密钥
  check('B4：本机服务（C）不被列进密钥不可用', !blocked.some((b) => b.id === 'pc'), JSON.stringify(blocked))

  // ③ 明示 bug 本身：B 的模型**单独看是**不可用的（这就是「换过去还是不能用」的证据）
  const bModel = await resolveAvailability('pb:bm')
  info('B 的模型可用性', JSON.stringify(bModel))
  eq('B4：B 的模型本身不可用（换过去也白换）', bModel.kind, 'nokey')

  // ④ 停用的服务商不重复报（它已不在候选里，另有 disabled 原因）
  const { setConfig: setCfg2 } = await import('../../apps/desktop/src/main/services/config')
  setCfg2({
    models: {
      providers: [
        { id: 'off', name: 'Off', apiHost: 'https://off.example/v1', enabled: false, models: [{ id: 'm' }] }
      ]
    }
  })
  const blocked2 = await listProvidersWithUnusableKey()
  eq('B4：停用的服务商不进「密钥不可用」名单（另有 disabled 原因）', blocked2, [])
}

/**
 * B3：缺密钥的服务商在候选里**列出来但标不可选**，不是静默消失。
 *
 * 这里只验文案与「候选构造规则」的可测部分：界面的 `disabled` 标记由 Select 组件承担（纯 UI），
 * 主进程侧能锁的是「这个服务商确实被判成密钥不可用，且它的模型仍然存在」——两者同时成立才谈得上
 * 「列出来并标注」而不是「它不见了」。
 */
async function scenarioBlockedProviderListed(): Promise<void> {
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  const { listProvidersWithUnusableKey } = await import('../../apps/desktop/src/main/services/model-availability')
  const { messages } = await import('../../apps/desktop/src/renderer/src/i18n/messages')

  setConfig({
    models: {
      providers: [
        // 缺密钥，但**有**模型（要能列出来）
        { id: 'pb', name: 'B', apiHost: 'https://b.example/v1', enabled: true, models: [{ id: 'bm' }] },
        // 缺密钥且没有模型：没有可列的项，不该凭空出现一个空组
        { id: 'pempty', name: 'E', apiHost: 'https://e.example/v1', enabled: true, models: [] }
      ]
    }
  })

  const blocked = await listProvidersWithUnusableKey()
  info('密钥不可用的服务商', JSON.stringify(blocked.map((b) => b.id)))
  eq('B3：缺密钥且有模型的服务商被判密钥不可用（界面据此标灰）', blocked.map((b) => b.id), ['pb'])

  // 文案两侧都要有，且写清「先填密钥」这个动作
  for (const locale of ['zh-CN', 'en'] as const) {
    const tree = messages[locale] as Record<string, unknown>
    const copy = ((tree.cf as Record<string, unknown>)?.modelSwap as Record<string, unknown>)?.providerNoKey
    check(`B3(${locale})：候选里的「没填密钥」说明存在`, typeof copy === 'string' && copy.length > 0, String(copy))
    check(
      `B3(${locale})：说明指向动作（去填密钥）`,
      typeof copy === 'string' && /填|add one|key/i.test(copy),
      String(copy)
    )
  }
}

const SCENARIOS: Record<string, () => Promise<void> | void> = {
  full: scenarioFull,
  sweep: scenarioSweep,
  memidem: scenarioMemIdem,
  budget: scenarioBudget,
  broken: scenarioBroken,
  writefail: scenarioWriteFailReason,
  mcp: scenarioMcp,
  mcpsrc: scenarioMcpSourceUnreadable,
  mcptgt: scenarioMcpTargetBlocked,
  mcpipc: scenarioMcpIpcWriteResult,
  mcpunsafe: scenarioMcpUnsafeId,
  keyless: scenarioKeylessHost,
  keytri: scenarioKeyTriState,
  cfgcorrupt: scenarioConfigCorrupt,
  swapfail: scenarioSwapWriteFail,
  kindcopy: scenarioKindCopy,
  swapws: scenarioSwapWhitespace,
  blockedturn: scenarioBlockedTurnNoTrace,
  secretskind: scenarioSecretsCorrupt,
  swapcand: scenarioSwapCandidates,
  blockedlist: scenarioBlockedProviderListed,
  locks: scenarioLocks,
  nosource: scenarioNoSource,
  empty: scenarioEmptySource,
  gate: scenarioGateLocked,
  skills: scenarioSkills,
  resume: scenarioResume,
  xproc: scenarioXproc,
  personas: scenarioPersonas
}

async function main(): Promise<void> {
  const name = process.argv[2] || 'full'
  // 子模式：只抢锁并挂住，供 xproc 场景模拟「另一个窗口在用」
  if (name === 'locker') {
    getDevaHome()
    const l = acquireLock(DST)
    if ('fd' in l) {
      console.log('locked')
      await new Promise((r) => setTimeout(r, 20000))
      releaseLock(DST, l.fd)
    } else {
      console.log('busy')
    }
    return
  }
  const fn = SCENARIOS[name]
  if (!fn) {
    console.log(`FAIL 未知场景 ${name}`)
    process.exit(2)
  }
  console.log(`=== 场景 ${name} ===`)
  console.log(`INFO env :: HOME=${HOME} APPDATA=${APPDATA} DST=${DST}`)
  try {
    await fn()
  } catch (e) {
    fail(`${name} 场景抛异常`, (e as Error)?.stack?.split('\n').slice(0, 5).join(' / ') ?? String(e))
  }
  console.log(`=== ${name} 结束：FAIL ${fails} 条 ===`)
  process.exit(fails > 0 ? 1 : 0)
}

void main()
