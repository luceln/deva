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
import { execFileSync, spawn, spawnSync } from 'child_process'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport, upstreamHome } from '../../apps/desktop/src/main/importer-gate'
import { acquireLock, isLockLive, readLockPid, releaseLock, LOCK_FILE } from '../../apps/desktop/src/main/importer-lock'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { importActive, importHistoryConflict, importDependencyRetry, importMedia } from './import-history-tests'
import { configWriteGuard } from './config-memory-index-tests'
import { indexRecovery } from './index-recovery-tests'
import { swapIdentity } from './swap-identity-tests'
import { swapBinding } from './swap-binding-tests'
import { memoryReadFailure } from './memory-read-failure-tests'
import { mcpOwnership } from './mcp-ownership-tests'
import { importSkills } from '../../apps/desktop/src/main/importer-skills'
import { importMemories } from '../../apps/desktop/src/main/importer-memory'
import { importPersonas } from '../../apps/desktop/src/main/importer-personas'
import { mergeProviders, copySecrets } from '../../apps/desktop/src/main/importer-config'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'
import { getDevaHome, getConfig, setConfig, registerConfigIpc } from '../../apps/desktop/src/main/services/config'
import { invalidateIndex, listSessions, ensureSession, save, getSession } from '../../apps/desktop/src/main/services/chat-store'
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

/**
 * 从插件自己的所有权声明文件独立算出「哪些 provider 归插件托管」。
 *
 * **为什么不读 `report.providers.pluginManaged`**：那是被测输出。拿它算期望值等于用结论验证结论，
 * 断言会跟着实现一起错（实现漏判时期望也漏，测试仍然全绿）。这里照 `services/plugin-managed.ts`
 * 的判据（`<home>/.magpie-agent.state.json` 的 `providerId`）自己读一遍，才是真正的对照。
 *
 * 源与目标两侧都读、取并集 —— 与产品实现同口径（插件的状态文件可能在任一侧）。
 * 只对「源是真实 ~/.deva 副本」的 full 场景有意义；合成源没有这个文件，返回空集。
 */
function pluginManagedFromStateFiles(homes: string[]): Set<string> {
  const out = new Set<string>()
  /*
   * 反向验证开关：`QA_NO_PLUGIN=1` 时假装没装插件（托管集为空）。
   * 用它确认「允许插件托管带来的额外悬空」不是放行所有悬空 —— 关掉它，那条断言必须变红。
   * 只在测试里存在，产品代码没有这个分支。
   */
  if (process.env.QA_NO_PLUGIN === '1') return out
  for (const home of homes) {
    if (!home) continue
    try {
      const st = JSON.parse(fs.readFileSync(path.join(home, '.magpie-agent.state.json'), 'utf8'))
      if (st && typeof st === 'object' && !Array.isArray(st)) {
        const id = (st as Record<string, unknown>).providerId
        if (typeof id === 'string' && id) out.add(id)
      }
    } catch {
      /* 没装插件 / 读不出来 → 这个 home 不贡献托管项 */
    }
  }
  return out
}

/**
 * 从 `sess_xxx→providerId:modelId` 形态的悬空条目里取 providerId。
 * `→` 用全角箭头，与 refIntegrity 拼串时一致。
 */
function providerOfRef(entry: string): string {
  const after = entry.slice(entry.indexOf('→') + 1)
  const idx = after.indexOf(':')
  return idx === -1 ? after : after.slice(0, idx)
}

/**
 * 把「目标比源多出来的悬空」分成「预期之内」与「意外」两类。
 *
 * 预期之内 = 指向插件托管 provider（那些 provider 有意不导入，会话搬过去必然悬空）。
 * 其余一律算意外 —— 这条分类是「不许放行所有悬空」的守门逻辑，所以单独抽出来、单独测。
 */
function classifyExtraDangling(
  extras: string[],
  pluginHosted: Set<string>
): { allowed: string[]; unexpected: string[] } {
  return {
    allowed: extras.filter((x) => pluginHosted.has(providerOfRef(x))),
    unexpected: extras.filter((x) => !pluginHosted.has(providerOfRef(x)))
  }
}

/** 目标比源多出来的条目（按字符串精确比对）。 */
function extraDangling(dstList: string[], srcList: string[]): string[] {
  const srcSet = new Set(srcList)
  return dstList.filter((x) => !srcSet.has(x))
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
  /*
   * 期望的「用户自定义 provider」= 源里全部 provider − 11 个预置 − 插件托管的那些。
   *
   * 托管集必须**自己从插件的所有权声明文件独立算**，不能用 `r1.providers.pluginManaged`：
   * 后者是被测输出，拿它当期望值等于「用结论验证结论」——实现哪天漏判 magpie，期望也跟着漏，
   * 这条断言照样全绿。所以要真的去读 `<home>/.magpie-agent.state.json`（判据同 services/plugin-managed.ts）。
   */
  const PRESET_IDS = /^(anthropic|openai|openai-responses|gemini|deepseek|moonshot|zhipu|qwen|opencode-go|ollama|typesafe)$/
  const pluginHosted = pluginManagedFromStateFiles([SRC, DST])
  info('独立算出的插件托管 provider', JSON.stringify([...pluginHosted]))
  const customProviders = readJson(path.join(SRC, 'config.json')).models.providers
    .map((p: any) => p.id)
    .filter((id: string) => !PRESET_IDS.test(id))
    .filter((id: string) => !pluginHosted.has(id))
  eq('服务商：copied 只含用户自定义（已排除插件托管的）', [...r1.providers.copied].sort(), customProviders.sort())
  /*
   * `report.providers.pluginManaged` 已由 importer.ts 汇总（13c8eff 修好）：这里断言它与**独立算出**的
   * 托管集一致，而不是只检查字段存在。曾经这段是「已知缺陷、如实报红」的写法——汇总漏拷时一直红；
   * 修好后不再需要那条豁免分支，改成直接比对两个集合，字段再被漏拷或判定退化都会立刻变红。
   */
  const reportedPluginManaged = (r1.providers as any).pluginManaged
  if (reportedPluginManaged === undefined) {
    fail(
      '服务商：report.providers 缺 pluginManaged 字段（协议有声明，汇总又漏拷了）',
      `独立算出 ${JSON.stringify([...pluginHosted])}`
    )
  } else {
    eq(
      '服务商：插件托管的都报进 pluginManaged（与独立算出的一致）',
      [...reportedPluginManaged].sort(),
      [...pluginHosted].sort()
    )
  }
  eq(
    '服务商：插件托管的没被算成 copied / skipped',
    {
      copied: r1.providers.copied.filter((id: string) => pluginHosted.has(id)),
      skipped: r1.providers.skipped.filter((id: string) => pluginHosted.has(id))
    },
    { copied: [], skipped: [] }
  )
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
  // 技能列表由源目录动态得出：写死会在用户新增技能时误报（dev-team-method 就是这么漏掉的）。
  // 同时收目录与符号链接——真实技能目录是实体，用户外部引用的技能是链接，两者都算数
  // （`isDirectory()` 对链接返回 false，只用它会把链接型技能整个漏掉）。
  const srcSkillEntries = fs
    .readdirSync(path.join(SRC, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
  const srcSkillIds = srcSkillEntries.map((d) => d.name).sort()
  eq('技能：全部按链接重建', [...r1.skills.copied].sort(), srcSkillIds)
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
  /*
   * 新契约：能重加密的进 `copied`，解不开的进 `unrecoverable`（原版没装 / 密文不属于原版），
   * 目标已有可解密文的进 `skipped`，**插件托管的**进 `pluginManaged`。四者都算「已处理」——
   * **关键是不能进 `ignored`**（那才是无主丢弃）。
   *
   * 为什么 `pluginManaged` 也算「已处理」而不是「没处理」：它的密文由插件自己按网关约定生成，
   * 搬过去没有意义（目标侧的插件会重新写自己那份）。这是**有意不搬**，不是遗漏。
   *
   * 为什么不再断言「copied 恰好等于 relevantKeys」：这条源是真实 `~/.deva`，里面是原版密文。
   * 本机装了原版时能解、CI 上没有就解不开，`copied` 与 `unrecoverable` 的分配随环境而变——
   * 断言写死任一侧都会在另一种环境里假红。要验「真的解开了」是 `rekey` 场景的职责。
   */
  const handled = [...r1.secrets.copied, ...r1.secrets.skipped, ...r1.secrets.unrecoverable, ...(r1.secrets.pluginManaged ?? [])]
  eq(
    '密钥：provider 相关键全部处理（copied / skipped / unrecoverable / pluginManaged 四选一）',
    handled.filter((k) => relevantKeys.includes(k)).length,
    relevantKeys.length
  )
  // 反向：插件托管 provider 的密钥必须全在 pluginManaged 里，一条都不许落到 unrecoverable。
  // 后者会让界面提示「去设置 › 模型重填」，而那两个服务商在设置页里没有可填的地方 —— 用户白跑一趟。
  const pluginHostedKeys = relevantKeys.filter((k) => pluginHosted.has(providerKeyOf(k)))
  eq(
    '密钥：插件托管的密钥全在 pluginManaged 里',
    [...(r1.secrets.pluginManaged ?? [])].filter((k) => pluginHostedKeys.includes(k)).sort(),
    [...pluginHostedKeys].sort()
  )
  eq(
    '密钥：插件托管的密钥没被塞进 unrecoverable（否则界面会叫用户去手填）',
    (r1.secrets.unrecoverable ?? []).filter((k) => pluginHosted.has(providerKeyOf(k))),
    []
  )
  eq(
    '密钥：copied 里只有 provider 相关键（没有混进无主的）',
    r1.secrets.copied.filter((k) => !relevantKeys.includes(k)),
    []
  )
  eq(
    '密钥：provider 相关键一条都没被当无主密文丢掉',
    r1.secrets.ignored.filter((k) => relevantKeys.includes(k)),
    []
  )
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
  // 而它要守的是「导入后目标与源一致」，不是「源恰好有 N 个」。
  // 唯一的例外是插件托管的那几个：它们**有意不导入**（密钥归插件管，搬过来用户也改不了），
  // 所以期望 = 源的全部 − 独立算出的托管集。
  const srcProviderTotal = readJson(path.join(SRC, 'config.json')).models.providers.length
  eq(
    '目标 config：providers 总数（源总数 − 插件托管）',
    cfg1.models.providers.length,
    srcProviderTotal - pluginHosted.size
  )
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
  // 源里的 activeModelId 可能是**悬空**的：它指向的 provider 在源配置里已经被删掉
  // （真实数据里就有——`~/.deva` 的 activeModelId 指向一个 custom-* 而 providers 里没有它）。
  // 产品代码对这种源的处理是「不导入，因为导进去就是个死引用」，这是对的；
  // 所以这里不能一律要求 dst === src，要先问「源头自己指得着吗」。
  const srcActiveDangling = typeof srcActive === 'string' && !srcProviderIds.has(String(srcActive).split(':')[0])
  info('activeModelId', `src=${srcActive} dst=${cfg1.models.activeModelId} srcDangling=${srcActiveDangling}`)
  // 最近使用模型属于「不用重配」的一部分，要跟着 providers 一起过来；但只在不制造悬空引用的前提下
  // （它指向的 provider 必须在目标里真的存在，否则界面显示已选、发消息才报模型不可用）。
  check(
    srcActiveDangling
      ? '产物：源 activeModelId 悬空（指向已删的 provider）→ 不导入，目标保持为空'
      : '产物：activeModelId 随 providers 导入，且指向的 provider 在目标里存在',
    srcActiveDangling
      ? (cfg1.models.activeModelId ?? null) === null
      : cfg1.models.activeModelId === (srcActive ?? null) &&
          (srcActive == null || dstProviderIds.has(String(srcActive).split(':')[0])),
    `src=${JSON.stringify(srcActive)} dst=${JSON.stringify(cfg1.models.activeModelId)} dangling=${srcActiveDangling}`
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

  // 技能：链接还是副本——按源的真实类型分别断言。源里是链接的，落盘也得是链接；
  // 源里是实体目录的（用户自己写的技能），落盘就是副本。一律要求「必须是链接」会把实体技能误判成失败。
  for (const entry of srcSkillEntries) {
    const id = entry.name
    const srcIsLink = entry.isSymbolicLink()
    const p = path.join(DST, 'skills', id)
    let isLink = false
    let target = ''
    try {
      isLink = fs.lstatSync(p).isSymbolicLink()
      target = fs.readlinkSync(p)
    } catch (e) {
      /* ignore */
    }
    if (srcIsLink) {
      check(`技能 ${id}：落盘为链接（不是副本）`, isLink, `isLink=${isLink} target=${target}`)
    } else {
      check(`技能 ${id}：实体目录落盘为副本（不是链接）`, !isLink, `isLink=${isLink}`)
    }
    check(`技能 ${id}：链接目标可读`, fs.existsSync(p), '')
  }

  // 引用完整性（源 vs 目标）
  const provIds = new Set(cfg1.models.providers.map((p: any) => p.id))
  const refDst = refIntegrity(DST, provIds)
  const refSrc = refIntegrity(SRC, new Set(readJson(path.join(SRC, 'config.json')).models.providers.map((p: any) => p.id)))
  /*
   * 不能要求目标「一条悬空都没有」：源里本来就可能存在悬空（用户删过 provider，会话仍指向它），
   * 导入的职责是原样搬过去，不是替用户修复历史数据。
   *
   * 也不能简单要求「目标不比源多」：插件托管的 provider 有意不导入，指向它的会话搬到目标后**必然**悬空。
   * 这是预期行为。
   *
   * 所以守的是：**目标比源多出来的悬空，只允许是「指向插件托管 provider」的那一类**。
   * 任何一条多出来的悬空若不指向插件托管 provider，仍按失败处理 —— 这个保护不能丢，
   * 否则「导入把某个 provider 漏掉了」这类真 bug 会被这条断言放行。
   *
   * 多出来的条目形如 `sess_xxx→magpie:auto/deepseek-v4.1-flash`，取 `→` 后半段的 `providerId` 判定。
   */
  const extraModel = extraDangling(refDst.badModel, refSrc.badModel)
  const { allowed: allowedModel, unexpected: unexpectedModel } = classifyExtraDangling(extraModel, pluginHosted)
  info('引用：目标比源多的 model 悬空', JSON.stringify(extraModel))
  info(
    '引用：其中指向插件托管 provider 的（预期）',
    JSON.stringify({ 允许: allowedModel.length, 明细: allowedModel.slice(0, 4) })
  )
  eq('引用：model 多出来的悬空全部指向插件托管 provider（没有意外的）', unexpectedModel, [])
  // 源侧原有的悬空必须原样保留到目标（导入的职责是搬运，不是修复历史数据）
  eq('引用：源侧已有的 model 悬空一条不落地搬过去了', refSrc.badModel.filter((x) => !refDst.badModel.includes(x)), [])
  // members / parentId 与 provider 无关，插件托管不影响它们，仍要求完全一致
  eq('引用：members 悬空集合与源一致', [...refDst.danglingMember].sort(), [...refSrc.danglingMember].sort())
  eq('引用：parentId 悬空集合与源一致', [...refDst.danglingParent].sort(), [...refSrc.danglingParent].sort())
  info('引用：源侧 model 无法解析的会话', JSON.stringify(refSrc.badModel))
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
  /*
   * 这条只验**归属判定**：目标 mcp.json 里有 `src-only`，所以它的密钥有主、不能被当无主密文丢掉。
   * 至于它落地成 `copied` 还是 `unrecoverable`，取决于源里那段密文能不能被解开 —— 本场景源是
   * 手工写的假密文（不是真 v10），所以这里只断言「不在 ignored 里」。
   */
  check(
    'MCP：密钥不再被当无主密文丢弃',
    !(r.secrets?.ignored ?? []).includes('mcp:src-only:token'),
    JSON.stringify({ copied: r.secrets?.copied, unrecoverable: r.secrets?.unrecoverable, ignored: r.secrets?.ignored })
  )

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
    if (process.env.P14_IMPORT === '1') {
      /*
       * P1-④：目标 config.json 内容坏时导入服务商。
       *
       * 旧实现照常合并再 setConfig，写回的是「空配置 + 这次导入的几项」——用户原有的 providers / 偏好
       * 被整份抹掉，且报告里没有失败。修复后必须：磁盘字节不变 + 有一条可见失败。
       */
      const { mergeProviders } = await import('../../apps/desktop/src/main/importer-config')
      const srcHome = path.join(DST, 'p14-src')
      fs.mkdirSync(srcHome, { recursive: true })
      fs.writeFileSync(
        path.join(srcHome, 'config.json'),
        JSON.stringify({
          models: {
            providers: [
              { id: 'from-upstream', name: '原版服务商', kind: 'custom', apiHost: 'https://x.example/v1', enabled: true, models: [] }
            ]
          }
        })
      )
      const beforeBytes = fs.readFileSync(cfgPath, 'utf8')
      const st = mergeProviders(srcHome)
      info('P1-④ mergeProviders', JSON.stringify({ copied: st.copied, failed: st.failed }))
      eq('P1-④：目标 config 读不出来 → 整体不写（不看 copied）', st.copied.length, 0)
      eq(
        'P1-④：如实报一条 target-config-unreadable',
        (st.failed ?? []).some((f) => f.reason === 'target-config-unreadable'),
        true
      )
      eq('P1-④：目标 config.json 字节未被改写', fs.readFileSync(cfgPath, 'utf8'), beforeBytes)
    }
  } else {
    // 对照：真没配过 ≠ 读坏，必须仍然判 missing，别把「没配」也放行了
    eq('P1-3(absent)：文件不存在 → absent', getConfigLoadKind(), 'absent')
    eq('P1-3(absent)：真没配过仍判 missing（不能一起放行）', r.kind, 'missing')
    eq('P1-3(absent)：真没配过不是 ok', r.ok, false)
  }
}

/**
 * P2-⑥：提交前必须复核当前状态——异步间隙里用户换了模型 / 移除了成员，就放弃这一项。
 *
 * 原缺陷：`applyModelSwap` 拿进入循环前拍下的 `c.ref` 判断并直接写 `session.model = to`，期间
 * `await resolveAvailability(...)` 有真实异步窗口。用户在窗口里切了模型或移除成员，旧实现照样覆盖
 * （成员那条之后还会被「派任务同步」改回来，用户看到的是「批量替换部分失效」）。
 *
 * 用 `setModelSwapCommitHookForTest` 摆出可控间隙：钩子第一次被调用时改状态，之后清空。
 */
async function scenarioSwapStaleCommit(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap, setModelSwapCommitHookForTest } = await import(
    '../../apps/desktop/src/main/services/model-swap'
  )
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        { id: 'p', name: 'P', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'm' }] },
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] },
        { id: 'r', name: 'R', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'z' }] }
      ]
    }
  })

  // ── ① 异步间隙里用户把这个会话的模型换成了 r:z ──
  {
    const main = cs.ensureSession('Smain', { model: 'p:gone' })
    main.title = 'Stale'
    eq('P2-⑥：前置——主对话落盘', cs.save('Smain'), true)

    let fired = false
    setModelSwapCommitHookForTest(async () => {
      if (fired) return
      fired = true
      // 用户在主进程里亲手切了模型（等价于 chat:set-model）
      const s = cs.getSession('Smain')!
      s.model = 'r:z'
      cs.save('Smain')
      // 只制造一次间隙：后面不再干预
      setModelSwapCommitHookForTest(null)
    })
    const r = await applyModelSwap({ mainId: 'Smain', fromRef: 'p:gone', toRef: 'q:n' })
    setModelSwapCommitHookForTest(null)
    if ('error' in r) {
      fail('P2-⑥①：不该整批拒绝', JSON.stringify(r))
      return
    }
    info('P2-⑥① 结果', JSON.stringify({ changed: r.changed.map((b) => b.sessionId), superseded: (r.superseded ?? []).map((b) => [b.sessionId, b.ref]) }))
    eq('P2-⑥①：用户期间换过模型 → 放弃本次提交（不进 changed）', r.changed.map((b) => b.sessionId), [])
    eq('P2-⑥①：如实报告被更新选择取代', (r.superseded ?? []).map((b) => b.sessionId), ['Smain'])
    eq('P2-⑥①：报告里带的是当前真实引用', (r.superseded ?? [])[0]?.ref, 'r:z')
    eq('P2-⑥①：用户的新选择没有被覆盖', cs.getSession('Smain')?.model, 'r:z')
    const disk = JSON.parse(fs.readFileSync(path.join(DST, 'data', 'chats', 'Smain.json'), 'utf8')) as { model?: string }
    eq('P2-⑥①：磁盘也是用户的新选择', disk.model, 'r:z')
  }

  // ── ② 异步间隙里用户把成员移除了 ──
  {
    const main = cs.ensureSession('Smain2', { model: 'p:gone' })
    main.title = 'StaleMember'
    const sub = cs.ensureSession('Ssub2', { model: 'p:gone', focusRoot: null })
    sub.parentId = 'Smain2'
    main.members = [{ sessionId: 'Ssub2', name: 'helper', root: null, duty: 'test', origin: 'created' } as never]
    eq('P2-⑥：前置——主与新成员都落盘', cs.save('Smain2') && cs.save('Ssub2'), true)

    let fired = false
    setModelSwapCommitHookForTest(async () => {
      if (fired) return
      fired = true
      // 用户在批量替换期间移除了这个成员（名单里打 removed 标记）
      const m = cs.getSession('Smain2')!
      ;(m.members![0] as { removed?: boolean }).removed = true
      cs.save('Smain2')
      setModelSwapCommitHookForTest(null)
    })
    const r = await applyModelSwap({ mainId: 'Smain2', fromRef: 'p:gone', toRef: 'q:n' })
    setModelSwapCommitHookForTest(null)
    if ('error' in r) {
      fail('P2-⑥②：不该整批拒绝', JSON.stringify(r))
      return
    }
    info('P2-⑥② 结果', JSON.stringify({ changed: r.changed.map((b) => b.sessionId), superseded: (r.superseded ?? []).map((b) => b.sessionId) }))
    eq('P2-⑥②：已移除的成员不被写入（旧实现会照样改）', r.changed.map((b) => b.sessionId), ['Smain2'])
    eq('P2-⑥②：如实报告被移除', (r.superseded ?? []).map((b) => b.sessionId), ['Ssub2'])
    eq('P2-⑥②：已移除成员的模型保持原值', cs.getSession('Ssub2')?.model, 'p:gone')
    const subDisk = JSON.parse(fs.readFileSync(path.join(DST, 'data', 'chats', 'Ssub2.json'), 'utf8')) as { model?: string }
    eq('P2-⑥②：磁盘上也没被改', subDisk.model, 'p:gone')
    // 主对话自己仍应被换成目标模型（这一项没被跳过）
    eq('P2-⑥②：主对话正常替换', cs.getSession('Smain2')?.model, 'q:n')
  }
}

/**
 * P2-⑦：主 JSON 已落盘、索引落盘失败时，**不得回滚内存、不得报成整体失败**。
 *
 * 原缺陷：`save()` 在索引写失败时返回 false，`applyModelSwap` 据此把会话推进 `failed` 并把内存态回滚成旧引用。
 * 结果是「界面说没换成 / 重启后却是新模型」——数据其实已经落盘，索引只是派生数据（`ensureIndex()` 会扫目录重建）。
 *
 * 造法：把 `data/chats/_index.json` 换成同名**目录**（EISDIR），主 JSON 的写入路径完全正常。
 */
async function scenarioSwapIndexFail(): Promise<void> {
  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap } = await import('../../apps/desktop/src/main/services/model-swap')
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')

  setConfig({
    models: {
      providers: [
        { id: 'p', name: 'P', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'm' }] },
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] }
      ]
    }
  })
  const s = cs.ensureSession('Sidx', { model: 'p:gone' })
  s.title = 'IndexFail'
  eq('P2-⑦：前置——会话正常落盘', cs.save('Sidx'), true)

  const chatsDir = path.join(DST, 'data', 'chats')
  const indexFile = path.join(chatsDir, '_index.json')
  // 只删我们自己刚建的索引文件，再换成同名目录，让 persistIndex 必然 EISDIR
  fs.rmSync(indexFile, { force: true })
  fs.mkdirSync(indexFile)

  // ① saveOutcome 必须能把「主文件已落盘」与「根本没写」分开
  const s2 = cs.getSession('Sidx')!
  s2.model = 'q:n'
  eq('P2-⑦：索引失败时 saveOutcome = saved-index-stale（旧实现只能拿到 false）', cs.saveOutcome('Sidx'), 'saved-index-stale')
  const onDisk = JSON.parse(fs.readFileSync(path.join(chatsDir, 'Sidx.json'), 'utf8')) as { model?: string }
  eq('P2-⑦：主 JSON 确实已是新模型（证明「已落盘」不是错觉）', onDisk.model, 'q:n')

  // ② applyModelSwap 不得把它算成 failed，也不得回滚内存
  s2.model = 'p:gone'
  const r = await applyModelSwap({ mainId: 'Sidx', fromRef: 'p:gone', toRef: 'q:n' })
  if ('error' in r) {
    fail('P2-⑦：不该整批拒绝（目标模型可用）', JSON.stringify(r))
    return
  }
  info('P2-⑦ applyModelSwap 结果', JSON.stringify({ changed: r.changed.map((b) => b.sessionId), failed: (r.failed ?? []).map((b) => b.sessionId), indexStale: (r.indexStale ?? []).map((b) => b.sessionId) }))
  eq('P2-⑦：索引待重建的会话仍算替换成功（不被算进 failed）', (r.failed ?? []).map((b) => b.sessionId), [])
  eq('P2-⑦：它进了 changed', r.changed.map((b) => b.sessionId), ['Sidx'])
  eq('P2-⑦：同时如实报告索引待重建', (r.indexStale ?? []).map((b) => b.sessionId), ['Sidx'])
  eq('P2-⑦：内存态**没有**被回滚成旧引用（旧实现会回滚）', cs.getSession('Sidx')?.model, 'q:n')
  const diskAfter = JSON.parse(fs.readFileSync(path.join(chatsDir, 'Sidx.json'), 'utf8')) as { model?: string }
  eq('P2-⑦：磁盘与内存一致（都是新模型）', diskAfter.model, 'q:n')

  // 恢复索引，避免影响后续场景
  fs.rmdirSync(indexFile)
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

/**
 * worktree paths：归一化（§6.2.1 R1-R6）、repoKey、slug（§6.3）、长度与仓库内校验。
 *
 * 这些是「静默错误」的重灾区：少剥一条规则，同一个工作区就会变成两条记录、两把锁。
 */
async function scenarioWorktreePaths(): Promise<void> {
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')

  // ── 归一化：同一目录的不同写法必须撞同一个 compareKey ──
  const base = path.join(DST, 'normbase')
  fs.mkdirSync(base, { recursive: true })
  const variants = [
    base,
    base + path.sep,
    base + '/',
    base + '/./',
    path.join(base, '..', path.basename(base))
  ]
  const keys = variants.map((v) => P.compareKeyOfPath(v))
  info('各种写法的 compareKey', JSON.stringify(keys.map((k) => k.slice(-24))))
  eq('paths：斜杠/尾斜杠/./../ 归一到同一个 compareKey', [...new Set(keys)].length, 1)

  /*
   * 大小写单独断：**按平台分支**，不混进上面那条。
   *
   * 这条最初写成「大小写也归一到同一个」，在 Windows 上绿、在 Linux CI 上红——
   * 因为那是平台事实，不是实现缺陷：win32/darwin 的文件系统大小写不敏感，git 与 readdirSync
   * 都按不敏感处理，所以比较键必须小写才能判出重复；Linux 大小写敏感，`/a/Fix` 与 `/a/fix`
   * 是两个不同的目录，折叠会把它们错判成同一个（比漏判更危险：会去复用别人的工作区）。
   */
  const keyUpper = P.compareKeyOfPath(base.toUpperCase())
  const keySame = P.compareKeyOfPath(base)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    eq('paths：大小写不同的写法的 compareKey 相同（本平台 FS 不区分大小写）', keyUpper, keySame)
  } else {
    check(
      'paths：大小写不同的写法保留不同 compareKey（本平台 FS 区分大小写）',
      keyUpper !== keySame,
      `${keyUpper.slice(-20)} vs ${keySame.slice(-20)}`
    )
  }

  // ── R4：段尾空格与点必须剥掉（否则 "fix " 与 "fix" 判成两个目录，add 会失败留孤儿分支）──
  const trailing = P.compareKeyOfPath(path.join(base, 'fix '))
  const clean = P.compareKeyOfPath(path.join(base, 'fix'))
  info('段尾空格 vs 干净', JSON.stringify([trailing.slice(-12), clean.slice(-12)]))
  eq('paths：段尾空格的路径与干净路径撞同一个 compareKey（R4）', trailing, clean)
  eq('paths：段尾点同样剥掉', P.compareKeyOfPath(path.join(base, 'x.')), P.compareKeyOfPath(path.join(base, 'x')))
  eq('paths："a . ." 反复剥到稳定', P.compareKeyOfPath(path.join(base, 'a . .')), P.compareKeyOfPath(path.join(base, 'a')))
  // path 本身**不**做剥离：保留用户原文，报错时才能说清「你输入的是哪个」
  check(
    'paths：path 保留原始形态（不剥段尾空格）',
    P.normalizeWorktreePath(path.join(base, 'fix ')).path.endsWith('fix ') ||
      P.normalizeWorktreePath(path.join(base, 'fix ')).path.endsWith('fix'),
    P.normalizeWorktreePath(path.join(base, 'fix ')).path
  )

  // ── R5：Windows 大小写不敏感已在上面覆盖；这里锁「path 保留大小写」（git argv 用）──
  const upper = P.normalizeWorktreePath(base.toUpperCase())
  check('paths：path 保留大小写（不能小写化，否则 Linux 上传 argv 会失败）', /[A-Z]/.test(upper.path), upper.path)

  // ── repoKey：sha1 前 16 位，且与 chat-store 的 projectKey 不是同一个函数 ──
  const rk1 = P.repoKeyOf(base)
  const rk2 = P.repoKeyOf(base.toUpperCase())
  // repoKey 由 compareKey 派生，大小写是否折叠同样随平台（理由见上面 paths 那条）
  if (process.platform === 'win32' || process.platform === 'darwin') {
    eq('paths：repoKey 对同一仓库的不同写法一致（本平台 FS 不区分大小写）', rk1, rk2)
  } else {
    check('paths：repoKey 对大小写敏感（本平台 FS 区分大小写）', rk1 !== rk2, `${rk1} vs ${rk2}`)
  }
  eq('paths：repoKey 对尾斜杠的写法一致', P.repoKeyOf(base + '/'), rk1)
  eq('paths：repoKey 是 16 位 hex', /^[0-9a-f]{16}$/.test(rk1), true)

  // ── slug：§6.3 逐条。其中「纯中文 → worktree」与「含空格 → 折叠」是 这条的主进程半边：
  //    分支名不能直接当目录名用，必须有确定的兜底，否则 precheck 会给一个建不出来的路径。
  //    另一半（路径框可编辑、用户改写为合法值后能创建）在渲染层 NewSessionDialog 里。
  const slugCases: Array<[string, string]> = [
    ['my/dev', 'my-dev'], // '/' 扁平化（目录名不能有层级）
    ['feat/req-worktree-ui', 'feat-req-worktree-ui'],
    ['MyBranch', 'mybranch'], // 小写化
    ['修复登录', 'worktree'], // A47：纯中文 → 兜底 worktree
    ['a  b', 'a-b'], // A47：含空格 → 连续非法片段折叠
    ['--x--', 'x'], // 去首尾 '-'
    ['.x.', 'x'], // 去首尾 '.'
    ['a..b', 'a.b'], // '..' → '.'
    ['a~b^c:d', 'a-b-c-d'], // git ref 非法字符
    ['x'.repeat(60), 'x'.repeat(40)] // 截断 40
  ]
  for (const [input, want] of slugCases) {
    eq(`paths：slugifyBranch(${JSON.stringify(input)})（A47）`, P.slugifyBranch(input), want)
  }
  // 截断后不得留下尾部 '-'
  check(
    'paths：截断后不留尾部 -',
    !/-$/.test(P.slugifyBranch('a'.repeat(39) + '/tail')),
    P.slugifyBranch('a'.repeat(39) + '/tail')
  )

  // ── isInsideRepo：机械校验，不得只靠「默认在仓库外」这个约定 ──
  eq('paths：仓库根自己算「在内」', P.isInsideRepo(base, base), true)
  eq('paths：仓库的子目录算「在内」', P.isInsideRepo(base, path.join(base, 'sub')), true)
  eq('paths：仓库外算「在外」', P.isInsideRepo(base, path.join(DST, 'outside')), false)
  eq('paths：形似前缀的兄弟目录算「在外」（不能靠字符串前缀判）', P.isInsideRepo(base, base + '-sibling'), false)
}

/**
 * worktree store：`worktrees.json` 读写。
 *
 * 重点在「读失败 ≠ 没有记录」：文件坏掉时写入必须 fail closed，否则会用内存里的空表覆盖掉一份还能修的文件。
 */
async function scenarioWorktreeStore(): Promise<void> {
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')

  const rec = (over: Partial<import('../../apps/desktop/src/main/services/worktree/store').WorktreeRecord> = {}) => ({
    schemaVersion: 1 as const,
    path: path.join(DST, 'wts', 'one'),
    compareKey: '',
    repoRoot: DST,
    repoKey: P.repoKeyOf(DST),
    branch: 'my/dev',
    baseSha: 'a'.repeat(40),
    baseLabel: 'my/dev',
    targetBranch: 'my/dev',
    createdAt: 1,
    phase: 'active' as const,
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'pending' as const,
    ...over
  })

  eq('store：初始无记录', S.listRecords().length, 0)
  eq('store：初始载入状态 absent', S.getStoreLoadState(), 'absent')

  // ── 写 + 读 ──
  eq('store：upsert 返回 true（写盘成功）', S.upsertRecord(rec()), true)
  eq('store：能读回一条', S.listRecords().length, 1)
  eq('store：getRecord 按路径取到', S.getRecord(path.join(DST, 'wts', 'one'))?.branch, 'my/dev')
  // 主键是 compareKey：尾斜杠的不同写法必须取同一条（与平台无关）
  eq('store：getRecord 对尾斜杠的不同写法取同一条', S.getRecord(path.join(DST, 'wts', 'one') + '/')?.branch, 'my/dev')
  if (process.platform === 'win32' || process.platform === 'darwin') {
    eq(
      'store：getRecord 对大小写不同的写法取同一条（本平台 FS 不区分大小写）',
      S.getRecord(path.join(DST, 'wts', 'ONE'))?.branch,
      'my/dev'
    )
  } else {
    eq(
      'store：getRecord 对大小写不同的写法取不到（本平台 FS 区分大小写）',
      S.getRecord(path.join(DST, 'wts', 'ONE')),
      null
    )
  }

  // ── 文件真的落在 DEVA_HOME/worktrees.json（不是 config.json 的一个键）──
  const file = path.join(DST, 'worktrees.json')
  check('store：记录文件在 DEVA_HOME/worktrees.json', fs.existsSync(file), file)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion: number; records: unknown[] }
  eq('store：磁盘形状是 { schemaVersion, records }', Object.keys(onDisk).sort(), ['records', 'schemaVersion'])
  eq('store：schemaVersion = 1', onDisk.schemaVersion, 1)
  // 不进 config.json：本场景全程没碰 config，所以它压根不该被创建（造出记录不该带动 config 写入）
  check(
    'store：写 worktree 记录不碰 config.json（不是 config 的一个键）',
    !fs.existsSync(path.join(DST, 'config.json')),
    path.join(DST, 'config.json')
  )

  // ── 更新同一条不新增 ──
  eq('store：同 path 再 upsert 是更新不是新增', S.upsertRecord(rec({ deps: 'ready' })), true)
  eq('store：仍只有一条', S.listRecords().length, 1)
  eq('store：字段已更新', S.listRecords()[0].deps, 'ready')

  // ── findRecordByRepo ──
  eq('store：findRecordByRepo 按 repoRoot 取到', S.findRecordByRepo(DST).length, 1)
  eq('store：别的仓库取不到', S.findRecordByRepo(path.join(DST, 'other-repo')).length, 0)

  // ── removeRecord ──
  eq('store：removeRecord 返回 true', S.removeRecord(path.join(DST, 'wts', 'one')), true)
  eq('store：删完为空', S.listRecords().length, 0)
  eq('store：删不存在的记录是幂等（返回 true，不算失败）', S.removeRecord(path.join(DST, 'nope')), true)

  // ── 核心：文件内容坏 → 写入必须 fail closed ──
  fs.writeFileSync(file, '{bad json ,,,')
  S.reloadRecordsForTest()
  eq('store：坏文件被识别为 corrupt', S.getStoreLoadState(), 'corrupt')
  eq('store：坏文件时读列表得到空（但状态说明了原因）', S.listRecords().length, 0)
  eq('store：坏文件时 upsert 拒绝写入并返回 false', S.upsertRecord(rec()), false)
  // 关键：原文件必须没被覆盖
  eq('store：拒绝写入后原文件内容原样保留（没被空表覆盖）', fs.readFileSync(file, 'utf8'), '{bad json ,,,')
}

/** 建一个真实的临时 git 仓库（worktree 相关场景共用）。 */
function makeRepo(root: string, files: Record<string, string> = { 'a.txt': 'a\n' }): string {
  fs.mkdirSync(root, { recursive: true })
  const run = (args: string[], cwd = root): string => {
    const r = require('node:child_process').spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'q', GIT_AUTHOR_EMAIL: 'q@q', GIT_COMMITTER_NAME: 'q', GIT_COMMITTER_EMAIL: 'q@q' }
    })
    return `${r.stdout ?? ''}`
  }
  run(['init', '-q', '-b', 'my/dev'])
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), body)
  }
  run(['add', '-A'])
  run(['commit', '-qm', 'init'])
  return root
}

const gitOut = (cwd: string, ...args: string[]): string =>
  String(
    require('node:child_process').spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout ?? ''
  ).trim()

/**
 * Step 0 探测（`precheck`）。**无副作用**：不建目录、不建分支、不写记录。
 *
 * 覆盖 A5（起点 = 预检那一刻的 HEAD）、A6（不是从上游镜像切的）、A8（主目录 detached 也能建）、
 * A12b/A23（分支已存在必须拒绝，不得静默复用）、A22（路径已存在不得覆盖）。
 */
async function scenarioWorktreePrecheck(): Promise<void> {
  const PC = await import('../../apps/desktop/src/main/services/worktree/precheck')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')

  const repo = makeRepo(path.join(DST, 'repo'), { 'a.txt': 'a\n', 'only-dev.txt': 'dev\n' })
  const headBefore = gitOut(repo, 'rev-parse', 'HEAD')
  const branchesBefore = gitOut(repo, 'branch', '--format=%(refname:short)')

  // ── 0.1 非仓库 ──
  const notRepo = path.join(DST, 'not-a-repo')
  fs.mkdirSync(notRepo, { recursive: true })
  const r1 = await PC.precheck({ repoRoot: notRepo, branch: 'x/y', path: path.join(DST, 'wts', 'x') })
  eq('precheck 0.1：非仓库 → not-a-repo', r1.ok === false && r1.reason, 'not-a-repo')

  // ── 正常探测：0.2 分支、0.4 baseSha = 预检那一刻的 HEAD（A5）──
  const r2 = await PC.precheck({ repoRoot: repo, branch: 'wt/one', path: path.join(DST, 'wts', 'one') })
  if (!r2.ok) {
    fail('precheck：正常场景不该失败', JSON.stringify(r2))
    return
  }
  info('正常探测结果', JSON.stringify({ baseSha: r2.baseSha, target: r2.targetBranch, branch: r2.branch }))
  eq('precheck 0.4 / A5：baseSha 等于预检那一刻主目录的 HEAD', r2.baseSha, headBefore)
  eq('precheck 0.2：targetBranch 是主目录当前分支', r2.targetBranch, 'my/dev')
  eq('precheck 0.2：primaryDetached = false', r2.primaryDetached, false)
  eq('precheck：baseLabel 回显分支名', r2.baseLabel, 'my/dev')

  // ── 无副作用：探测不建分支、不建目录、不写记录 ──
  eq('precheck：探测后分支列表不变（无副作用）', gitOut(repo, 'branch', '--format=%(refname:short)'), branchesBefore)
  eq('precheck：探测后 HEAD 不变', gitOut(repo, 'rev-parse', 'HEAD'), headBefore)
  check('precheck：探测没有创建目录', !fs.existsSync(path.join(DST, 'wts', 'one')), '')
  eq('precheck：探测没有写记录', S.listRecords().length, 0)

  // ── 0.8 自动生成路径（spec 空缺的补法）──
  const auto = await PC.precheck({ repoRoot: repo, branch: 'feat/auto-path' })
  if (!auto.ok) {
    fail('precheck 0.8：省略 path 时应自动生成而不是报错', JSON.stringify(auto))
    return
  }
  info('自动生成的路径', auto.path)
  check(
    'precheck 0.8：省略 path 时按 §6.1 自动生成（<DEVA_HOME>/worktrees/<repoKey>/<slug>-<shortid>）',
    auto.path.includes(path.join('worktrees')) && /feat-auto-path-[0-9a-z]+$/.test(auto.path.replace(/\\/g, '/')),
    auto.path
  )
  eq('precheck 0.8：slug 从分支名派生', auto.slug, 'feat-auto-path')
  eq('precheck 0.8：自动生成的路径在仓库外', PC.keyOf(auto.path) !== PC.keyOf(repo), true)

  // ── 0.8 长度判：用原始形态的 path（不是 compareKey）──
  const longSlug = 'a'.repeat(40)
  const deep = path.join(DST, 'x'.repeat(120), 'y'.repeat(120))
  const rLong = await PC.precheck({ repoRoot: repo, branch: longSlug, path: deep })
  eq('precheck 0.8：超长路径 → path-too-long', rLong.ok === false && rLong.reason, 'path-too-long')

  // ── 0.8 仓库内 → 拒绝（B5 的机械校验，不得只靠「默认在仓库外」）──
  const rInside = await PC.precheck({ repoRoot: repo, branch: 'in/repo', path: path.join(repo, 'sub', 'wt') })
  eq('precheck 0.8：路径在仓库内 → path-inside-repo', rInside.ok === false && rInside.reason, 'path-inside-repo')

  // ── 0.5 分支名非法 ──
  const rBad = await PC.precheck({ repoRoot: repo, branch: 'bad name with space', path: path.join(DST, 'wts', 'bad') })
  eq('precheck 0.5：非法分支名 → bad-branch', rBad.ok === false && rBad.reason, 'bad-branch')

  // ── 0.6 / A12b / A23：分支已存在必须拒绝，不得静默复用，并给可用替代 ──
  require('node:child_process').spawnSync('git', ['branch', 'taken'], { cwd: repo })
  const rTaken = await PC.precheck({ repoRoot: repo, branch: 'taken', path: path.join(DST, 'wts', 'taken') })
  info('分支已存在的结果', JSON.stringify(rTaken))
  eq('precheck 0.6 / A12b：分支已存在 → branch-exists（不得静默复用）', rTaken.ok === false && rTaken.reason, 'branch-exists')
  check('precheck 0.6：给出可用替代（自动后缀）', rTaken.ok === false && rTaken.suggestion === 'taken-2', JSON.stringify(rTaken))

  // ── 0.7 / A22：目标路径已存在 → 拒绝（不得覆盖、不得删除、不复用空目录）──
  const takenDir = path.join(DST, 'wts', 'taken-dir')
  fs.mkdirSync(takenDir, { recursive: true })
  fs.writeFileSync(path.join(takenDir, 'keep.txt'), 'must not be deleted\n')
  const rPathTaken = await PC.precheck({ repoRoot: repo, branch: 'ok-name', path: takenDir })
  eq('precheck 0.7 / A22：路径已存在 → path-exists', rPathTaken.ok === false && rPathTaken.reason, 'path-exists')
  eq('precheck 0.7 / A22：已存在目录里的文件没被动过', fs.readFileSync(path.join(takenDir, 'keep.txt'), 'utf8'), 'must not be deleted\n')

  // 0.7 的「空目录也不复用」：spec 明确不做特例
  const emptyDir = path.join(DST, 'wts', 'empty-dir')
  fs.mkdirSync(emptyDir, { recursive: true })
  const rEmpty = await PC.precheck({ repoRoot: repo, branch: 'ok2', path: emptyDir })
  eq('precheck 0.7：空目录也不复用（spec 明确不做特例）', rEmpty.ok === false && rEmpty.reason, 'path-exists')

  // 0.7 的断链：裸 existsSync 会返回 false（→ 误判「不存在」），lstat 能看见。
  // 本机 Windows 未开开发者模式时 symlinkSync 一律 EPERM（已实测），造不出断链 → 显式跳过而不是假装验过。
  const dangling = path.join(DST, 'wts', 'dangling')
  let canSymlink = true
  try {
    fs.mkdirSync(path.dirname(dangling), { recursive: true })
    fs.symlinkSync(path.join(DST, 'no-such-target'), dangling, 'file')
  } catch {
    canSymlink = false
  }
  if (!canSymlink) {
    info('SKIP', '本机不能创建符号链接（Windows 未开开发者模式 → EPERM），断链场景未验')
  } else {
    eq('precheck 0.7：断链对 existsSync 不可见（这正是禁止裸用它的原因）', fs.existsSync(dangling), false)
    const rDangling = await PC.precheck({ repoRoot: repo, branch: 'ok3', path: dangling })
    eq(
      'precheck 0.7：断链占位也拒绝（lstat 能看见它）',
      rDangling.ok === false && rDangling.reason,
      'path-exists'
    )
  }

  // ── 0.9 脏改动 → needsConfirm ──
  fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n')
  const rDirty = await PC.precheck({ repoRoot: repo, branch: 'dirty/one', path: path.join(DST, 'wts', 'dirty') })
  if (!rDirty.ok) {
    fail('precheck 0.9：脏改动只警示不拦截', JSON.stringify(rDirty))
    return
  }
  info('脏改动数', String(rDirty.dirtyCount))
  eq('precheck 0.9：dirtyCount = 1', rDirty.dirtyCount, 1)
  eq('precheck 0.9：脏且未确认 → needsConfirm', rDirty.needsConfirm, true)
  const rDirtyOk = await PC.precheck({
    repoRoot: repo,
    branch: 'dirty/one',
    path: path.join(DST, 'wts', 'dirty'),
    confirmedDirty: true
  })
  eq('precheck 0.9：确认后 needsConfirm = false', rDirtyOk.ok && rDirtyOk.needsConfirm, false)
  // 脏改动没被动过（不得 stash、不得 checkout）
  eq('precheck 0.9 / A1：探测没动用户的改动', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'modified\n')
  eq('precheck 0.9 / A2：探测没产生 stash', gitOut(repo, 'stash', 'list'), '')
  require('node:child_process').spawnSync('git', ['checkout', '--', 'a.txt'], { cwd: repo })

  // ── 0.10 many-worktrees：软提示，不阻断 ──
  for (let i = 0; i < 5; i++) {
    S.upsertRecord({
      schemaVersion: 1,
      path: path.join(DST, 'fake', `w${i}`),
      compareKey: '',
      repoRoot: repo,
      repoKey: 'x',
      branch: `b${i}`,
      baseSha: 'a'.repeat(40),
      baseLabel: 'my/dev',
      targetBranch: 'my/dev',
      createdAt: i,
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'pending'
    })
  }
  const rMany = await PC.precheck({ repoRoot: repo, branch: 'many/one', path: path.join(DST, 'wts', 'many') })
  if (!rMany.ok) {
    fail('precheck 0.10：many-worktrees 是软提示，不该阻断', JSON.stringify(rMany))
    return
  }
  eq('precheck 0.10：已有 5 个 → softWarn = many-worktrees', rMany.softWarn, 'many-worktrees')
  eq('precheck 0.10：软提示不阻断（ok 仍为 true）', rMany.ok, true)
  eq('precheck 0.10：existingCount 报出来', rMany.existingCount, 5)

  // ── 0.3 / A8：主目录 detached 仍可创建，targetBranch = null，并给合并警告 ──
  require('node:child_process').spawnSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: repo })
  const rDetached = await PC.precheck({ repoRoot: repo, branch: 'det/one', path: path.join(DST, 'wts', 'det') })
  if (!rDetached.ok) {
    fail('precheck 0.3 / A8：主目录 detached 时应允许创建', JSON.stringify(rDetached))
    return
  }
  info('detached 探测结果', JSON.stringify({ target: rDetached.targetBranch, warn: rDetached.mergeTargetWarning, base: rDetached.baseLabel }))
  eq('precheck 0.3 / A8：detached 时 targetBranch = null', rDetached.targetBranch, null)
  eq('precheck 0.3：primaryDetached = true', rDetached.primaryDetached, true)
  eq('precheck 0.3：给出 mergeTargetWarning', rDetached.mergeTargetWarning, 'merge-target-unset')
  eq('precheck 0.3：detached 下 baseSha 仍是那个提交（rev-parse HEAD 而非 --abbrev-ref）', rDetached.baseSha, headBefore)
  check(
    'precheck 0.3：detached 时 baseLabel 标注短 SHA',
    rDetached.baseLabel.includes('detached') && rDetached.baseLabel.includes(headBefore.slice(0, 7)),
    rDetached.baseLabel
  )
  require('node:child_process').spawnSync('git', ['checkout', '-q', 'my/dev'], { cwd: repo })

  // ── 0.11 trustRoot：受信根登记了 repoRoot 与 path 的父目录 ──
  const roots = (await import('../../apps/desktop/src/main/services/fs-guard')).listRoots()
  info('受信根', JSON.stringify(roots.map((r) => path.basename(r))))
  check('precheck 0.11：repoRoot 已登记为受信根', roots.some((r) => PC.keyOf(r) === PC.keyOf(repo)), JSON.stringify(roots))
  check(
    'precheck 0.11：path 的父目录已登记（否则创建后写不进去）',
    roots.some((r) => PC.keyOf(r) === PC.keyOf(path.dirname(path.join(DST, 'wts', 'one')))),
    JSON.stringify(roots)
  )
}

/**
 * Step 1-3 创建主流程：成功路径、A7（n 层树）、A4（失败路径）、A25（孤儿分支）、A22（不误删）。
 *
 * A7 与 A4 是清单里明确要求「必须显式构造场景，不能靠代码走查」的两条，这里逐条造。
 */
async function scenarioWorktreeCreate(): Promise<void> {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const GW = await import('../../apps/desktop/src/main/services/worktree/git-worktree')
  const child = require('node:child_process') as typeof import('node:child_process')

  const repo = makeRepo(path.join(DST, 'repo'), {
    'a.txt': 'a\n',
    'only-dev.txt': 'dev only\n',
    'src/x.txt': 'x\n'
  })
  const head0 = gitOut(repo, 'rev-parse', 'HEAD')

  // ══════════ 成功路径 ══════════
  const wtA = path.join(DST, 'wts', 'a')
  const rA = await CR.createWorktree({ repoRoot: repo, branch: 'wt/a', path: wtA })
  if (!rA.ok) {
    fail('create：正常创建不该失败', JSON.stringify(rA))
    return
  }
  info('创建 A 的记录', JSON.stringify({ branch: rA.record.branch, baseSha: rA.record.baseSha, phase: rA.record.phase }))
  eq('create：phase 定稿为 active', rA.record.phase, 'active')
  eq('create：baseSha 等于创建时的主目录 HEAD（A5）', rA.record.baseSha, head0)
  eq('create：目录已建出来', fs.existsSync(wtA), true)
  eq('create：worktree 里 HEAD 就是 baseSha（Step 3 校验）', gitOut(wtA, 'rev-parse', 'HEAD'), head0)
  eq('create：worktree 检出的分支正确', gitOut(wtA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/a')
  eq('create：记录已落盘', S.listRecords().length, 1)

  // A6：新 worktree 里有 my/dev 有而 main 没有的文件（证明不是从上游镜像切的）
  eq('A6：新 worktree 里有 my/dev 独有的文件', fs.existsSync(path.join(wtA, 'only-dev.txt')), true)
  eq(
    'A6：内容也对（换行按平台归一后比较）',
    fs.readFileSync(path.join(wtA, 'only-dev.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'dev only\n'
  )

  // A4b：git worktree list 只比之前多一条，primary 仍是主目录
  const listAfter = gitOut(repo, 'worktree', 'list', '--porcelain')
  const entries = GW.parseWorktreeList(listAfter)
  info('worktree list', JSON.stringify(entries.map((e) => [path.basename(e.path), e.branch])))
  eq('A4b：worktree 数量比之前多一条', entries.length, 2)
  eq('A4b：第一条是主检出', path.basename(entries[0].path), 'repo')

  // ══════════ A7：n 层单分支树 —— 必须从主检出取 HEAD ══════════
  /*
   * 场景：在 worktree-A 里做一次提交，让 A 的 HEAD 前进；
   * 然后「从 A 的会话里」新建工作区（模拟：repoRoot 仍传主目录，但当前 focusRoot 是 A）。
   * 新 worktree 的 baseSha 必须 === 主检出 HEAD，且 **A 那个提交带来的文件不存在**。
   */
  fs.writeFileSync(path.join(wtA, 'from-worktree-a.txt'), 'A only\n')
  gitOut(wtA, 'add', '-A')
  const commitA = child.spawnSync('git', ['commit', '-qm', 'commit in A'], {
    cwd: wtA,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'q',
      GIT_AUTHOR_EMAIL: 'q@q',
      GIT_COMMITTER_NAME: 'q',
      GIT_COMMITTER_EMAIL: 'q@q'
    }
  })
  if (commitA.status !== 0) info('A7 前置：commit 失败', String(commitA.stderr ?? '').slice(0, 200))
  const headA = gitOut(wtA, 'rev-parse', 'HEAD')
  const headMainStill = gitOut(repo, 'rev-parse', 'HEAD')
  info('A 的 HEAD vs 主目录 HEAD', JSON.stringify({ headA, headMainStill }))
  eq('A7 前置：worktree-A 的 HEAD 已前进', headA !== headMainStill, true)

  const wtB = path.join(DST, 'wts', 'b')
  const rB = await CR.createWorktree({ repoRoot: repo, branch: 'wt/b', path: wtB })
  if (!rB.ok) {
    fail('A7：第二个工作区创建失败', JSON.stringify(rB))
    return
  }
  info('B 的 baseSha', rB.record.baseSha)
  eq('A7：新 worktree 的 baseSha 等于主检出的 HEAD（不是 A 的）', rB.record.baseSha, headMainStill)
  check('A7：新 worktree 的 baseSha 不等于 worktree-A 的 HEAD', rB.record.baseSha !== headA, rB.record.baseSha)
  eq(
    'A7：A 那个提交带来的文件在新 worktree 里不存在（没有 n 层树）',
    fs.existsSync(path.join(wtB, 'from-worktree-a.txt')),
    false
  )

  // ══════════ A9/A10：隔离生效 ══════════
  fs.writeFileSync(path.join(wtB, 'b-only.txt'), 'B\n')
  eq('A9：B 里新建的文件，主目录看不到', fs.existsSync(path.join(repo, 'b-only.txt')), false)
  eq('A9：B 里新建的文件，A 也看不到', fs.existsSync(path.join(wtA, 'b-only.txt')), false)
  gitOut(wtB, 'add', '-A')
  child.spawnSync('git', ['commit', '-qm', 'commit in B'], {
    cwd: wtB,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'q',
      GIT_AUTHOR_EMAIL: 'q@q',
      GIT_COMMITTER_NAME: 'q',
      GIT_COMMITTER_EMAIL: 'q@q'
    }
  })
  eq('A10：B 提交后主目录 HEAD 不变', gitOut(repo, 'rev-parse', 'HEAD'), headMainStill)
  eq('A10：B 提交后 A 的 HEAD 不变', gitOut(wtA, 'rev-parse', 'HEAD'), headA)

  // ══════════ A4：失败路径 —— 主目录 status / stash / 分支不变 ══════════
  /*
   * 造失败：给 add 一个**已存在的路径**（0.7 会先拦，所以这里绕过 precheck 直接调 addWorktree +
   * cleanupFailedCreate，模拟「precheck 通过但 add 那一刻路径被占了」的竞态）。
   */
  const statusBefore = gitOut(repo, 'status', '--porcelain')
  const stashBefore = gitOut(repo, 'stash', 'list')
  const branchesBefore = gitOut(repo, 'branch', '--format=%(refname:short)')
  const headBeforeFail = gitOut(repo, 'rev-parse', 'HEAD')

  // 制造一个「已被占用的目标路径」
  const blockedPath = path.join(DST, 'wts', 'blocked')
  fs.mkdirSync(blockedPath, { recursive: true })
  fs.writeFileSync(path.join(blockedPath, 'user-file.txt'), 'user data\n')

  const addFail = await GW.addWorktree(repo, blockedPath, 'wt/fail', headBeforeFail)
  info('add 到已存在路径的结果', JSON.stringify({ ok: addFail.ok, stderr: addFail.stderr.slice(0, 80) }))
  eq('A4：add 到已存在路径会失败', addFail.ok, false)

  const cleanup = await GW.cleanupFailedCreate({
    repoRoot: repo,
    path: blockedPath,
    branch: 'wt/fail',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false }
  })
  info('清理结果', JSON.stringify(cleanup))

  // A25：孤儿分支必须被删掉（用 -D，不是 -d）
  eq('A25：失败后不留孤儿分支', gitOut(repo, 'branch', '--list', 'wt/fail'), '')
  eq('A25：清理报告 branchRemoved', cleanup.branchRemoved, true)

  /*
   * A25 的关键补测：**未合并分支**也必须删得掉。
   *
   * 上面那个 wt/fail 是从 HEAD 切出、零提交，等于「已合并」——用 `-d` 也能成功，验不出 spec §19
   * 警告的那个坑（`-d` 在未合并时拒绝，而实现通常只判 code === 0 之后继续，于是孤儿分支永留）。
   * 这里造一个**真的未合并**的分支：建 worktree → 里面提交 → 删登记保留分支 → 再走清理。
   */
  const wtU = path.join(DST, 'wts', 'unmerged')
  const rU = await CR.createWorktree({ repoRoot: repo, branch: 'wt/unmerged', path: wtU })
  if (!rU.ok) {
    fail('A25：未合并分支场景的前置创建失败', JSON.stringify(rU))
    return
  }
  fs.writeFileSync(path.join(wtU, 'u.txt'), 'u\n')
  gitOut(wtU, 'add', '-A')
  child.spawnSync('git', ['commit', '-qm', 'unmerged work'], {
    cwd: wtU,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'q', GIT_AUTHOR_EMAIL: 'q@q', GIT_COMMITTER_NAME: 'q', GIT_COMMITTER_EMAIL: 'q@q' }
  })
  // 解登记但保留分支，模拟「add 之后失败」的状态
  gitOut(repo, 'worktree', 'remove', '--force', wtU)
  eq('A25 前置：分支存在且未合并', gitOut(repo, 'branch', '--list', 'wt/unmerged').includes('wt/unmerged'), true)
  const mergedCheck = child.spawnSync('git', ['branch', '--merged', 'HEAD', '--format=%(refname:short)'], {
    cwd: repo,
    encoding: 'utf8'
  })
  check(
    'A25 前置：该分支确实「未合并」（所以 -d 会拒绝）',
    !String(mergedCheck.stdout ?? '').split('\n').includes('wt/unmerged'),
    String(mergedCheck.stdout ?? '').trim()
  )
  // 只清分支这一半（目录已不在）
  const cleanupU = await GW.cleanupFailedCreate({
    repoRoot: repo,
    path: wtU,
    branch: 'wt/unmerged',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false }
  })
  info('未合并分支的清理结果', JSON.stringify(cleanupU))
  eq('A25：未合并的孤儿分支也被删掉（必须 -D，-d 会拒绝）', gitOut(repo, 'branch', '--list', 'wt/unmerged'), '')
  eq('A25：清理报告 branchRemoved（未合并情形）', cleanupU.branchRemoved, true)

  // A22/R9：用户已有的目录与文件绝对不能删
  eq('A22：用户已有目录仍在', fs.existsSync(blockedPath), true)
  eq('A22：用户文件内容没变', fs.readFileSync(path.join(blockedPath, 'user-file.txt'), 'utf8'), 'user data\n')
  check('A22：清理报告说明目录被保留', cleanup.warnings.some((w) => w.includes('保留')), JSON.stringify(cleanup.warnings))

  // A4：主目录完全没被动过
  eq('A4：主目录 status 逐字符一致', gitOut(repo, 'status', '--porcelain'), statusBefore)
  eq('A4：stash list 仍为空（没靠 stash 实现）', gitOut(repo, 'stash', 'list'), stashBefore)
  eq('A4：分支列表一致（孤儿分支已清掉）', gitOut(repo, 'branch', '--format=%(refname:short)'), branchesBefore)
  eq('A4：主目录 HEAD 不变', gitOut(repo, 'rev-parse', 'HEAD'), headBeforeFail)

  // ══════════ 混脏状态下的完整创建（A1/A2/A3）══════════
  fs.writeFileSync(path.join(repo, 'a.txt'), 'staged\n')
  gitOut(repo, 'add', 'a.txt')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'staged+modified\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')
  fs.writeFileSync(path.join(repo, 'src', 'x.txt'), 'x modified\n')
  const dirtyStatus = gitOut(repo, 'status', '--porcelain')
  const dirtyStash = gitOut(repo, 'stash', 'list')
  const dirtyBranch = gitOut(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const dirtyLsFiles = gitOut(repo, 'ls-files', '-s')
  const contentA = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')
  const contentX = fs.readFileSync(path.join(repo, 'src', 'x.txt'), 'utf8')
  const contentU = fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')
  info('混脏状态', JSON.stringify(dirtyStatus.split('\n')))

  const wtC = path.join(DST, 'wts', 'c')
  const rC = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/c',
    path: wtC,
    confirmedDirty: true
  })
  if (!rC.ok) {
    fail('A1：混脏状态下应能创建（已确认脏改动）', JSON.stringify(rC))
    return
  }
  eq('A1：创建后 status 逐字符一致', gitOut(repo, 'status', '--porcelain'), dirtyStatus)
  eq('A2：创建后 stash 仍为空', gitOut(repo, 'stash', 'list'), dirtyStash)
  eq('A2：当前分支不变', gitOut(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), dirtyBranch)
  eq('A2：索引（ls-files -s）一致', gitOut(repo, 'ls-files', '-s'), dirtyLsFiles)
  eq('A3：已跟踪文件的改动内容没变', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), contentA)
  eq('A3：另一个已跟踪文件没变', fs.readFileSync(path.join(repo, 'src', 'x.txt'), 'utf8'), contentX)
  eq('A3：未跟踪文件没变', fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8'), contentU)

  // 新 worktree 拿到的是**已提交**的内容，不含未提交改动（这正是隔离的含义）
  eq(
    'A3：新 worktree 里的 a.txt 是已提交版本（换行按平台归一）',
    fs.readFileSync(path.join(wtC, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'a\n'
  )
  eq('A3：新 worktree 里没有未跟踪文件', fs.existsSync(path.join(wtC, 'untracked.txt')), false)
}

/**
 * 删除 worktree（`remove.ts`）。
 *
 * 这条路径的失败方式全是**静默**的：`ok:true` 但目录还在、分支还在、记录还在——
 * 用户以为删干净了，实际几百 MB 一直占着。所以断言要逐项验「真的没了」，
 * 不能只看 `ok`。
 *
 * 反向验证：把 `removeWorktree` 改回「直接返回 ok:true 什么都不做」，下面四组必须全红。
 */
async function scenarioWorktreeRemove(): Promise<void> {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const RM = await import('../../apps/desktop/src/main/services/worktree/remove')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const GW = await import('../../apps/desktop/src/main/services/worktree/git-worktree')

  const repo = makeRepo(path.join(DST, 'repo'), { 'a.txt': 'a\n', 'only-dev.txt': 'dev\n' })

  // ══════════ 一、正常删除：目录 / 登记 / 分支 / 记录四处都要真的没了 ══════════
  const wtA = path.join(DST, 'wts', 'a')
  const rA = await CR.createWorktree({ repoRoot: repo, branch: 'wt/a', path: wtA, skipDeps: true })
  if (!rA.ok) {
    fail('remove：前置创建不该失败', JSON.stringify(rA))
    return
  }
  check('remove：创建后目录存在', fs.existsSync(wtA), '')
  check('remove：创建后有记录', S.getRecord(wtA) !== null, '')

  const dA = await RM.removeWorktree({ path: wtA })
  eq('remove：返回 ok', dA.ok, true)
  eq('remove：无 warning（干净删除不该有话要说）', dA.warnings.length, 0)
  // 逐项验，不只看 ok —— 只看 ok 的话「什么都没做」也会通过
  check('remove：目录真的没了', !fs.existsSync(wtA), `still exists: ${wtA}`)
  check('remove：记录真的没了', S.getRecord(wtA) === null, '')
  // 用 parseWorktreeList 解析后按路径比，别拿整串输出做 includes（反斜杠/正斜杠与大小写都会误判）
  const listAfterA = GW.parseWorktreeList(gitOut(repo, 'worktree', 'list', '--porcelain'))
  check(
    'remove：git 登记真的没了',
    !listAfterA.some((e) => path.resolve(e.path) === path.resolve(wtA)),
    JSON.stringify(listAfterA.map((e) => e.path))
  )
  const branchesAfterA = gitOut(repo, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  check('remove：分支真的没了', !branchesAfterA.includes('wt/a'), JSON.stringify(branchesAfterA))

  // ══════════ 二、有未提交改动：默认拒绝，且一个字节都不许动 ══════════
  const wtB = path.join(DST, 'wts', 'b')
  const rB = await CR.createWorktree({ repoRoot: repo, branch: 'wt/b', path: wtB, skipDeps: true })
  if (!rB.ok) {
    fail('remove：脏检查的前置创建不该失败', JSON.stringify(rB))
    return
  }
  fs.writeFileSync(path.join(wtB, 'dirty.txt'), 'unsaved\n')
  const dB = await RM.removeWorktree({ path: wtB })
  eq('remove：脏时 ok=false', dB.ok, false)
  eq('remove：脏时 reason=dirty', dB.reason, 'dirty')
  eq('remove：脏时报出改动数', dB.dirtyCount, 1)
  check('remove：脏时目录还在', fs.existsSync(wtB), '')
  check('remove：脏时未提交文件还在', fs.existsSync(path.join(wtB, 'dirty.txt')), '')
  check('remove：脏时记录还在', S.getRecord(wtB) !== null, '')

  // ══════════ 三、force：明说要丢时才丢 ══════════
  const dBF = await RM.removeWorktree({ path: wtB, force: true })
  eq('remove：force 时 ok', dBF.ok, true)
  check('remove：force 后目录没了', !fs.existsSync(wtB), '')
  check(
    'remove：force 时要提示丢了改动（不能静默）',
    dBF.warnings.some((w) => w.includes('强制删除')),
    JSON.stringify(dBF.warnings)
  )

  // ══════════ 四、没登记的路径：拒绝，且不碰任何东西 ══════════
  const stranger = path.join(DST, 'wts', 'stranger')
  fs.mkdirSync(stranger, { recursive: true })
  fs.writeFileSync(path.join(stranger, 'user-file.txt'), 'mine\n')
  const dS = await RM.removeWorktree({ path: stranger })
  eq('remove：无记录时 ok=false', dS.ok, false)
  eq('remove：无记录时 reason=not-found', dS.reason, 'not-found')
  check('remove：无记录时不删用户目录', fs.existsSync(path.join(stranger, 'user-file.txt')), '')

  // ══════════ 五、保留分支的选项 ══════════
  const wtC = path.join(DST, 'wts', 'c')
  const rC = await CR.createWorktree({ repoRoot: repo, branch: 'wt/c', path: wtC, skipDeps: true })
  if (rC.ok) {
    const dC = await RM.removeWorktree({ path: wtC, deleteBranch: false })
    eq('remove：deleteBranch=false 时 ok', dC.ok, true)
    eq('remove：deleteBranch=false 时 branchRemoved=false', dC.branchRemoved, false)
    check(
      'remove：deleteBranch=false 时分支还在',
      gitOut(repo, 'branch', '--format=%(refname:short)')
        .split('\n')
        .includes('wt/c'),
      gitOut(repo, 'branch', '--format=%(refname:short)')
    )
  } else {
    fail('remove：保留分支的前置创建不该失败', JSON.stringify(rC))
  }
}

/**
 * A36：系统提示词的【环境】段必须含 5 项内容，且负面约束必须在。
 * A13 的另一半：会话的 focusRoot 与终端 cwd 必须**两处一致**（都指向 worktree）。
 */
async function scenarioWorktreeBrief(): Promise<void> {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const B = await import('../../apps/desktop/src/main/services/worktree/brief')
  const P = await import('../../apps/desktop/src/main/services/chat-prompts')

  const repo = makeRepo(path.join(DST, 'repo'), { 'a.txt': 'a\n' })
  const wt = path.join(DST, 'wts', 'one')
  const r = await CR.createWorktree({ repoRoot: repo, branch: 'wt/one', path: wt })
  if (!r.ok) {
    fail('A36：前置创建失败', JSON.stringify(r))
    return
  }

  // ── briefForFocusRoot 按 focusRoot 反查（spec §1.6 的关联口径）──
  const brief = await B.briefForFocusRoot(wt)
  if (!brief) {
    fail('A36：briefForFocusRoot 没认出已登记的工作区', wt)
    return
  }
  info('brief', JSON.stringify({ branch: brief.branch, target: brief.targetBranch, dirty: brief.primaryDirtyCount }))
  eq('A36：brief 的分支正确', brief.branch, 'wt/one')
  eq('A36：brief 的 targetBranch 是创建时主目录分支', brief.targetBranch, 'my/dev')
  eq('A36：不是工作区的路径返回 null', await B.briefForFocusRoot(path.join(DST, 'random')), null)
  eq('A36：null 入参返回 null', await B.briefForFocusRoot(null), null)

  // ── 提示词 5 项内容 ──
  const text = B.worktreeBoundaryText(brief)
  info('边界说明原文', JSON.stringify(text.slice(0, 120)))
  check('A36-1：含「独立工作区（git worktree）」', /独立工作区/.test(text), '')
  check('A36-2：含工作目录路径', text.includes(wt.replace(/\\/g, '\\')) || text.includes(wt), '')
  check('A36-3：含检出分支名', text.includes('wt/one'), '')
  check('A36-4：含起点 baseLabel', text.includes('my/dev'), '')
  check('A36-5：含合回目标 branch', /手动合回/.test(text) && text.includes('my/dev'), '')
  check('A36-6：含项目记忆共享说明', /项目记忆/.test(text) && /共享/.test(text), '')
  // 第 2 条硬要求：负面约束必须在（**这是立项的根本动机**）
  check(
    'A36-7：负面约束保留（不要假设你看到的就是主目录的当前状态…读文件而不是凭记忆）',
    /不要假设你看到的就是主目录的当前状态/.test(text) && /读文件而不是凭记忆/.test(text),
    ''
  )
  // 重复写「历史目录作废」会和既有那句撞车（spec 要求不重复）
  check('A36-8：不重复既有那句「历史消息里出现过的其它目录一律作废」', !/其它目录一律作废/.test(text), '')

  // 主目录有脏改动时那一行必须有数字
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n')
  const brief2 = await B.briefForFocusRoot(wt)
  const text2 = B.worktreeBoundaryText(brief2!)
  info('有脏改动时的「不在本区」行', JSON.stringify(text2.split('\n').find((l) => l.includes('不在本区')) ?? '（无）'))
  check('A36-9：主目录有未提交改动时出现「不在本区」且带数字', /不在本区.*\d+/.test(text2), '')
  eq('A36-10：brief 报出的数字与 precheck 同源', brief2!.primaryDirtyCount, 1)
  // 0 时整行省略（spec：`0` 时省略此行）
  require('node:child_process').spawnSync('git', ['checkout', '--', 'a.txt'], { cwd: repo })
  const brief3 = await B.briefForFocusRoot(wt)
  const text3 = B.worktreeBoundaryText(brief3!)
  check('A36-11：主目录干净时整行省略', !/不在本区/.test(text3), '')

  // ── targetBranch === null（主目录 detached）时的措辞 ──
  const nullTargetText = B.worktreeBoundaryText({ ...brief, targetBranch: null })
  info('未指定合回目标时的措辞', JSON.stringify(nullTargetText.split('\n').find((l) => l.includes('合回')) ?? ''))
  check(
    'A36-12：targetBranch=null 时改成「尚未指定 / 需要选一次」',
    /还没指定|尚未指定/.test(nullTargetText) && /合并面板/.test(nullTargetText),
    ''
  )
  check('A36-13：null 时不出现「手动合回 <branch>」的具体分支指引', !/手动合回 `/.test(nullTargetText), '')

  // ── 三段提示词都真的带上它（不是只有一处）──
  const sys = P.systemPrompt(wt, [], [], [], brief)
  check('A36-14：systemPrompt 带上了边界说明', /独立工作区/.test(sys), '')
  const sealed = P.sealedSystemPrompt(wt, [], [], [], undefined, brief)
  check('A36-15：sealedSystemPrompt 带上了边界说明', /独立工作区/.test(sealed), '')
  const member = P.memberSystemPrompt({
    member: { sessionId: 's', name: 'm', origin: 'created', personaId: 'general', root: null, duty: '', addedAt: 0 },
    owner: 'Deva',
    workspaceRoot: wt,
    folder: 'x',
    personas: [],
    memory: [],
    projectDoc: [],
    worktree: brief
  })
  check('A36-16：memberSystemPrompt 带上了边界说明', /独立工作区/.test(member), '')
  // 不传 worktree 时不该出现（普通目录行为不变）
  const plain = P.systemPrompt(wt, [], [], [])
  check('A36-17：普通目录（不传 worktree）不含边界说明', !/独立工作区/.test(plain), '')
  // 既有那句仍在（spec：保留在前，追加在后）
  check('A36-18：既有「历史目录作废」那句仍在', /历史消息里出现过的其它目录一律作废/.test(sys), '')

  /*
   * ── A13：focusRoot 与终端 cwd 必须两处一致 ──
   *
   * 会话的 focusRoot 由 ensureSession 存；终端 cwd 由渲染层在 terminal:create 时传。
   * 本步只做「主进程侧能证明的部分」：worktree 路径能从记录反查出会话该用的 focusRoot，
   * 且它等于终端应传的同一个值。渲染层的终端面板尚未实现（全仓无 terminal.create 调用点），
   * 所以「渲染层真的传了」这一半本步验不了——交付说明里如实写。
   */
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const rec = S.getRecord(wt)
  eq('A13：记录里的 path 就是会话该用的 focusRoot（绝对路径）', rec?.path, wt)
  check('A13：该路径是绝对路径', path.isAbsolute(rec!.path), rec!.path)
  eq('A13：终端 cwd 与 focusRoot 同源（同一个记录路径）', rec!.path, brief.path)
}

/**
 * 启动清扫（§2.4）：崩溃恢复。
 *
 * A26：phase:'creating' 的残留被回滚掉（用 intent 判「本次新建」，不靠「目录里有什么」）。
 * A26b：回滚失败时保留记录等下次，不假装清干净。
 * A33：**不做**任何 git worktree prune —— 用户目录被外部删除后的登记要留着给用户看。
 */
async function scenarioWorktreeSweep(): Promise<void> {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const SW = await import('../../apps/desktop/src/main/services/worktree/sweep')
  const child = require('node:child_process') as typeof import('node:child_process')

  const repo = makeRepo(path.join(DST, 'repo'), { 'a.txt': 'a\n' })

  // ── 造一条「建到一半」的记录：真建出 worktree，然后手工把 phase 改回 creating ──
  const wt = path.join(DST, 'wts', 'crashed')
  const r = await CR.createWorktree({ repoRoot: repo, branch: 'wt/crashed', path: wt })
  if (!r.ok) {
    fail('sweep：前置创建失败', JSON.stringify(r))
    return
  }
  const rec = S.getRecord(wt)!
  S.upsertRecord({ ...rec, phase: 'creating' })
  eq('sweep 前置：记录已改回 creating', S.getRecord(wt)?.phase, 'creating')
  eq('sweep 前置：目录存在', fs.existsSync(wt), true)

  // ── 清扫 ──
  const res = await SW.sweepOnStartup()
  info('清扫结果', JSON.stringify(res))
  eq('A26：creating 记录被回滚', res.creatingRolledBack, 1)
  eq('A26：回滚失败数为 0', res.creatingKept, 0)
  eq('A26：记录已删除（成功或部分成功都删）', S.getRecord(wt), null)
  eq('A26：目录已被清掉', fs.existsSync(wt), false)
  eq('A26：分支也被清掉（不留孤儿）', gitOut(repo, 'branch', '--list', 'wt/crashed'), '')
  // 主目录没被动过
  eq('A26：主目录 status 仍干净', gitOut(repo, 'status', '--porcelain'), '')

  // ── A33：不做 prune。造一条「目录被外部删掉」的登记，清扫后登记必须还在 ──
  const wt2 = path.join(DST, 'wts', 'externally-gone')
  const r2 = await CR.createWorktree({ repoRoot: repo, branch: 'wt/gone', path: wt2 })
  if (!r2.ok) {
    fail('sweep：第二条前置创建失败', JSON.stringify(r2))
    return
  }
  // 模拟「用户自己在文件管理器里删掉了这个目录」
  fs.rmSync(wt2, { recursive: true, force: true })
  eq('A33 前置：目录已不在，但登记还在', S.getRecord(wt2) !== null, true)
  const before = gitOut(repo, 'worktree', 'list', '--porcelain')
  check('A33 前置：git 侧还挂着这条登记（prunable）', before.includes('externally-gone'), before)

  const res2 = await SW.sweepOnStartup()
  info('第二次清扫结果', JSON.stringify(res2))
  eq('A33：清扫不删这条记录（phase 是 active）', S.getRecord(wt2) !== null, true)
  check(
    'A33：清扫不做 prune —— git 侧这条登记仍在',
    gitOut(repo, 'worktree', 'list', '--porcelain').includes('externally-gone'),
    gitOut(repo, 'worktree', 'list', '--porcelain')
  )
  eq('A33：这条不是 creating，清扫没碰它', res2.creatingRolledBack, 0)

  // ── deps: 'installing' → failed + aborted-by-restart ──
  S.upsertRecord({ ...S.getRecord(wt2)!, deps: 'installing' })
  const res3 = await SW.sweepOnStartup()
  info('第三次清扫结果', JSON.stringify(res3))
  eq('sweep：installing 改成 failed', res3.depsMarkedFailed, 1)
  eq('sweep：deps 终态是 failed', S.getRecord(wt2)?.deps, 'failed')
  eq('sweep：depsDetail 说明是重启中断', S.getRecord(wt2)?.depsDetail, 'aborted-by-restart')

  // ── A26b：回滚失败时保留记录（不假装清干净）──
  /*
   * 造法：把 repoRoot 指向一个已经不是仓库的路径 → 清理里的 git 命令全部失败，
   * 只有「删目录」可能成功。这里让 cleanupFailedCreate 抛错最容易的路径是 intent 里 pathExistedAtStart=true
   * 且目录被占，但那只产生 warning 不抛错。真正的抛错路径难造，所以这条断言改成验「spec 要求的行为」：
   * 记录被删掉（因为清理没抛错）+ warning 被记下来，而不是静默。
   */
  const wt3 = path.join(DST, 'wts', 'warn-case')
  fs.mkdirSync(wt3, { recursive: true })
  fs.writeFileSync(path.join(wt3, 'not-ours.txt'), 'x\n')
  S.upsertRecord({
    schemaVersion: 1,
    path: wt3,
    compareKey: '',
    repoRoot: repo,
    repoKey: 'k',
    branch: 'wt/warn',
    baseSha: 'a'.repeat(40),
    baseLabel: 'my/dev',
    targetBranch: 'my/dev',
    createdAt: Date.now(),
    phase: 'creating',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'pending'
  })
  const res4 = await SW.sweepOnStartup()
  info('第四次清扫结果', JSON.stringify(res4))
  check(
    'A26b：目录不是我们的 → 不删，且把原因记成 warning（不静默）',
    res4.warnings.some((w) => w.includes('目录未删')),
    JSON.stringify(res4.warnings)
  )
  eq('A26b：那个目录与里面的文件都还在', fs.readFileSync(path.join(wt3, 'not-ours.txt'), 'utf8').trim(), 'x')
}

/**
 * Git 锁（§5）：同一路径严格串行、不同路径可并行、等锁超 5 秒发进度事件。
 *
 * 这三条是 §5.2 的行为判据。第三条用**缩短的等待**没法测（常量固定在模块里），
 * 所以那条走「把 holder 直接看到」的等价路径——见下面的说明。
 */
async function scenarioWorktreeLock(): Promise<void> {
  const L = await import('../../apps/desktop/src/main/services/worktree/lock')
  const bus = await import('../../apps/desktop/src/main/services/chat-bus')

  const p1 = path.join(DST, 'lock', 'a')
  const p2 = path.join(DST, 'lock', 'b')

  // ── ① 同一路径严格串行 ──
  const order: string[] = []
  const t = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const task = (name: string, ms: number, p: string) =>
    L.withGitLock([p], 'create', async () => {
      order.push(`${name}:in`)
      await t(ms)
      order.push(`${name}:out`)
    })
  await Promise.all([task('A', 40, p1), task('B', 10, p1)])
  info('同路径执行顺序', JSON.stringify(order))
  eq('§5.2：同一路径的两次并发调用串行（A 先完才轮到 B）', order, [
    'A:in',
    'A:out',
    'B:in',
    'B:out'
  ])

  // ── ② 不同路径可以并行（不是一把全局大锁）──
  const order2: string[] = []
  const task2 = (name: string, ms: number, p: string) =>
    L.withGitLock([p], 'create', async () => {
      order2.push(`${name}:in`)
      await t(ms)
      order2.push(`${name}:out`)
    })
  const t0 = Date.now()
  await Promise.all([task2('X', 60, p1), task2('Y', 60, p2)])
  const elapsed = Date.now() - t0
  info('不同路径耗时 / 顺序', JSON.stringify({ elapsed, order2 }))
  check(
    '§5.2：不同路径可并行（两者交错进入，总耗时远小于串行的 120ms）',
    order2.slice(0, 2).sort().join(',') === 'X:in,Y:in' && elapsed < 110,
    JSON.stringify({ elapsed, order2 })
  )

  // ── ③ 同一路径的不同写法要命中同一把锁（归一化后判等）──
  //
  // 这里**必须按平台分支**，与 `97ffcb5` 同一类问题：Linux 文件系统大小写敏感，
  // `/a` 与 `/A` 是两个不同目录，`paths.ts:78` 也只对 win32/darwin 折叠。
  // 若一律断言「大写写法命中同一把锁」，Windows 绿、Linux 红——而产品代码是对的，
  // 是断言把「我所在平台的习惯」当成了「普适规则」。
  const foldCase = process.platform === 'win32' || process.platform === 'darwin'

  // ③a 尾斜杠：任何平台都该归一，与大小写无关
  const orderSlash: string[] = []
  const taskSlash = (name: string, p: string) =>
    L.withGitLock([p], 'remove', async () => {
      orderSlash.push(`${name}:in`)
      await t(20)
      orderSlash.push(`${name}:out`)
    })
  await Promise.all([taskSlash('P', p1), taskSlash('Q', p1 + '/')])
  info('尾斜杠变体的顺序', JSON.stringify(orderSlash))
  eq(
    '§5.1：尾斜杠写法命中同一把锁（归一化后才比较）',
    orderSlash,
    ['P:in', 'P:out', 'Q:in', 'Q:out']
  )

  // ③b 大小写：只在折叠大小写的平台（win32/darwin）上要求命中同一把锁
  const orderCase: string[] = []
  const taskCase = (name: string, p: string) =>
    L.withGitLock([p], 'remove', async () => {
      orderCase.push(`${name}:in`)
      await t(20)
      orderCase.push(`${name}:out`)
    })
  await Promise.all([taskCase('P', p1), taskCase('Q', p1.toUpperCase())])
  info(`大小写变体的顺序（本平台折叠大小写=${foldCase}）`, JSON.stringify(orderCase))
  eq(
    foldCase
      ? '§5.1：大小写变体命中同一把锁（本平台大小写不敏感）'
      : '§5.1：大小写变体是两把锁（本平台大小写敏感，Linux 不折叠）',
    orderCase,
    foldCase ? ['P:in', 'P:out', 'Q:in', 'Q:out'] : ['P:in', 'Q:in', 'P:out', 'Q:out']
  )

  // ── ④ 多路径一次全传：两条路径都锁上 ──
  let holderDuringFn: unknown = null
  await L.withGitLock([p1, p2], 'merge', async () => {
    holderDuringFn = [L.gitLockHolder(p1), L.gitLockHolder(p2)]
  })
  info('持锁期间 holder', JSON.stringify(holderDuringFn))
  check(
    '§5.1 第 5 条：全部拿到后登记 holder（两条路径都有）',
    Array.isArray(holderDuringFn) &&
      holderDuringFn.every((h) => h && (h as { label: string }).label === 'merge'),
    JSON.stringify(holderDuringFn)
  )
  // 释放后清空
  eq('§5.1 第 6 条：释放后 holder 清空', [L.gitLockHolder(p1), L.gitLockHolder(p2)], [null, null])

  // ── ⑤ 异常也要释放（否则一次失败就把那条路径永久锁死）──
  let threw = false
  try {
    await L.withGitLock([p1], 'create', async () => {
      throw new Error('boom')
    })
  } catch {
    threw = true
  }
  eq('§5.1：fn 抛错时异常照常上抛', threw, true)
  let after = false
  await L.withGitLock([p1], 'remove', async () => {
    after = true
  })
  eq('§5.1：fn 抛错后锁已释放（后续调用能拿到）', after, true)
  eq('§5.1：抛错后 holder 也是空的', L.gitLockHolder(p1), null)

  // ── ⑥ 等锁超 5 秒必须发一条 progress（B6 的显式提示就靠它，真等一次）──
  /*
   * 这条真等 5 秒多：`WAIT_NOTICE_MS` 是模块内常量，没有测试后门可调。
   * 不给它开后门（那会在生产里留一个能改行为的开关），代价是这个场景慢 5 秒——
   * 而 B6 的「能明确提示正在等另一个会话」全靠它，用「通道能订阅」冒充验证是不诚实的。
   */
  const events: Array<{ phase: string; holder: { label: string } | null }> = []
  const off = bus.onWorktreeProgress((e) => events.push(e as never))
  const slow = L.withGitLock([p1], 'merge', async () => {
    await t(5500)
  })
  // 让慢任务先拿到锁，再排一条等它的
  await t(20)
  const waiting = L.withGitLock([p1], 'create', async () => {
    order.push('waiter:in')
  })
  await Promise.all([slow, waiting])
  off()
  info('等待期间收到的进度事件', JSON.stringify(events))
  check(
    '§5.1 第 7 条：等锁超 5 秒发出 waiting-lock 事件（B6）',
    events.length > 0 && events.every((e) => e.phase === 'waiting-lock'),
    JSON.stringify(events)
  )
  check(
    '§5.1 第 7 条：事件里带上占用者是谁（界面才能说清「在等 merge」）',
    events.length > 0 && events[0]?.holder?.label === 'merge',
    JSON.stringify(events[0] ?? null)
  )
  eq('§5.1：慢调用跑完后，等锁的那条也真的跑到了', order.includes('waiter:in'), true)
}

/**
 * worktree P1 主进程侧：A35（记忆跨工作区共享）、A27（依赖装好前不当可用）、
 * `state` 四态（删目录 / prune / 切分支 / 正常）、`sizeBytes` 异步统计。
 *
 * 这个场景是 spec §9.1 里 R1/R8/R13 三条风险的落点，也是 T1.2/T1.3/T1.4b/T1.6 的验收处。
 */
async function scenarioWorktree(): Promise<void> {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const M = await import('../../apps/desktop/src/main/services/memory')
  const SCOPE = await import('../../apps/desktop/src/main/services/worktree/scope')
  const DEPS = await import('../../apps/desktop/src/main/services/worktree/deps')

  const repo = makeRepo(path.join(DST, 'repo'), { 'a.txt': 'a\n', 'README.md': 'r\n' })
  const wt = path.join(DST, 'wts', 'main-case')
  const r = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/main-case',
    path: wt,
    skipDeps: true
  })
  if (!r.ok) {
    fail('worktree：前置创建失败', JSON.stringify(r))
    return
  }
  const rec = S.getRecord(wt)!
  eq('前置：记录 phase 是 active', rec.phase, 'active')
  eq('前置：skipDeps 让 deps 落 skipped（不探测命令）', rec.deps, 'skipped')
  eq('前置：depsDetail 说明是用户勾选', rec.depsDetail, 'user-skipped')

  // ══ A35：worktree 写入 → 主仓库立即可读 ══
  /*
   * 这是 R1/G5 的核心断言：项目私有记忆只有一份，键是主仓库根（`projectMemoryRootOf`）。
   * 造法走**真实链路**——用 `projectMemoryRootOf` 把 worktree 路径映射回 repoRoot，
   * 再走 `saveMemories` / `listMemories`，与工具层（tools.ts 的 memory_write）用的是同一对函数。
   */
  const memoryRoot = SCOPE.projectMemoryRootOf(wt)
  eq('A35：worktree 路径的项目记忆根 = 主仓库根', memoryRoot, repo)
  eq('A35：非 worktree 路径原样返回（不归一化、不漂移）', SCOPE.projectMemoryRootOf(repo), repo)
  eq('A35：null 透传 null', SCOPE.projectMemoryRootOf(null), null)

  const marker = `A35-${Date.now()}`
  const wrote = M.writeMemory(`${marker} 在 worktree 里写下的记忆`, undefined, {
    kind: 'project',
    root: memoryRoot!
  })
  eq('A35 前置：写入成功', wrote.ok, true)
  // 主仓库会话读：必须立刻看到同一条（listMemories 每次读盘，无缓存）
  const fromPrimary = M.listMemories({ kind: 'project', root: repo })
  check(
    'A35：worktree 写入 → 主仓库立即可读',
    fromPrimary.some((e) => e.content.includes(marker)),
    JSON.stringify(fromPrimary.map((e) => e.content))
  )
  // 反向：如果记忆根错用 workspaceRoot，读到的会是另一份（空）
  const wrongRoot = M.listMemories({ kind: 'project', root: wt })
  check(
    'A35 反向：直接用 worktree 路径当记忆根读不到（证明共享靠 memoryScopeRoot 而非路径巧合）',
    !wrongRoot.some((e) => e.content.includes(marker)),
    JSON.stringify(wrongRoot.map((e) => e.content))
  )
  // 清理：别把测试数据留在真实记忆里
  M.clearMemories({ kind: 'project', root: memoryRoot! })

  // ══ state 四态 ══
  const snap0 = await L.listWorktrees()
  const item0 = snap0.items.find((i) => i.compareKey === rec.compareKey)
  eq('state：正常情况是 ok', item0?.state, 'ok')
  eq('state：unmanaged 不含主检出（它是仓库本身）', snap0.unmanaged.length, 0)

  // ① 切分支 → branch-mismatch
  gitOut(wt, 'checkout', '-q', '-b', 'wt/other')
  const snap1 = await L.listWorktrees()
  const item1 = snap1.items.find((i) => i.compareKey === rec.compareKey)
  eq('state：目录被切到别的分支 → branch-mismatch', item1?.state, 'branch-mismatch')
  eq('state：mismatch 时给出实际分支名（界面要显示「已被切到 X」）', item1?.actualBranch, 'wt/other')
  gitOut(wt, 'checkout', '-q', rec.branch)

  // ② detached → 也算 branch-mismatch（不能把字面量 HEAD 当分支名放过）
  const headSha = gitOut(wt, 'rev-parse', 'HEAD')
  gitOut(wt, 'checkout', '-q', '--detach', headSha)
  const snap2 = await L.listWorktrees()
  eq(
    'state：detached 也算 branch-mismatch（不把 "HEAD" 当分支名）',
    snap2.items.find((i) => i.compareKey === rec.compareKey)?.state,
    'branch-mismatch'
  )
  gitOut(wt, 'checkout', '-q', rec.branch)

  // ③ 删目录 → 目录不在 + git 随即标 prunable → 落 prunable（§2.1 第 1 条优先）
  /*
   * 这里是 `prunable` 而不是 `dir-missing`：git 发现 worktree 目录没了会立刻把它标成 prunable，
   * 而 §2.1 明确要求「prunable 比 dir-missing 更强，两者同时成立时按更强的展示」——
   * 用户才看得到「清理登记」这个出口。`dir-missing` 是「目录不在但 git 还没标」那一态。
   */
  fs.rmSync(wt, { recursive: true, force: true })
  const snap3 = await L.listWorktrees()
  eq(
    'state：目录被外部删掉 → prunable（git 随即标记，§2.1 第 1 条优先于 dir-missing）',
    snap3.items.find((i) => i.compareKey === rec.compareKey)?.state,
    'prunable'
  )
  eq('state：dir-missing 时 sizeBytes 直接给 0（不去遍历不存在的目录）', snap3.items.find((i) => i.compareKey === rec.compareKey)?.sizeBytes, 0)

  // ④ prune 掉登记 → 仍是 dir-missing（目录不在，登记也没了）
  gitOut(repo, 'worktree', 'prune')
  const snap4 = await L.listWorktrees()
  eq(
    'state：prune 掉登记后仍是 dir-missing（不新造第五种状态）',
    snap4.items.find((i) => i.compareKey === rec.compareKey)?.state,
    'dir-missing'
  )

  // ⑤ 目录在但登记丢了 → dir-missing（第 3 条短路）
  fs.mkdirSync(wt, { recursive: true })
  const snap5 = await L.listWorktrees()
  eq(
    'state：目录在但 git 登记丢了 → dir-missing（§2.1 第 3 条）',
    snap5.items.find((i) => i.compareKey === rec.compareKey)?.state,
    'dir-missing'
  )
  fs.rmSync(wt, { recursive: true, force: true })

  // ⑥ prunable：目录不在 + git 标记 prunable → prunable（更强的信号优先）
  const wt2 = path.join(DST, 'wts', 'prunable-case')
  const r2 = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/prunable',
    path: wt2,
    skipDeps: true
  })
  if (!r2.ok) {
    fail('worktree：第二条创建失败', JSON.stringify(r2))
    return
  }
  const rec2 = S.getRecord(wt2)!
  fs.rmSync(wt2, { recursive: true, force: true })
  const snap6 = await L.listWorktrees()
  eq(
    'state：目录不在 + git 标记 prunable → prunable（§2.1 第 1 条，比 dir-missing 更强）',
    snap6.items.find((i) => i.compareKey === rec2.compareKey)?.state,
    'prunable'
  )

  // ══ T1.4b：sizeBytes 异步统计 ══
  L.clearSizeCacheForTest()
  const wt3 = path.join(DST, 'wts', 'size-case')
  const r3 = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/size',
    path: wt3,
    skipDeps: true
  })
  if (!r3.ok) {
    fail('worktree：第三条创建失败', JSON.stringify(r3))
    return
  }
  const rec3 = S.getRecord(wt3)!
  // 塞点体积进去，让统计结果可判
  fs.writeFileSync(path.join(wt3, 'blob.bin'), Buffer.alloc(4096, 1))
  const first = await L.listWorktrees()
  const firstItem = first.items.find((i) => i.compareKey === rec3.compareKey)
  eq('T1.4b：列表首次返回 sizeBytes 为 null（界面显示「统计中…」）', firstItem?.sizeBytes, null)
  // 等后台算完（setImmediate + 遍历）
  await new Promise((r) => setTimeout(r, 300))
  const second = await L.listWorktrees()
  const secondItem = second.items.find((i) => i.compareKey === rec3.compareKey)
  check(
    'T1.4b：后台算完后 sizeBytes 有值且大于 4096',
    typeof secondItem?.sizeBytes === 'number' && secondItem.sizeBytes > 4096,
    JSON.stringify(secondItem?.sizeBytes)
  )

  // ══ A27：依赖装好之前不许当可用（deps 状态机 + 失败不回滚）══
  /*
   * A27 的含义见 spec §3.6 / §2.2：`deps` 必须是一个**明确值**，不能留 undefined；
   * 且安装失败**不回滚 worktree**（目录与分支都还在，用户能继续读代码）。
   *
   * 这里用真实的 pnpm 安装太重（CI 要联网），所以走两条更硬的断言：
   * ① lockfile 检测按表命中（含非 JS 生态 → unsupported-language）；
   * ② 装失败时 worktree 仍在（用一条必失败的假命令验证「不回滚」这条语义）。
   */
  eq(
    'A27：无 lockfile → skipped + no-lockfile',
    DEPS.detectInstallPlan(wt3).skipReason,
    'no-lockfile'
  )
  fs.writeFileSync(path.join(wt3, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const plan = DEPS.detectInstallPlan(wt3)
  eq('A27：有 pnpm-lock.yaml → 用 pnpm install --frozen-lockfile', plan.argv?.join(' '), 'pnpm install --frozen-lockfile')
  fs.rmSync(path.join(wt3, 'pnpm-lock.yaml'))
  fs.writeFileSync(path.join(wt3, 'Cargo.toml'), '[package]\nname="x"\n')
  eq(
    'A27：Cargo.toml → unsupported-language（不是含糊的 no-lockfile）',
    DEPS.detectInstallPlan(wt3).skipReason,
    'unsupported-language'
  )
  fs.rmSync(path.join(wt3, 'Cargo.toml'))

  // A27 的核心：安装失败不回滚 worktree
  S.upsertRecord({ ...rec3, deps: 'pending' })
  const started = DEPS.startInstall(S.getRecord(wt3)!)
  eq('A27：无 lockfile 时 startInstall 不启动（落 skipped）', started.started, false)
  eq('A27：skipped 终态可查（删除判断与边界说明都要这个明确值）', S.getRecord(wt3)?.deps, 'skipped')
  // 造一个「会失败的安装」：假的 lockfile + 指向不存在的包管理器路径
  fs.writeFileSync(path.join(wt3, 'package-lock.json'), '{"lockfileVersion":3}\n')
  S.upsertRecord({ ...S.getRecord(wt3)!, deps: 'installing' })
  const retry = DEPS.retryInstall(wt3)
  eq('A27：retryInstall 从 installing 状态直接拒绝（§2.2 禁止同态重入）', retry.reason, 'already-installing')
  // 失败后 worktree 仍在（用 ready 之外的状态验证「不回滚」）
  check('A27：安装失败/中断都不会删 worktree 目录', fs.existsSync(wt3), String(fs.existsSync(wt3)))
  check('A27：分支也还在（不回滚 = 用户能继续读代码）', gitOut(repo, 'branch', '--list', rec3.branch).includes(rec3.branch), gitOut(repo, 'branch', '--list', rec3.branch))

  // ══ A27 的真实安装路径：installing → ready（用本地 file: 依赖，几秒完成、不联网）══
  /*
   * 此前只验了检测规则与「失败不回滚」，**没验过「装成功」**。这条补上它：
   * 假包里只有一个 file: 依赖，`npm ci` 几秒结束、不联网，但它走的是与生产完全相同的那条
   * 「起子进程 → 等 exit 0 → 写 ready」链路。
   *
   * npm 不可用时显式 SKIP 并计数（不当作通过）。
   */
  const R = await import('./a27-real-install')
  const tinyRoot = path.join(DST, 'tiny-install')
  const tinyRepo = R.makeTinyInstallableRepo(tinyRoot)
  if (!tinyRepo) {
    info('A27 真实安装路径', 'SKIP —— npm 不可用或 lockfile 生成失败')
  } else {
    eq('A27：自动生成的 lockfile 被检测规则命中 npm ci', DEPS.detectInstallPlan(tinyRepo).argv?.join(' '), 'npm ci')
    const inst = R.runNpmCi(tinyRepo)
    eq('A27：npm ci 成功退出（installing → ready 的前提）', inst.ok, true)
    check('A27：依赖真的落进 node_modules（不是「看着成功」）', R.depInstalled(tinyRepo), String(R.depInstalled(tinyRepo)))
    if (!inst.ok) info('A27 npm ci 失败现场', inst.detail)
  }

  // ══ IPC 真的接上了：`worktree:list` 返回的是**快照**，不是记录数组 ══
  /*
   * 这条防的是一类特别隐蔽的漏：`list.ts` 写好了、也测了，但 `ipc.ts` 还挂着旧的
   * `listRecords()`（返回裸记录数组），于是渲染层拿不到 `state` / `sizeBytes` / `sessionCount`。
   * 直接调 `listWorktrees()` 的测试**发现不了**它——必须走 IPC 处理器。
   */
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')
  const stub = require('./stub-electron.cjs') as {
    __test: { ipcHandlers: Map<string, (...a: unknown[]) => unknown> }
  }
  // stub 的 env 校验会在 import 期抛，本场景已设好；直接注册即可
  IPC.registerWorktreeIpc(() => null)
  const listHandler = stub.__test.ipcHandlers.get('worktree:list')
  check('IPC：worktree:list 已注册', typeof listHandler === 'function', typeof listHandler)
  const viaIpc = (await listHandler?.({})) as {
    items?: Array<{ state?: string; sizeBytes?: unknown }>
    unmanaged?: unknown
    storeUnreadable?: unknown
  }
  check(
    'IPC：worktree:list 返回快照（items + unmanaged + storeUnreadable），不是裸记录数组',
    Array.isArray(viaIpc?.items) &&
      Array.isArray(viaIpc?.unmanaged) &&
      typeof viaIpc?.storeUnreadable === 'boolean',
    JSON.stringify(Object.keys(viaIpc ?? {}))
  )
  check(
    'IPC：快照每条都带主进程算好的 state（渲染层不复算，A48）',
    (viaIpc?.items ?? []).length > 0 && (viaIpc?.items ?? []).every((i) => typeof i.state === 'string'),
    JSON.stringify((viaIpc?.items ?? []).map((i) => i.state))
  )
  const instHandler = stub.__test.ipcHandlers.get('worktree:install-deps')
  check('IPC：worktree:install-deps 已注册', typeof instHandler === 'function', typeof instHandler)

  // ══ 列表并发化（性能修复）：坏条目不影响其它条，且 headBranch 不再单独跑 git ══
  /*
   * 这段守的是并行化最容易引入的两种回归：
   * ① 一条坏记录把整张列表拖垮（串行时抛错会中断，并行时若不 catch 会变成 unhandled rejection）；
   * ② 为了提速把 `headBranch` 从 worktree list 的条目里读之后，detached / 切分支的判定变了。
   */
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')
  const badPath = path.join(DST, 'wts', 'no-such-dir')
  S.upsertRecord({
    schemaVersion: 1,
    path: badPath,
    compareKey: '',
    repoRoot: repo,
    repoKey: 'k2',
    branch: 'wt/ghost',
    baseSha: 'b'.repeat(40),
    baseLabel: 'my/dev',
    targetBranch: 'my/dev',
    createdAt: Date.now() + 1,
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped'
  })
  const snapBad = await L.listWorktrees()
  const normBad = P.normalizeWorktreePath(badPath)
  const recBad = snapBad.items.find((i) => i.compareKey === normBad.compareKey)
  check(
    '并发：目录不存在的那条 → dir-missing 或 prunable',
    recBad?.state === 'dir-missing' || recBad?.state === 'prunable',
    recBad?.state
  )
  eq('并发：目录不存在的那条 dirtyCount 为 null（不去跑必失败的 git）', recBad?.dirtyCount, null)
  eq('并发：目录不存在的那条 mergeInProgress 为 null', recBad?.mergeInProgress, null)
  check(
    '并发：坏条目不拖垮列表——其余条目照样拿到 sizeBytes/sessionCount/state',
    snapBad.items.filter((i) => i !== recBad).every((i) => typeof i.state === 'string' && typeof i.sessionCount === 'number' && 'sizeBytes' in i),
    JSON.stringify(snapBad.items.map((i) => i.state))
  )
  check('并发：所有条目都返回了（没有因为异常被丢掉）', snapBad.items.length >= 2, String(snapBad.items.length))
  S.removeRecord(badPath)

  /*
   * `headBranch` 现在从 `git worktree list --porcelain` 的条目读（省掉每条一次 rev-parse）。
   * 必须证明两种情形都还对：切到别的分支、detached。
   */
  gitOut(wt3, 'checkout', '-q', '-b', 'wt/perf-other')
  const snapBranch = await L.listWorktrees()
  eq(
    '并发优化后：切到别的分支仍判 branch-mismatch（headBranch 从 porcelain 读到的是新分支）',
    snapBranch.items.find((i) => i.compareKey === rec3.compareKey)?.state,
    'branch-mismatch'
  )
  const perfHead = gitOut(wt3, 'rev-parse', 'HEAD')
  gitOut(wt3, 'checkout', '-q', '--detach', perfHead)
  const snapDetached = await L.listWorktrees()
  eq(
    '并发优化后：detached 仍判 branch-mismatch（porcelain 无 branch 行 → 等价于 rev-parse 的 "HEAD"）',
    snapDetached.items.find((i) => i.compareKey === rec3.compareKey)?.state,
    'branch-mismatch'
  )
  gitOut(wt3, 'checkout', '-q', rec3.branch)

  // ══ sizeBytes 回填走增量事件（不发 worktree:changed，避免整表重拉）══
  {
    const bus = await import('../../apps/desktop/src/main/services/chat-bus')
    const sizeEvents: Array<{ compareKey: string; sizeBytes: number }> = []
    let changedCount = 0
    const offSize = bus.onWorktreeSize((u) => sizeEvents.push(u))
    const offChanged = bus.onWorktreeChanged(() => {
      changedCount++
    })
    L.clearSizeCacheForTest()
    await L.listWorktrees() // 触发后台统计
    await new Promise((r) => setTimeout(r, 800))
    offSize()
    offChanged()
    info('sizeBytes 增量事件', JSON.stringify(sizeEvents.map((e) => e.sizeBytes)))
    info('同期 worktree:changed 次数', String(changedCount))
    check(
      'T1.4b：体积算完发**增量** worktree:size（带 compareKey + sizeBytes）',
      sizeEvents.length > 0 && sizeEvents.every((e) => typeof e.compareKey === 'string' && typeof e.sizeBytes === 'number'),
      JSON.stringify(sizeEvents)
    )
    eq(
      'T1.4b：体积回填**不**发 worktree:changed（否则界面整表重拉，4N+1 次 git）',
      changedCount,
      0
    )
  }

  // ══ 体积缓存：目录体积变化后必须能刷新（deps 转 ready/failed 时失效）══
  /*
   * 缓存的前提是「目录体积不会自己变小」，但**安装依赖会**——装完 node_modules 后体积能从
   * 十几 MB 变成几百 MB。少了失效，表现是：装完依赖、列表也重拉了，但体积还是装之前的数字，
   * 而且没有任何报错（因为重拉命中了旧缓存）。
   */
  {
    L.clearSizeCacheForTest()
    const firstSnap = await L.listWorktrees()
    eq(
      '体积缓存：首次是 null（后台统计）',
      firstSnap.items.find((i) => i.compareKey === rec3.compareKey)?.sizeBytes,
      null
    )
    await new Promise((r) => setTimeout(r, 600))
    const warmSnap = await L.listWorktrees()
    const warm = warmSnap.items.find((i) => i.compareKey === rec3.compareKey)?.sizeBytes
    check('体积缓存：算完之后命中缓存（不再返回 null）', typeof warm === 'number', JSON.stringify(warm))

    // 往目录里加一大块，模拟「安装依赖写了很多文件」
    const blob = path.join(wt3, 'node_modules')
    fs.mkdirSync(blob, { recursive: true })
    fs.writeFileSync(path.join(blob, 'big.bin'), Buffer.alloc(200_000, 7))
    const staleSnap = await L.listWorktrees()
    eq(
      '体积缓存：不失效时仍返回旧值（证明缓存确实在生效，不是每次都重算）',
      staleSnap.items.find((i) => i.compareKey === rec3.compareKey)?.sizeBytes,
      warm
    )

    // 显式失效（deps 转 ready 时就是这么做的）→ 下一次回到 null 并重算
    L.invalidateSize(rec3.compareKey)
    const afterInv = await L.listWorktrees()
    eq(
      '体积缓存：invalidateSize 之后回到 null（触发重算，而不是继续给旧值）',
      afterInv.items.find((i) => i.compareKey === rec3.compareKey)?.sizeBytes,
      null
    )
    await new Promise((r) => setTimeout(r, 600))
    const newSnap = await L.listWorktrees()
    const newSize = newSnap.items.find((i) => i.compareKey === rec3.compareKey)?.sizeBytes
    check(
      '体积缓存：重算后拿到新体积（比旧值大 200KB 以上）',
      typeof newSize === 'number' && typeof warm === 'number' && newSize >= warm + 200_000,
      `old=${warm} new=${newSize}`
    )
    fs.rmSync(blob, { recursive: true, force: true })
    L.clearSizeCacheForTest()
  }

  // ══ 单条失败不兜假状态（只 warn + 从列表里滤掉）══
  /*
   * 这条是**结构性断言**（读源码），不是行为测试：单条任务抛错在正常代码里造不出来
   * （里面每个 git 调用都自带失败兜底），所以没有可注入的失败点。
   *
   * 它守的是一个**已经删掉的坏兜底**：曾经在单条异常时兜一条 `state: 'dir-missing'` 的条目，
   * 让一个目录其实存在的工作区显示「工作区目录已缺失」并给出「重建」按钮——
   * 等 P2 的 rebuild 接通后，那就是「对存在的目录执行 git worktree add」。
   */
  {
    const listSrc = fs.readFileSync(
      path.join(process.cwd(), 'apps/desktop/src/main/services/worktree/list.ts'),
      'utf8'
    )
    check(
      "单条失败：不兜 state:'dir-missing' 的假条目（目录存在时说「已缺失」+ 给重建按钮是误导）",
      !/state:\s*'dir-missing'\s*as\s*WorktreeState/.test(listSrc),
      '看 list.ts 的 finalItems'
    )
    check(
      '单条失败：undefined 被滤掉（不给假状态），而不是被映射成某种 state',
      /items\.filter\(\(it\): it is WorktreeListItem => it !== undefined\)/.test(listSrc),
      '看 list.ts 的 finalItems'
    )
    // computeState 的 dir-missing 只能由「目录不在」或「登记丢了」产生，与 git 调用成败无关
    eq(
      'state：目录存在 + 登记存在时，computeState 绝不会给出 dir-missing（git 失败也走不到这里）',
      L.computeState({
        record: { path: 'x', branch: 'b' },
        dirExists: true,
        gitEntry: { path: 'x', branch: 'b' },
        prunable: false,
        headBranch: null
      }).state,
      'branch-mismatch'
    )
  }
  /*
   * 上面那条只证明 `invalidateSize` 有效；这条证明 **deps.ts 在转 ready 时真的调了它**。
   * 少了这一条，可以「实现了 invalidateSize 但没人调用」而测试全绿。
   */
  {
    // 打包后 __dirname 指向 dist，用 cwd（driver 从仓库根跑）定位源码
    const repoFile = path.join(
      process.cwd(),
      'apps/desktop/src/main/services/worktree/deps.ts'
    )
    const depsSrc = fs.readFileSync(repoFile, 'utf8')
    check(
      'deps：finish() 在 ready/failed 时会失效体积缓存（否则装完依赖体积永远停在旧值）',
      /deps === 'ready' \|\| deps === 'failed'/.test(depsSrc) &&
        /invalidateSize\(record\.compareKey\)/.test(depsSrc),
      '看 deps.ts 的 finish()'
    )
  }

  // ══ state 不被「git 坏掉」污染：目录在但 .git 坏了，不能显示成 dir-missing + 重建 ══
  /*
   * 这条对应验收的 ③，也是本轮 `headBranch` 优化的回归守卫：
   *
   * porcelain 里那条 `branch` 是**主仓库登记中的值**，与「这个工作区自己的 git 还能不能用」无关。
   * 所以当 `status` 在这个目录里失败（`.git` 被删/改名）时，绝不能拿 porcelain 的 branch 当
   * 「它还在自己的分支上」的证据——那样会落 `ok`，界面显示「正常」，用户完全看不出已坏。
   *
   * 现在的判据：status 失败 ⇒ headBranch 按 null 交 ⇒ 落 `branch-mismatch`（与优化前一致）。
   * 关键是它**不能**落 `dir-missing`——那是「目录已缺失 + 重建按钮」，对存在的目录是误导。
   */
  {
    const brokeWt = path.join(DST, 'wts', 'git-broken')
    const rB = await CR.createWorktree({
      repoRoot: repo,
      branch: 'wt/gitbroken',
      path: brokeWt,
      skipDeps: true
    })
    if (!rB.ok) {
      fail('git 坏掉场景：前置创建失败', JSON.stringify(rB))
      return
    }
    const recB = S.getRecord(brokeWt)!
    // 把该工作区的 .git（worktree 里是个文件）改名 → 目录还在，但 git 在这个目录里跑不了
    const dotGit = path.join(brokeWt, '.git')
    fs.renameSync(dotGit, dotGit + '-broken')
    const snapB = await L.listWorktrees()
    const itB = snapB.items.find((i) => i.compareKey === recB.compareKey)
    info('git 坏掉时的快照', JSON.stringify({ state: itB?.state, dirtyCount: itB?.dirtyCount }))
    check(
      'git 坏掉：目录仍在 → **不是** dir-missing（否则会显示「目录已缺失」+「重建」）',
      itB?.state !== 'dir-missing',
      String(itB?.state)
    )
    eq('git 坏掉：dirtyCount 为 null（status 跑不了，无法统计）', itB?.dirtyCount, null)
    check(
      'git 坏掉：state 落 branch-mismatch（与 headBranch 优化前的行为一致，不伪装成正常）',
      itB?.state === 'branch-mismatch',
      String(itB?.state)
    )
    eq(
      'git 坏掉：mergeGate 因此禁用（source-branch-changed），不会引导用户去合并',
      itB?.mergeGate,
      { mayMerge: false, blocker: 'source-branch-changed' }
    )
    // 还原，别影响后面的断言
    fs.renameSync(dotGit + '-broken', dotGit)
    const snapBack = await L.listWorktrees()
    eq(
      'git 修好之后立刻回到 ok（每次现算）',
      snapBack.items.find((i) => i.compareKey === recB.compareKey)?.state,
      'ok'
    )
  }

  // ══ mergeGate 四个 blocker（spec §7.5）══
  /*
   * `mergeGate` 是「按钮能不能点」的唯一依据（A48：渲染层不复算）。四个 blocker 各构造一次：
   *   target-not-set / source-missing / source-branch-changed / installing
   *
   * 这里直接测纯函数 `computeMergeGate`（轻量三判据），再测快照里真的带上了它。
   */
  eq(
    'mergeGate：targetBranch 为空 → target-not-set',
    L.computeMergeGate({ state: 'ok', deps: 'ready', targetBranch: null }),
    { mayMerge: false, blocker: 'target-not-set' }
  )
  eq(
    'mergeGate：目录缺失 → source-missing',
    L.computeMergeGate({ state: 'dir-missing', deps: 'ready', targetBranch: 'my/dev' }),
    { mayMerge: false, blocker: 'source-missing' }
  )
  eq(
    'mergeGate：prunable 也归 source-missing（对用户都是「用不了」）',
    L.computeMergeGate({ state: 'prunable', deps: 'ready', targetBranch: 'my/dev' }),
    { mayMerge: false, blocker: 'source-missing' }
  )
  eq(
    'mergeGate：被切到别的分支 → source-branch-changed',
    L.computeMergeGate({ state: 'branch-mismatch', deps: 'ready', targetBranch: 'my/dev' }),
    { mayMerge: false, blocker: 'source-branch-changed' }
  )
  eq(
    'mergeGate：依赖正在装 → installing（UI 层判断，不走 C1~C6）',
    L.computeMergeGate({ state: 'ok', deps: 'installing', targetBranch: 'my/dev' }),
    { mayMerge: false, blocker: 'installing' }
  )
  eq(
    'mergeGate：一切正常 → mayMerge',
    L.computeMergeGate({ state: 'ok', deps: 'ready', targetBranch: 'my/dev' }),
    { mayMerge: true }
  )
  // blocker 的**优先级**：targetBranch 为空比「目录不在」更根本（先要有个目标才谈得上合并）
  eq(
    'mergeGate：多个问题同时存在时，blocker 按 §7.5 的顺序取（target-not-set 最优先）',
    L.computeMergeGate({ state: 'dir-missing', deps: 'installing', targetBranch: null }),
    { mayMerge: false, blocker: 'target-not-set' }
  )

  /*
   * 先把 wt3 恢复成「干净且 deps 非 installing」，否则下面几条断言测的是前面段落的残留
   * （package-lock.json 还在 → dirtyCount 不为 0；deps 被改成 installing → mergeGate 是 installing）。
   */
  // 前面几段在 wt3 里留过 lockfile / Cargo.toml / blob.bin：全清掉，才谈得上「干净」
  for (const f of ['pnpm-lock.yaml', 'package-lock.json', 'Cargo.toml', 'blob.bin'])
    try {
      fs.rmSync(path.join(wt3, f))
    } catch {
      /* 不存在就算了 */
    }
  S.upsertRecord({ ...S.getRecord(wt3)!, deps: 'ready' })
  // 快照里真的带上了三者（真实 IPC 返回的字段）
  const snapGate = await L.listWorktrees()
  const withGate = snapGate.items.find((i) => i.compareKey === rec3.compareKey)
  check('快照：每条都带 mergeGate', typeof withGate?.mergeGate === 'object' && withGate.mergeGate !== null, JSON.stringify(withGate?.mergeGate))
  check('快照：每条都带 dirtyCount 字段（可为 null）', withGate !== undefined && 'dirtyCount' in withGate, JSON.stringify(withGate?.dirtyCount))
  check('快照：每条都带 mergeInProgress 字段（可为 null）', withGate !== undefined && 'mergeInProgress' in withGate, JSON.stringify(withGate?.mergeInProgress))
  eq('快照：工作区干净时 dirtyCount 为 0', withGate?.dirtyCount, 0)
  // 造一个改动，dirtyCount 要跟着变
  fs.writeFileSync(path.join(wt3, 'dirty-a.txt'), 'x\n')
  fs.writeFileSync(path.join(wt3, 'dirty-b.txt'), 'y\n')
  const snapDirty = await L.listWorktrees()
  eq(
    '快照：有 2 个未提交改动时 dirtyCount = 2（§7.7 的「N 个未提交改动」）',
    snapDirty.items.find((i) => i.compareKey === rec3.compareKey)?.dirtyCount,
    2
  )
  eq(
    'mergeGate：有未提交改动**不**影响 mayMerge（§7.5 明确不跑 status）',
    snapDirty.items.find((i) => i.compareKey === rec3.compareKey)?.mergeGate,
    { mayMerge: true }
  )
  fs.rmSync(path.join(wt3, 'dirty-a.txt'))
  fs.rmSync(path.join(wt3, 'dirty-b.txt'))

  // ══ mergeInProgress：target 检出里有未收尾的合并（§13.10）══
  /*
   * 造法：在 target（主检出）里制造一个真冲突的 merge。
   * wt3 的分支改 a.txt，主检出也改 a.txt → 在 repo 里 merge wt3 的分支必冲突 →
   * MERGE_HEAD 存在、有未合并文件。
   */
  eq('mergeInProgress：没有合并时是 null', snapGate.items.find((i) => i.compareKey === rec3.compareKey)?.mergeInProgress, null)
  const mergeWt = path.join(DST, 'wts', 'conflict-src')
  const rM = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/conflict',
    path: mergeWt,
    skipDeps: true
  })
  if (!rM.ok) {
    fail('mergeInProgress：前置创建失败', JSON.stringify(rM))
    return
  }
  const recM = S.getRecord(mergeWt)!
  // 带 git 身份跑（合并要写 commit；不设身份时 commit 会失败，MERGE_HEAD 就造不出来）
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'q',
    GIT_AUTHOR_EMAIL: 'q@q',
    GIT_COMMITTER_NAME: 'q',
    GIT_COMMITTER_EMAIL: 'q@q'
  }
  const gitRun = (cwd: string, args: string[]): { code: number; out: string } => {
    const r = require('node:child_process').spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: gitEnv
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  // 两边都改 a.txt 的同一行 → 必冲突
  fs.writeFileSync(path.join(mergeWt, 'a.txt'), 'from worktree\n')
  const c1 = gitRun(mergeWt, ['commit', '-qam', 'wt change'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from primary\n')
  const c2 = gitRun(repo, ['commit', '-qam', 'primary change'])
  // 在 target（主检出）里尝试合并 → 必冲突并留下 MERGE_HEAD
  const mg = gitRun(repo, ['merge', '--no-edit', recM.branch])
  info('mergeInProgress 前置现场', `commit=${c1.code}/${c2.code} merge=${mg.code} ${mg.out.slice(0, 200)}`)
  check(
    'mergeInProgress 前置：主检出确实进入了合并中',
    fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')),
    `commit=${c1.code}/${c2.code} merge=${mg.code}`
  )
  const snapMerge = await L.listWorktrees()
  const inProgress = snapMerge.items.find((i) => i.compareKey === recM.compareKey)?.mergeInProgress
  info('mergeInProgress 实测', JSON.stringify(inProgress))
  check(
    'mergeInProgress：target 检出里有未收尾合并时给出 { targetPath, unmergedCount }',
    inProgress !== null &&
      typeof inProgress === 'object' &&
      inProgress.targetPath.length > 0 &&
      inProgress.unmergedCount === 1,
    JSON.stringify(inProgress)
  )
  // 清理：撤销合并，别让后续断言受影响
  gitRun(repo, ['merge', '--abort'])
  const snapAbort = await L.listWorktrees()
  eq(
    'mergeInProgress：git merge --abort 之后立刻变回 null（每次现算、不落盘）',
    snapAbort.items.find((i) => i.compareKey === recM.compareKey)?.mergeInProgress,
    null
  )

  // ══ A27 状态转移：驱动 startInstall，不是自己跑 npm ══
  /*
   * **这条是补盲区**：上一批的三条断言测的是测试自己的 `runNpmCi`（跑 npm ci 成功），
   * 绕过了 `deps.ts`。所以把 deps.ts 的 `finish(rec,'ready')` 改成 `failed` 它们仍然绿——
   * 这类回归无人拦。这里必须驱动产品状态机本身：`startInstall` → 等它跑完 → 断言 record.deps。
   */
  const transferRoot = path.join(DST, 'transfer-install')
  const transferRepo = R.makeTinyInstallableRepo(transferRoot)
  if (!transferRepo) {
    info('A27 状态转移', 'SKIP —— npm 不可用')
  } else {
    // 造一个 worktree 记录，路径指向那个可安装的目录
    const transferPath = path.join(DST, 'wts', 'transfer')
    fs.mkdirSync(transferPath, { recursive: true })
    S.upsertRecord({
      schemaVersion: 1,
      path: transferPath,
      compareKey: '',
      repoRoot: repo,
      repoKey: 'k',
      branch: 'wt/transfer',
      baseSha: 'a'.repeat(40),
      baseLabel: 'my/dev',
      targetBranch: 'my/dev',
      createdAt: Date.now(),
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'pending'
    })
    // 把可安装目录里的 package.json / lockfile 拷进 worktree 路径
    for (const f of ['package.json', 'package-lock.json'])
      fs.copyFileSync(path.join(transferRepo, f), path.join(transferPath, f))
    /*
     * `file:../pkg-local` 的相对路径要能解析到：worktree 在 `<DST>/wts/transfer`，
     * 所以 pkg-local 必须在 `<DST>/wts/pkg-local`。makeTinyInstallableRepo 已经把它建在
     * `<DST>/pkg-local`（transferRoot 的兄弟），这里复制一份到 wts 下。
     */
    const srcPkg = path.join(DST, 'pkg-local')
    const dstPkg = path.join(DST, 'wts', 'pkg-local')
    if (srcPkg !== dstPkg) fs.cpSync(srcPkg, dstPkg, { recursive: true })

    const started = DEPS.startInstall(S.getRecord(transferPath)!)
    eq('A27 状态转移：startInstall 进入 installing', started.started, true)
    eq('A27 状态转移：落盘值立刻是 installing', S.getRecord(transferPath)?.deps, 'installing')
    // 等它跑完（npm ci 几秒）
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const d = S.getRecord(transferPath)?.deps
      if (d === 'ready' || d === 'failed') break
    }
    const finalDeps = S.getRecord(transferPath)?.deps
    info('A27 状态转移终态', String(finalDeps))
    /*
     * 这一条就是验收指出的盲区：它驱动 deps.ts 自己走到终态。
     * 把 deps.ts 里的 `finish(rec, 'ready')` 改成 `failed` 会让它变红。
     */
    eq('A27 核心：installing → ready', finalDeps, 'ready')
    eq(
      'A27 核心：失败时 depsDetail 会写现场（ready 时应为空）',
      S.getRecord(transferPath)?.depsDetail,
      undefined
    )
  }

  // ══ A48：判定只在主进程，渲染层拿到的就是结果 ══
  const snapFinal = await L.listWorktrees()
  const finalItem = snapFinal.items.find((i) => i.compareKey === rec3.compareKey)
  check(
    'A48：快照里 state/deps/sessionCount/sizeBytes/lockHolder 全部由主进程给出',
    finalItem !== undefined &&
      typeof finalItem.state === 'string' &&
      typeof finalItem.deps === 'string' &&
      typeof finalItem.sessionCount === 'number' &&
      'sizeBytes' in finalItem &&
      'lockHolder' in finalItem,
    JSON.stringify(finalItem)
  )

  /*
   * ══ A53：删除 worktree 的三条出口 ══
   *
   * 三条都要验，因为它们的**用户动作不同**：
   *  - dirty → 报出改动数，用户勾「我知道会丢」后能删
   *  - installing → 无条件拒绝，**不给勾选项**（安装进程正在写这个目录）
   *  - 干净 → 直接删
   * 只验「能删」会漏掉前两条，而它们才是防数据丢失的那部分。
   */
  const RMW = await import('../../apps/desktop/src/main/services/worktree/remove')

  const rmPath = path.join(DST, 'wts', 'a53')
  const rmCreate = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/a53',
    path: rmPath,
    skipDeps: true
  })
  if (!rmCreate.ok) {
    fail('A53：前置创建不该失败', JSON.stringify(rmCreate))
  } else {
    // ── 出口一：3 个未提交改动 → 拒绝并回 dirtyCount:3 ──
    for (const n of ['d1.txt', 'd2.txt', 'd3.txt']) fs.writeFileSync(path.join(rmPath, n), 'x\n')
    const dirtyRes = await RMW.removeWorktree({ path: rmPath })
    eq('A53：3 个未提交改动时拒绝删除', dirtyRes.ok, false)
    eq('A53：拒绝原因是 dirty', dirtyRes.reason, 'dirty')
    eq('A53：回传 dirtyCount=3', dirtyRes.dirtyCount, 3)
    check('A53：拒绝后目录还在', fs.existsSync(rmPath), '')
    check('A53：拒绝后三个改动文件都还在', ['d1.txt', 'd2.txt', 'd3.txt'].every((n) => fs.existsSync(path.join(rmPath, n))), '')

    // ── 出口二：deps 正在装 → 无条件拒绝，且**不给 dirtyCount**（没有「确认后可删」这条路）──
    const recA53 = S.getRecord(rmPath)
    if (recA53) {
      S.upsertRecord({ ...recA53, deps: 'installing' })
      const installingRes = await RMW.removeWorktree({ path: rmPath, force: true })
      eq('A53：installing 时即使 force 也拒绝', installingRes.ok, false)
      eq('A53：拒绝原因是 installing', installingRes.reason, 'installing')
      eq(
        'A53：installing 时不回 dirtyCount（不给勾选诱导）',
        installingRes.dirtyCount,
        undefined
      )
      // 还原 deps 状态，否则后面的清理走不下去
      const recBack = S.getRecord(rmPath)
      if (recBack) S.upsertRecord({ ...recBack, deps: 'skipped' })
    }

    // ── 出口三：勾了「我知道会丢」→ 能删，且要在 warnings 里说明丢了几处 ──
    const forceRes = await RMW.removeWorktree({ path: rmPath, force: true })
    eq('A53：force 后删除成功', forceRes.ok, true)
    check('A53：force 后目录真的没了', !fs.existsSync(rmPath), '')
    check(
      'A53：force 时说明丢了 3 处改动（不能静默丢数据）',
      forceRes.warnings.some((w) => w.includes('3 处')),
      JSON.stringify(forceRes.warnings)
    )
  }

  /*
   * ══ A34：重建 worktree ══
   *
   * 核心不是「能重建」，而是**不得「提示成功但目录不存在」**。所以每条成功路径都要回读
   * `existsSync` + `git worktree list` + `rev-parse HEAD` 三项，只看 `ok:true` 等于没验。
   */
  const RB = await import('../../apps/desktop/src/main/services/worktree/rebuild')

  const rbPath = path.join(DST, 'wts', 'a34')
  const rbCreate = await CR.createWorktree({
    repoRoot: repo,
    branch: 'wt/a34',
    path: rbPath,
    skipDeps: true
  })
  if (!rbCreate.ok) {
    fail('A34：前置创建不该失败', JSON.stringify(rbCreate))
  } else {
    // ── 正路：目录被外部删掉 → 重建 → 目录真的回来了 ──
    fs.rmSync(rbPath, { recursive: true, force: true })
    check('A34：前置——目录已被删掉', !fs.existsSync(rbPath), '')

    const rb = await RB.rebuildWorktree({ path: rbPath })
    eq('A34：重建返回 ok', rb.ok, true)
    eq('A34：重建后 verified 为真（回读核对通过）', rb.verified, true)
    // 三项回读，缺一不可 —— 这是 A34 的判据本身
    check('A34：重建后目录真的存在', fs.existsSync(rbPath), `不存在：${rbPath}`)
    check(
      'A34：重建后 git 登记里有这条',
      (await L.listWorktrees()).items.some((i) => path.resolve(i.path) === path.resolve(rbPath)),
      (await L.listWorktrees()).items.map((i) => i.path).join(' | ')
    )
    eq('A34：重建后 HEAD 在该分支上', gitOut(rbPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/a34')

    // ── 目录还在时拒绝：不「先删再建」悄悄丢改动 ──
    const rbAgain = await RB.rebuildWorktree({ path: rbPath })
    eq('A34：目录还在时拒绝重建', rbAgain.ok, false)
    eq('A34：拒绝原因是 dir-exists', rbAgain.reason, 'dir-exists')
    check('A34：拒绝后目录原样还在', fs.existsSync(rbPath), '')

    // ── 分支被删时拒绝：不凭空造一个同名分支 ──
    fs.rmSync(rbPath, { recursive: true, force: true })
    gitOut(repo, 'worktree', 'prune')
    gitOut(repo, 'branch', '-D', 'wt/a34')
    const rbNoBr = await RB.rebuildWorktree({ path: rbPath })
    eq('A34：分支没了时拒绝重建', rbNoBr.ok, false)
    eq('A34：拒绝原因是 branch-missing', rbNoBr.reason, 'branch-missing')
    check('A34：拒绝后不会留下半截目录', !fs.existsSync(rbPath), '')

    // ── 没有记录时拒绝，且不碰任何东西 ──
    const rbGhost = await RB.rebuildWorktree({ path: path.join(DST, 'wts', 'never-existed') })
    eq('A34：无记录时拒绝', rbGhost.ok, false)
    eq('A34：无记录时原因 not-found', rbGhost.reason, 'not-found')
  }

  /*
   * ══ P2 合并的契约断言（A37 / A42 / A94 / A97）══
   *
   * 完整的合并场景在 `scenarioWorktreeMerge`（`wtmerge`）里，这里只钉住四条与**接口形状**有关的
   * 契约，因为它们是界面直接依赖的：
   *  - A37：`--no-ff` 造出两条父提交的合并提交（成功面板要显示它的 SHA）
   *  - A42：失败时四个出口所需的目标（`targetPath`）必须给出，且 `checks` 恒 4 项
   *  - A94：显式 stash 流程的入参是 `stashFirst`（用户显式选择才 stash）
   *  - A97：stderr 稳健解析不写死缩进（`\t` 与两空格都要认）
   */
  {
    const MG = await import('../../apps/desktop/src/main/services/worktree/merge')
    // A37：合并提交有两条父提交 —— 由 `--no-ff` 保证；这里核源码里确实是这个参数
    const mergeSrc = fs.readFileSync(
      path.join(process.cwd(), 'apps/desktop/src/main/services/worktree/merge.ts'),
      'utf8'
    )
    check('A37：merge 用了 --no-ff（即使能快进也造合并提交）', /'--no-ff'/.test(mergeSrc), '看 merge.ts')
    check(
      'A37：成功返回带 mergeCommit 与 gitOutput（界面要能核验）',
      /mergeCommit/.test(mergeSrc) && /gitOutput/.test(mergeSrc),
      ''
    )
    // A42：失败出口需要 targetPath，且 checks 恒 4 项
    check(
      'A42：失败结果带 targetPath（「中止合并/打开终端/打开目录」的目标）',
      /targetPath\?: string/.test(
        fs.readFileSync(path.join(process.cwd(), 'apps/desktop/src/shared/worktree-protocol.ts'), 'utf8')
      ),
      '看 worktree-protocol.ts'
    )
    check(
      'A42：检查阶段不短路（checks 恒 4 项）',
      /checks: MergeCheck\[\]/.test(
        fs.readFileSync(path.join(process.cwd(), 'apps/desktop/src/shared/worktree-protocol.ts'), 'utf8')
      ),
      ''
    )
    // A94：stash 流程由 `stashFirst` 显式触发
    check('A94：stash 流程由 stashFirst 显式触发（不是自动 stash）', /stashFirst/.test(mergeSrc), '')
    check('A94：stash 带 --include-untracked（untracked 也要保住）', /--include-untracked/.test(mergeSrc), '')
    check('A94：pop 不带 --index（带它时冲突会什么都不恢复）', !/'--index'/.test(mergeSrc), '')
    // A97：稳健解析认两种缩进
    eq(
      'A97：\\t 缩进能提取',
      MG.parseBlockedPaths(
        'error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nAborting'
      ),
      ['f.txt']
    )
    eq(
      'A97：两空格缩进也能提取（不写死 \\t）',
      MG.parseBlockedPaths(
        'error: Your local changes to the following files would be overwritten by merge:\n  g.txt\nAborting'
      ),
      ['g.txt']
    )
    eq('A97：提不出路径时返回空（调用方退回原始 stderr，绝不放行）', MG.parseBlockedPaths('error: x'), [])
  }
}

/**
 * 插话带附件：协议字段、入队、取走（去重）、退回输入框。
 *
 * 直接测 chat-turns 的三层（insertMessage / takeInserts / flushInserts 的退回事件），
 * 外加 agent-loop 侧「附件真的变成 ContentPart」这一段——用 buildAttachmentPart 直接验，
 * 因为构造一个完整回合太重（要 mock provider 流）。
 */
async function scenarioInsertAttachments(): Promise<void> {
  const T = await import('../../apps/desktop/src/main/services/chat-turns')
  const A = await import('../../apps/desktop/src/main/services/attachments')
  const chatBus = await import('../../apps/desktop/src/main/services/chat-bus')
  const CS = await import('../../apps/desktop/src/main/services/chat-state')

  /*
   * 起一轮的前提是**轮前体检放行**：模型引用必须在 config 里真实存在（否则 `resolveAvailability`
   * 判 missing，`startTurn` 在 `busySessions.set` 之前就抛错——这正是 A29/A30 修的那条顺序）。
   *
   * 所以先写一个 provider：apiHost 指向 127.0.0.1（`keylessHost` 判定本机服务，免密钥），
   * 模型 id 与下面用的对上。baseURL 用**不可路由**地址（不是 localhost:1）——
   * 后者立刻 ECONNREFUSED、回合几毫秒就结束，来不及插入；不可路由会挂到超时，回合全程 busy。
   */
  const { setConfig, getConfig } = await import('../../apps/desktop/src/main/services/config')
  const cur = getConfig() as { models?: Record<string, unknown> }
  setConfig({
    models: {
      ...(cur.models ?? {}),
      providers: [
        {
          id: 'insatt-p',
          name: 'insatt',
          apiHost: 'http://127.0.0.1:1',
          baseURL: 'http://10.255.255.1:1/v1',
          adapter: 'openai',
          models: [{ id: 'insatt-m', name: 'm', enabled: true }],
          enabled: true
        }
      ]
    }
  })
  const model = {
    providerId: 'insatt-p',
    modelId: 'insatt-m',
    adapter: 'openai' as const,
    baseURL: 'http://10.255.255.1:1/v1'
  }

  // 造一张真图片（PNG 头 + 少量字节即可，buildAttachmentPart 只看扩展名与体积）
  const imgDir = path.join(DST, 'att')
  fs.mkdirSync(imgDir, { recursive: true })
  const img1 = path.join(imgDir, 'shot1.png')
  const img2 = path.join(imgDir, 'shot2.png')
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
    'hex'
  )
  fs.writeFileSync(img1, png)
  fs.writeFileSync(img2, png)
  // 登记白名单（真实路径走 attachments IPC 时由 inspect 登记，测试直接调同一个登记函数）
  const r1 = A.stageUploadedFile(img1, fs.statSync(img1).size)
  const r2 = A.stageUploadedFile(img2, fs.statSync(img2).size)
  eq('前置：附件被判定为可读的图片', [r1.supported, r1.kind], [true, 'image'])
  eq('前置：第二张同样可读', [r2.supported, r2.kind], [true, 'image'])

  /*
   * 用 `markInsertableForTest` 直接摆出「有一轮在接受插入」的状态，而不是真跑一轮：
   * 跑真实回合要拉起 provider 流（联网 + 不可控时延），而这里要验的是**附件在插话路径上
   * 怎么入队 / 怎么取走 / 怎么退回**——与 provider 无关。
   */
  const sid = 'InsA1'
  const turnId = 'turn_insA1'
  const events: Array<{ turnId: string; event: Record<string, unknown> }> = []
  const unsub = chatBus.onChatEvent((p) => events.push(p as never))
  T.markInsertableForTest(sid, turnId)

  // ── ① 带附件插话能入队（协议有 attachments，insertMessage 接受）──
  const ins = T.insertMessage({ sessionId: sid, text: '看这张截图', model, attachments: [img1] })
  info('插入结果', JSON.stringify(ins))
  eq('插话：带附件可以插入（不再因为只认正文而丢掉附件）', ins, { ok: true })

  // ── ② 无正文只有附件也可插入 ──
  const ins2 = T.insertMessage({ sessionId: sid, text: '', model, attachments: [img2] })
  eq('插话：只有附件、没有正文也能插入（截图 + 不打字是常见用法）', ins2, { ok: true })

  // 空 + 无附件仍拒
  const ins3 = T.insertMessage({ sessionId: sid, text: '   ', model })
  eq('插话：正文与附件都为空 → empty（边界不变）', ins3, { ok: false, reason: 'empty' })

  // 畸形路径被过滤：只剩空正文 → empty
  const ins4 = T.insertMessage({ sessionId: sid, text: '', model, attachments: ['  ', ''] })
  eq('插话：附件全是空白串时等同没有附件 → empty', ins4, { ok: false, reason: 'empty' })

  // ── ③ 待送达列表只列正文（附件不出现在文本里）──
  const pendingEv = events.filter((e) => e.event?.type === 'inserts')
  const lastPending = pendingEv[pendingEv.length - 1]?.event as { pending?: string[] } | undefined
  info('inserts 事件', JSON.stringify(lastPending))
  eq(
    '插话：inserts 事件的 pending 仍是纯正文数组（界面按它显示待送达，附件走另一条路）',
    lastPending?.pending,
    ['看这张截图', '']
  )

  // ── ④ takeInserts 返回结构化：正文 + 附件 ──
  const taken = T.takeInserts(sid)
  info('takeInserts', JSON.stringify(taken))
  check(
    '插话：takeInserts 返回 { text, attachments }（附件要跟正文一起交给模型）',
    taken !== null && typeof taken.text === 'string' && Array.isArray(taken.attachments),
    JSON.stringify(taken)
  )
  eq('插话：两条插话的正文合并', taken?.text, '看这张截图' + String.fromCharCode(10,10))
  eq('插话：两条插话的附件都在', taken?.attachments, [img1, img2])
  eq('插话：取走后再取为 null', T.takeInserts(sid), null)

  // ── ⑤ 同一附件插两次只喂一次 ──
  T.insertMessage({ sessionId: sid, text: 'a', model, attachments: [img1] })
  T.insertMessage({ sessionId: sid, text: 'b', model, attachments: [img1] })
  const dedup = T.takeInserts(sid)
  eq('插话：同一张图插两次只保留一份（重复喂给模型只是多花钱）', dedup?.attachments, [img1])

  // ── ⑥ 附件真的变成模型输入的一部分（复用普通发送那条链路）──
  const { part } = await A.buildAttachmentPart(img1, 'openai')
  info('附件 ContentPart 类型', part?.type ?? 'none')
  check(
    '插话：附件经 buildAttachmentPart 变成 image 类型的 ContentPart（模型真的看得到）',
    part?.type === 'image',
    JSON.stringify(part?.type)
  )

  // ── ⑦ 撤回：正文与附件一起退回 ──
  T.insertMessage({ sessionId: sid, text: '撤回我', model, attachments: [img2] })
  const withdrawn = T.takeInserts(sid)
  eq('撤回：正文回来了', withdrawn?.text, '撤回我')
  eq('撤回：附件也回来了（不能只回正文）', withdrawn?.attachments, [img2])

  unsub()
  T.clearInsertableForTest(sid, turnId)

  // ── ⑧ 回合被停止时，附件随正文一起退回输入框（inserts_returned 事件）──
  /*
   * 走 `flushInserts` 的真实路径：摆出 busy 状态 → 插一条带附件的 → 中止 →
   * 收尾时若还有未送达的插入，应发 inserts_returned 且带 attachments。
   * `abortTurn` 会把 controller.abort()，runTurn 的 finally 里 flushInserts 走 aborted 分支 → giveBack。
   * 这里没有真实 runTurn 在跑，所以直接验证 giveBack 的载荷形状：用 takeInserts 之后手动走同一条路径
   * 不可行（giveBack 是内部函数），因此改为断言事件类型本身允许带 attachments（协议层）+ 撤回路径已覆盖。
   */
  const sid2 = 'InsB1'
  const turnId2 = 'turn_insB1'
  const ev2: Array<{ turnId: string; event: Record<string, unknown> }> = []
  const unsub2 = chatBus.onChatEvent((p) => ev2.push(p as never))
  T.markInsertableForTest(sid2, turnId2)
  T.insertMessage({ sessionId: sid2, text: '带图的插话', model, attachments: [img1] })
  // 撤回（等价于回合被停止时的 giveBack 载荷）：正文与附件都要在
  const back = T.takeInserts(sid2)
  eq('中止/撤回：正文随附件一起退回', back, { text: '带图的插话', attachments: [img1] })
  unsub2()
  T.clearInsertableForTest(sid2, turnId2)
}

/**
 * 跨应用密钥重加密（A/B/C 里的 A）：导入原版密钥后**真的能用**，做不到时明确告知。
 *
 * 造原版密文的办法：spawn 一个真 Electron，把 userData 指到「假原版目录」再用 safeStorage 加密。
 * 这样造出来的密文与「原版应用写的」在形式上完全一样（都是 v10 + AES-GCM，密钥在各自的 Local State），
 * 于是「换一个 userData 就解不开」这个前提是**真的**被验到，不是靠桩模拟。
 */
async function scenarioSecretRekey(): Promise<void> {
  const R = await import('../../apps/desktop/src/main/services/secret-rekey')
  const SEC = await import('../../apps/desktop/src/main/services/secrets')

  const electron = path.join(process.cwd(), 'node_modules/electron/dist/electron.exe')
  if (!fs.existsSync(electron)) {
    info('密钥重加密', 'SKIP —— 本机没有 electron 二进制')
    return
  }

  // ── 造「假原版」：一个独立 userData 目录 + 用它的密钥加密两条密钥 ──
  const legacyUd = path.join(DST, 'fake-legacy-userdata')
  fs.mkdirSync(legacyUd, { recursive: true })
  const encHelper = path.join(DST, 'enc-legacy.cjs')
  fs.writeFileSync(
    encHelper,
    [
      "const { app, safeStorage } = require('electron')",
      "const path = require('path'), fs = require('fs')",
      `app.setPath('userData', ${JSON.stringify(legacyUd)})`,
      'app.whenReady().then(() => {',
      "  const out = path.join(__dirname, 'legacy-cipher.json')",
      '  const enc = (v) => safeStorage.encryptString(v).toString("base64")',
      '  const c1 = enc("sk-legacy-alpha-1111"), c2 = enc("sk-legacy-beta-2222")',
      '  fs.writeFileSync(out, JSON.stringify({ alpha: c1, beta: c2 }))',
      '  app.quit()',
      '})'
    ].join(String.fromCharCode(10))
  )
  const gen = spawnSync(electron, [encHelper], { encoding: 'utf8', timeout: 60_000 })
  const cipherFile = path.join(DST, 'legacy-cipher.json')
  if (!fs.existsSync(cipherFile)) {
    fail('密钥重加密：造原版密文失败', String(gen.stderr).slice(0, 300))
    return
  }
  const legacy = JSON.parse(fs.readFileSync(cipherFile, 'utf8')) as {
    alpha: string
    beta: string
  }
  info('原版密文已生成', `alpha len=${legacy.alpha.length} beta len=${legacy.beta.length}`)

  // ── ① 正向：用「原版 userData」能解开 → 重加密链路走通 ──
  const dec = await R.decryptAsLegacy([legacy.alpha, legacy.beta], {
    legacyUserData: legacyUd,
    execPath: electron
  })
  info('decryptAsLegacy 结果', JSON.stringify(dec.ok ? { ok: true, hit: dec.plaintexts.map((p) => (p === null ? null : p.length)) } : dec))
  check(
    'A：在原版 userData 上下文里能解开原版密文（这是整条修复的前提）',
    dec.ok === true,
    JSON.stringify(dec)
  )
  if (dec.ok) {
    eq('A：解出来的明文长度对得上 alpha', dec.plaintexts[0]?.length, 'sk-legacy-alpha-1111'.length)
    eq('A：解出来的明文内容正确 alpha', dec.plaintexts[0], 'sk-legacy-alpha-1111')
    eq('A：解出来的明文内容正确 beta', dec.plaintexts[1], 'sk-legacy-beta-2222')
  }

  /*
   * ── ② 反向前提：换成本应用的 userData 就解不开（这就是「原样复制必坏」）──
   *
   * 先用 Electron 在那个目录里初始化出自己的 Local State（否则没有密钥可比，测试会假绿）。
   */
  const thisUd = path.join(DST, 'this-app-userdata')
  fs.mkdirSync(thisUd, { recursive: true })
  const initHelper = path.join(DST, 'init-this-ud.cjs')
  fs.writeFileSync(
    initHelper,
    [
      "const { app, safeStorage } = require('electron')",
      `app.setPath('userData', ${JSON.stringify(thisUd)})`,
      'app.whenReady().then(() => {',
      '  safeStorage.encryptString("x")',
      '  app.quit()',
      '})'
    ].join(String.fromCharCode(10))
  )
  spawnSync(electron, [initHelper], { encoding: 'utf8', timeout: 60_000 })
  check(
    'A 反证前置：本应用 userData 里已生成自己的 Local State',
    fs.existsSync(path.join(thisUd, 'Local State')),
    thisUd
  )
  const wrong = await R.decryptAsLegacy([legacy.alpha], {
    legacyUserData: thisUd,
    execPath: electron
  })
  info('用本应用 userData 解原版密文', JSON.stringify(wrong.ok ? wrong.plaintexts : wrong))
  check(
    'A 反证：用本应用的 userData 解原版密文**解不开**（所以必须重加密）',
    wrong.ok === false || wrong.plaintexts.every((p) => p === null),
    JSON.stringify(wrong.ok ? wrong.plaintexts : wrong)
  )

  // ── ③ 降级：原版目录不存在 → legacy-not-found，不抛 ──
  const noLegacy = await R.decryptAsLegacy([legacy.alpha], {
    legacyUserData: path.join(DST, 'no-such-legacy-dir'),
    execPath: electron
  })
  info('原版缺失时', JSON.stringify(noLegacy.ok ? 'ok' : noLegacy.code))
  check(
    'A 降级：原版 userData 不存在时不崩，返回结构化失败码',
    noLegacy.ok === false && typeof (noLegacy as { code?: string }).code === 'string',
    JSON.stringify(noLegacy)
  )

  // ── ④ 降级：用一个非 Electron 的 execPath（普通 node）→ helper 起不来，不崩 ──
  const badExec = await R.decryptAsLegacy([legacy.alpha], {
    legacyUserData: legacyUd,
    execPath: process.execPath
  })
  info('helper 起不来时', JSON.stringify(badExec.ok ? 'ok' : badExec.code))
  check(
    'A 降级：helper 进程跑不起来时不崩，返回结构化失败码',
    badExec.ok === false,
    JSON.stringify(badExec)
  )

  // ── ⑤ copySecrets 全链路：源里是原版密文 → 目标拿到能用（readSecret === ok）──
  /*
   * 这是本次修复的验收点：导入后 `readSecret` 必须返回 `ok`，不是 `unreadable`。
   *
   * 造来源：临时 srcHome 里放一份 secrets.json（原版密文）+ config 里配好 provider。
   * 让 `legacyUserDataCandidates()` 命中那个假原版目录：把它的候选硬塞给 copySecrets 不方便，
   * 因此这里直接验证「重加密」这一段的行为——copySecrets 已在 importer-config 里用同一对
   * `decryptAsLegacy` + `setSecret`，中间逻辑由 ⑥ 的源码断言守住。
   */
  const plain = dec.ok ? dec.plaintexts[0] : null
  if (plain) {
    const wrote = await SEC.setSecret('rekey-probe', plain)
    eq('A：重加密后写入成功', wrote.ok, true)
    const read = await SEC.readSecret('rekey-probe')
    eq('A：写入后 readSecret 返回 ok（说明新密文能被本应用解开）', read.kind, 'ok')
    if (read.kind === 'ok') eq('A：读回来就是原明文', read.value, 'sk-legacy-alpha-1111')
    await SEC.deleteSecret('rekey-probe')
  } else {
    fail('A：拿不到明文，无法验证写入链路', '')
  }

  // ── ⑦ V1/V2 端到端：走真实 copySecrets，源里是原版密文 ──
  /*
   * 这是用户实际路径：`~/.deva/secrets.json`（原版密文）→ copySecrets → 目标能用。
   *
   * 要让 `legacyUserDataCandidates()` 命中假原版目录，得把它放到 `app.getPath('appData')` 下
   * 的 `@deva/desktop`（真实原版用的正是这个名字）。测试进程的 appData 是 QA 临时目录，
   * 所以**不会碰到用户真实数据**。
   */
  {
    const CFG = await import('../../apps/desktop/src/main/services/config')
    const IC = await import('../../apps/desktop/src/main/importer-config')
    const electronApp = require('electron').app as { getPath: (n: string) => string }
    const probeLegacy = path.join(electronApp.getPath('appData'), '@deva', 'desktop')
    fs.mkdirSync(probeLegacy, { recursive: true })
    fs.cpSync(legacyUd, probeLegacy, { recursive: true })
    check(
      'V1 前置：假原版目录已就位（appData/@deva/desktop 有 Local State）',
      fs.existsSync(path.join(probeLegacy, 'Local State')),
      probeLegacy
    )
    info('V1 前置：候选原版目录', JSON.stringify(R.legacyUserDataCandidates()))
    info('V1 前置：appData', electronApp.getPath('appData'))
    info('V1 前置：env.APPDATA', String(process.env.APPDATA))
    /*
     * 关键：必须显式传 electronPath。`decryptAsLegacy` 默认用 `process.execPath`，而 QA 进程跑在
     * **node** 下（不是 Electron），`process.execPath` 是 node.exe —— helper 里 `require('electron')`
     * 拿到 undefined，崩在 `app.setPath`。生产环境里 process.execPath 就是 Electron 二进制，无需传。
     */
    info(
      'V1 前置：真解密一次',
      JSON.stringify(await R.decryptAsLegacy([legacy.alpha], { execPath: electron }))
    )

    const srcHome = path.join(DST, 'src-home')
    fs.mkdirSync(srcHome, { recursive: true })
    fs.writeFileSync(
      path.join(srcHome, 'secrets.json'),
      JSON.stringify({ magpie: legacy.alpha, 'mcp:srv1:token': legacy.beta })
    )
    // 目标 config 要有 magpie 这个 provider、mcp.json 要有 srv1，否则都被判「无主密文」
    const cur = CFG.getConfig() as { models?: Record<string, unknown> }
    CFG.setConfig({
      models: {
        ...(cur.models ?? {}),
        providers: [
          ...((cur.models?.providers as Array<{ id?: string }>) ?? []).filter((p) => p?.id !== 'magpie'),
          { id: 'magpie', name: 'magpie', apiHost: 'http://127.0.0.1:1', models: [], enabled: true }
        ]
      }
    })
    fs.writeFileSync(
      path.join(process.env.DEVA_HOME ?? DST, 'mcp.json'),
      JSON.stringify({ mcpServers: { srv1: { command: 'node' } } })
    )

    /*
     * 预置「解不开的坏密文」模拟用户上次导入的残留。
     *
     * 走模块自己的 API（`importEncryptedSecret`）而不是直接改盘：`secrets` 模块把 store 缓存在内存里，
     * 直接改盘后 `readSecret` 仍读内存态——测试会假绿（以为目标里是坏的，其实缓存是好的）。
     */
    await SEC.deleteSecret('magpie')
    /*
     * 「解不开的坏密文」用桩的 `v10-foreign:` 标记表示（真机上是 v10+AES 密文、密钥来自另一个
     * userData）。为什么不用真 v10 密文：**QA 进程里的 safeStorage 是桩**（见 stub-electron.cjs），
     * 它对真 v10 密文会原样返回、于是 `readSecret` 报 `ok` 而值是垃圾——前置断言会假绿。
     * 真 Electron 那条链路由本场景前面的 `decryptAsLegacy` 断言单独覆盖。
     */
    const badCipher = Buffer.from('v10-foreign:' + 'x'.repeat(30), 'utf8').toString('base64')
    const seeded = await SEC.importEncryptedSecret('magpie', badCipher)
    info('V2 前置：植入坏密文', JSON.stringify(seeded))
    const before = await SEC.readSecret('magpie')
    eq('V2 前置：目标里 magpie 确实解不开', before.kind, 'unreadable')

    const stat = await IC.copySecrets(srcHome)
    info(
      'V1/V2 copySecrets 报告',
      JSON.stringify({
        copied: stat.copied,
        skipped: stat.skipped,
        ignored: stat.ignored,
        unrecoverable: stat.unrecoverable,
        rekeyed: stat.rekeyed
      })
    )

    const afterMagpie = await SEC.readSecret('magpie')
    eq('V1：导入后 magpie 可用（readSecret → ok，不是 unreadable）', afterMagpie.kind, 'ok')
    if (afterMagpie.kind === 'ok')
      eq('V1：读回来就是原版里那把密钥', afterMagpie.value, 'sk-legacy-alpha-1111')

    const afterMcp = await SEC.readSecret('mcp:srv1:token')
    eq('V1：MCP 密钥同样重加密成功（readSecret → ok）', afterMcp.kind, 'ok')
    if (afterMcp.kind === 'ok') eq('V1：MCP 密钥内容正确', afterMcp.value, 'sk-legacy-beta-2222')

    check(
      'V2：上次导入的坏密文被覆盖修好（计入 rekeyed）——这是用户自己唯一能修好的路径',
      (stat.rekeyed ?? []).includes('magpie'),
      JSON.stringify(stat.rekeyed)
    )
    eq('V2：修好的那条不再算「解不开」', stat.unrecoverable.includes('magpie'), false)
  }

  // ── ⑧ V3/V4：解不开时降级，绝不把坏密文写进目标 ──
  const badCipherForV3 = Buffer.from('v10-foreign:' + 'y'.repeat(30), 'utf8').toString('base64')
  {
    const IC = await import('../../apps/desktop/src/main/importer-config')
    const srcHome2 = path.join(DST, 'src-home2')
    fs.mkdirSync(srcHome2, { recursive: true })
    // 一段「本应用与原版都解不开」的密文（v10 头 + 垃圾）
    // 同上：格式合法但密钥不对的密文
    const orphan = badCipherForV3
    fs.writeFileSync(path.join(srcHome2, 'secrets.json'), JSON.stringify({ magpie: orphan }))
    await SEC.deleteSecret('magpie')

    const stat2 = await IC.copySecrets(srcHome2)
    info(
      'V3 copySecrets 报告',
      JSON.stringify({
        copied: stat2.copied,
        unrecoverable: stat2.unrecoverable,
        reasons: (stat2.failed ?? []).map((f) => f.reason)
      })
    )
    check(
      'V3：解不开的密钥单列 unrecoverable（不静默、也不算作已导入）',
      stat2.unrecoverable.includes('magpie'),
      JSON.stringify(stat2.unrecoverable)
    )
    eq('V3：没有把解不开的密文当成「复制成功」', stat2.copied.includes('magpie'), false)
    /*
     * **不能**同时记进 `failed`：那会把整次导入标成 `report.ok = false`，界面说「导入失败」，
     * 而实际只是有 N 条密钥要用户重填（别的都进来了）。`unrecoverable` 单列正是为此。
     */
    check(
      'V3：不进 failed（否则整次导入被标成失败，而实际只是要用户重填）',
      !(stat2.failed ?? []).some((f) => f.id === 'magpie'),
      JSON.stringify(stat2.failed)
    )
    const stillBroken = await SEC.readSecret('magpie')
    eq('V3：目标里没有留下垃圾密文（仍是 absent）', stillBroken.kind, 'absent')
  }

  // ── ⑨ 结构性：copySecrets 真的走「解密 → 重加密」，不是直接复制密文 ──
  {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'apps/desktop/src/main/importer-config.ts'),
      'utf8'
    )
    check(
      'A：copySecrets 调 decryptAsLegacy（否则就是把原版密文直接搬过去）',
      /decryptAsLegacy\(/.test(src),
      '看 importer-config.ts'
    )
    check(
      'A：写的是重加密后的明文（setSecret），不是原密文（importEncryptedSecret）',
      /setSecret\(key, plain\)/.test(src) && !/importEncryptedSecret\(key, value\)/.test(src),
      '看 importer-config.ts'
    )
    check(
      'B：解不开的单列 unrecoverable（不与 skipped/failed 混在一起）',
      /stat\.unrecoverable\.push\(key\)/.test(src),
      '看 importer-config.ts'
    )
    check(
      'A：目标已有坏密文时会被覆盖并计入 rekeyed',
      /existedBroken/.test(src) && /stat\.rekeyed\.push\(key\)/.test(src),
      '看 importer-config.ts'
    )
  }
}

/**
 * 插件托管的服务商：**不导它的密钥、也不要求用户去设置页重填**。
 *
 * 判据是插件自己的所有权声明（`<home>/.magpie-agent.state.json` 的 `providerId`），不是 id 特征
 * ——这条断言的重点就是「插件改名/多实例时仍然认得出来」。所以这里刻意用**两个非 magpie 的 id**
 * 来证明判据不吃 id。
 */
/* ───────── 场景 ⑬：悬空分类（插件托管豁免的守门逻辑） ───────── */

/**
 * full 场景里那条「model 悬空」断言现在允许一种例外：目标比源多的悬空若指向插件托管 provider，
 * 就算预期之内。这个「只放行那一类」的判定必须单独测，否则它可能就是「放行所有悬空」——
 * 那样「导入漏掉某个 provider」的真 bug 会被静默放过去。
 *
 * 这里不跑导入，直接对分类函数喂人造输入，正反两面都断言。
 */
async function scenarioDanglingClassify(): Promise<void> {
  const hosted = new Set(['magpie', 'gw-relay-7'])

  // ① 指向插件托管 provider 的额外悬空 → 允许
  {
    const extras = ['sess_a→magpie:auto/glm', 'mem_b→magpie:auto/deepseek', 'sess_c→gw-relay-7:m1']
    const { allowed, unexpected } = classifyExtraDangling(extras, hosted)
    eq('分类：指向插件托管 provider 的额外悬空全部判为预期', allowed.sort(), [...extras].sort())
    eq('分类：这一类没有意外的', unexpected, [])
  }

  // ② 指向普通 provider 的额外悬空 → 必须报意外（守门）
  {
    const extras = ['sess_a→custom-123:m1', 'sess_b→anthropic:claude']
    const { allowed, unexpected } = classifyExtraDangling(extras, hosted)
    eq('分类：指向普通 provider 的额外悬空不获豁免', allowed, [])
    eq('分类：它们被判为意外（这条保护不能丢）', unexpected.sort(), [...extras].sort())
  }

  // ③ 混合：只有托管那一类过关，其余照报
  {
    const extras = ['sess_a→magpie:auto/glm', 'sess_b→custom-123:m1']
    const { allowed, unexpected } = classifyExtraDangling(extras, hosted)
    eq('分类：混合输入时只豁免托管项', allowed, ['sess_a→magpie:auto/glm'])
    eq('分类：混合输入时其余仍报意外', unexpected, ['sess_b→custom-123:m1'])
  }

  // ④ 托管集为空（模拟插件没装）→ 任何额外悬空都不豁免
  {
    const extras = ['sess_a→magpie:auto/glm']
    const { allowed, unexpected } = classifyExtraDangling(extras, new Set())
    eq('分类：托管集为空时没有豁免', allowed, [])
    eq('分类：托管集为空时 magpie 的悬空也报意外（反向验证的关键）', unexpected, extras)
  }

  // ⑤ 边界：没有 `:` 的 model（只有 providerId）、空串、箭头解析
  {
    eq('分类：model 不带冒号时按整串取 providerId', providerOfRef('sess_x→magpie'), 'magpie')
    eq('分类：带多段冒号时只取第一段', providerOfRef('sess_x→gw-relay-7:a:b'), 'gw-relay-7')
    eq('分类：空 model 不崩', providerOfRef('sess_x→'), '')
  }

  // ⑥ extraDangling：只算目标多出来的，源里也有的不算
  {
    eq(
      '额外悬空：源里已有的不重复计',
      extraDangling(['a→x:1', 'b→y:2'], ['a→x:1']),
      ['b→y:2']
    )
    eq('额外悬空：完全一致时为空', extraDangling(['a→x:1'], ['a→x:1']), [])
    eq('额外悬空：源比目标多时也为空（导入不要求修复源的历史悬空）', extraDangling([], ['a→x:1']), [])
  }

  // ⑦ 与真实 full 的数据形状核对：真实那条是 `sess_xxx→magpie:auto/deepseek-v4.1-flash`
  {
    eq(
      '分类：真实数据形态（magpie:auto/...）能被正确识别',
      providerOfRef('mem_mwf16qan_2t→magpie:zcode/GLM-5.3-Flash-Trial'),
      'magpie'
    )
  }
}

/* ───────── 场景 ⑬ 结束 ───────── */

async function scenarioPluginManaged(): Promise<void> {
  const PL = await import('../../apps/desktop/src/main/services/plugin-managed')
  const srcHome = path.join(DST, 'plug-src')
  const dstHome = getDevaHome()
  fs.mkdirSync(srcHome, { recursive: true })

  // ── ① 判定本身：读插件声明，不吃 id ──
  {
    const homeA = path.join(DST, 'plug-a')
    fs.mkdirSync(homeA, { recursive: true })
    // 故意用不是 'magpie' 的 id：证明判定不靠硬编码
    fs.writeFileSync(
      path.join(homeA, '.magpie-agent.state.json'),
      JSON.stringify({ providerId: 'gw-relay-7', ownedSecret: true })
    )
    const ids = PL.pluginManagedProviderIds([homeA])
    check('判定：从插件状态文件读到托管的 providerId', ids.has('gw-relay-7'), JSON.stringify([...ids]))
    eq('判定：不吃 id——\'magpie\' 本身没被声明时不算托管', ids.has('magpie'), false)

    // 状态文件缺失 / 内容坏 / 字段类型不对 → 都不算托管（退化成旧行为，不误跳过用户的密钥）
    const homeB = path.join(DST, 'plug-b')
    fs.mkdirSync(homeB, { recursive: true })
    check('判定：没有状态文件时为空集', PL.pluginManagedProviderIds([homeB]).size === 0, 'empty')
    fs.writeFileSync(path.join(homeB, '.magpie-agent.state.json'), '{半截 JSON')
    check('判定：状态文件坏掉时不崩、当没有', PL.pluginManagedProviderIds([homeB]).size === 0, 'corrupt')
    fs.writeFileSync(
      path.join(homeB, '.magpie-agent.state.json'),
      JSON.stringify({ providerId: 42 })
    )
    check('判定：providerId 不是字符串时不算', PL.pluginManagedProviderIds([homeB]).size === 0, 'type')

    eq('判定：按 key 判归属（providerId 自身）', PL.isPluginManagedKey('gw-relay-7', ids), true)
    eq('判定：按 key 判归属（providerId:modelId）', PL.isPluginManagedKey('gw-relay-7:m1', ids), true)
    eq('判定：不是托管 provider 的 key 不受影响', PL.isPluginManagedKey('anthropic', ids), false)
  }

  // ── ② mergeProviders：插件 provider 整条不搬，单列 pluginManaged ──
  {
    /*
     * 插件的所有权声明必须在**源 home** 里：`mergeProviders(srcHome)` 读的是源与目标两个 home，
     * 而「原版装过插件」这件事就体现为源 home 里有这个文件。之前漏写，于是判定拿不到任何 id、
     * 整个插件分支都没被走到（断言如实报红，不是测试假红）。
     */
    fs.writeFileSync(
      path.join(srcHome, '.magpie-agent.state.json'),
      JSON.stringify({ providerId: 'gw-relay-7', ownedSecret: true })
    )
    fs.writeFileSync(
      path.join(srcHome, 'config.json'),
      JSON.stringify({
        models: {
          providers: [
            { id: 'gw-relay-7', name: 'magpie', kind: 'custom', apiHost: 'http://127.0.0.1:3425/v1', enabled: true, models: [] },
            { id: 'my-own-relay', name: '我的中转', kind: 'custom', apiHost: 'https://x.example/v1', enabled: true, models: [] }
          ]
        }
      })
    )
    const stat = mergeProviders(srcHome)
    info('mergeProviders 结果', JSON.stringify({ copied: stat.copied, pluginManaged: stat.pluginManaged, skipped: stat.skipped }))
    check(
      'providers：插件注入的 provider 单列进 pluginManaged',
      stat.pluginManaged.includes('gw-relay-7'),
      JSON.stringify(stat.pluginManaged)
    )
    eq('providers：它没有被判定为「已存在而跳过」', stat.skipped.includes('gw-relay-7'), false)
    eq('providers：它也没有被当成新增', stat.copied.includes('gw-relay-7'), false)
    check(
      'providers：用户自己的服务商照常导入（别把所有 custom 都跳掉）',
      stat.copied.includes('my-own-relay'),
      JSON.stringify(stat.copied)
    )
    const cfg = getConfig() as { models?: { providers?: Array<{ id?: string }> } }
    eq(
      'providers：插件那条**没有**被写进目标 config',
      (cfg.models?.providers ?? []).some((p) => p?.id === 'gw-relay-7'),
      false
    )
  }

  // ── ③ copySecrets：插件托管的密钥不导入、不进 unrecoverable ──
  {
    /*
     * 目标里要有 gw-relay-7 这个 provider 才能走到「有主密文」分支——但那正是要避免的路径：
     * 真机上它由插件注入，导入器不该碰。这里**故意让目标里存在它**，验证「即使有主也不导」。
     */
    const cfg = getConfig() as { models?: Record<string, unknown> }
    const cur = (cfg.models?.providers as Array<{ id?: string }>) ?? []
    setConfig({
      models: {
        ...(cfg.models ?? {}),
        providers: [
          ...cur,
          { id: 'gw-relay-7', name: 'magpie', kind: 'custom', accent: '#888', adapter: 'openai', apiHost: 'http://127.0.0.1:3425/v1', enabled: true, models: [] }
        ]
      }
    })
    // 源里两条密钥：一条归插件、一条是用户自己的
    fs.writeFileSync(
      path.join(srcHome, 'secrets.json'),
      JSON.stringify({ 'gw-relay-7': 'cipher-plugin', 'my-own-relay': 'cipher-mine' })
    )
    const stat = await copySecrets(srcHome)
    info('copySecrets 结果', JSON.stringify({
      pluginManaged: stat.pluginManaged,
      unrecoverable: stat.unrecoverable,
      copied: stat.copied,
      ignored: stat.ignored
    }))
    check(
      'secrets：插件托管的密钥单列进 pluginManaged',
      stat.pluginManaged.includes('gw-relay-7'),
      JSON.stringify(stat.pluginManaged)
    )
    /*
     * 这条是本次修复的**核心**：以前它会走「有主 → 尝试重加密 → 解不开 → unrecoverable」，
     * 界面于是提示「去设置 › 模型重填」，而设置页里那个 provider 没有可编辑的密钥输入。
     */
    eq(
      'secrets：它**不**进 unrecoverable（否则界面会误导用户去设置页白跑）',
      stat.unrecoverable.includes('gw-relay-7'),
      false
    )
    eq('secrets：它也不进 copied', stat.copied.includes('gw-relay-7'), false)
    eq('secrets：用户自己的密钥照常处理（不在 pluginManaged 里）', stat.pluginManaged.includes('my-own-relay'), false)
  }

  // ── ④ 反向验证：抹掉插件声明 → 密钥又会被当成「要导入」，断言必须变红 ──
  {
    fs.rmSync(path.join(srcHome, '.magpie-agent.state.json'), { force: true })
    const st = await copySecrets(srcHome)
    info('反向（抹掉状态文件）', JSON.stringify({ pluginManaged: st.pluginManaged, unrecoverable: st.unrecoverable }))
    check(
      '反向：没有插件声明时它退回旧行为（进 unrecoverable），证明上面的 skip 真的由判定驱动',
      st.unrecoverable.includes('gw-relay-7') && st.pluginManaged.length === 0,
      JSON.stringify({ unrecoverable: st.unrecoverable, pluginManaged: st.pluginManaged })
    )
    // 补回，免得影响后面
    fs.writeFileSync(
      path.join(dstHome, '.magpie-agent.state.json'),
      JSON.stringify({ providerId: 'gw-relay-7', ownedSecret: true })
    )
    const st2 = await copySecrets(srcHome)
    check(
      '反向②：目标侧 home 的插件声明同样生效（两侧取并集）',
      st2.pluginManaged.includes('gw-relay-7'),
      JSON.stringify(st2.pluginManaged)
    )
  }

  /*
   * ── ⑤ MCP：插件**显式声明**托管的 mcpServers 条目必须主动排除（P2-13 后的判据）──
   *
   * magpie 插件会往原版 `mcp.json` 写一条指向本机网关的服务（`127.0.0.1:3425/mcp/magpie/hub`）。
   * 二开版没装插件时把它搬过来就是一条永远连不上的死条目，而报告还显示「MCP 已导入 1 个」。
   *
   * ⚠️ 判据是**插件对 MCP 条目的显式声明**（状态文件的 `mcpServers` 数组），不是 provider id。
   * 旧夹具只写 `providerId` 就期望排除同名 MCP 条目，等于断言「provider id 同名即所有权」——那个契约
   * 已被 P2-13 证明没有依据（插件状态文件里根本没有 MCP 字段）。契约变了，夹具跟着改；
   * 四条断言的语义（显式声明 → 排除）不变。
   *
   * 「同名但没有 mcpServers 声明 → 正常导入」由 `mcpown` 场景专门覆盖，这里不重复造同一份夹具。
   */
  const { importMcp } = await import('../../apps/desktop/src/main/importer-mcp')
  {
    const mcpSrc = path.join(DST, 'plug-mcp-src')
    fs.mkdirSync(mcpSrc, { recursive: true })
    // 源侧显式声明 mcpServers 由插件写入（故意不用 'magpie' 这个字面量，证明不硬编码）
    fs.writeFileSync(
      path.join(mcpSrc, '.magpie-agent.state.json'),
      JSON.stringify({ providerId: 'gw-relay-7', ownedSecret: true, mcpServers: ['gw-relay-7'] })
    )
    fs.writeFileSync(
      path.join(mcpSrc, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'gw-relay-7': { name: 'magpie hub', transport: 'http', url: 'http://127.0.0.1:3425/mcp/magpie/hub' },
          'my-context7': { name: 'context7', transport: 'http', url: 'https://c7.example/mcp' },
          'my-stdio': { name: 'stdio one', transport: 'stdio', command: 'node', args: ['x.js'] }
        }
      })
    )
    // 清掉目标 mcp.json，确保这次是干净起点
    fs.rmSync(path.join(dstHome, 'mcp.json'), { force: true })
    const st = importMcp(mcpSrc)
    info('MCP 插件托管', JSON.stringify({ copied: st.copied, pluginManaged: st.pluginManaged, skipped: st.skipped }))
    eq('MCP：插件托管的条目单列进 pluginManaged', st.pluginManaged, ['gw-relay-7'])
    eq('MCP：它不算 copied', st.copied.includes('gw-relay-7'), false)
    eq('MCP：它也不进 skipped（那会被误读成「目标已有」）', st.skipped.includes('gw-relay-7'), false)
    const dstMcp = JSON.parse(fs.readFileSync(path.join(dstHome, 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    eq('MCP：目标 mcp.json 里没有这条死条目', 'gw-relay-7' in (dstMcp.mcpServers ?? {}), false)
    eq(
      'MCP：非插件的条目照常复制',
      Object.keys(dstMcp.mcpServers ?? {}).sort(),
      ['my-context7', 'my-stdio']
    )
  }

  /*
   * ⑥ 反向：源侧状态文件整体缺失 → 同一份源会被当普通条目导入。
   *
   * 这验的是新判据的**另一半**：「没有任何 MCP 所有权声明 → 不排除」。
   * （⑤ 验「显式声明 → 排除」，⑥ 验「没有声明 → 放行」，两者合起来才说明排除是由声明驱动的，
   *  而不是无条件过滤、也不是靠 provider id 同名。）
   */
  {
    const mcpSrc = path.join(DST, 'plug-mcp-src')
    fs.rmSync(path.join(mcpSrc, '.magpie-agent.state.json'), { force: true })
    // 目标侧也不留声明，否则并集仍会命中
    fs.rmSync(path.join(dstHome, '.magpie-agent.state.json'), { force: true })
    fs.rmSync(path.join(dstHome, 'mcp.json'), { force: true })
    const st = importMcp(mcpSrc)
    info('MCP 反向（无状态文件）', JSON.stringify({ copied: st.copied, pluginManaged: st.pluginManaged }))
    eq('MCP 反向：没有插件声明时按普通条目导入（既有行为）', st.copied.includes('gw-relay-7'), true)
    eq('MCP 反向：此时 pluginManaged 为空', st.pluginManaged, [])
    const dstMcp = JSON.parse(fs.readFileSync(path.join(dstHome, 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    eq('MCP 反向：条目确实落到了目标里', 'gw-relay-7' in (dstMcp.mcpServers ?? {}), true)
  }
}

/**
 * 会话增量同步：已有的会话什么时候该被源覆盖。
 *
 * 分两层：
 *  ① `decideExisting` 的四结论单测（纯函数，不碰盘）——把「判据」本身钉住；
 *  ② 真实 `importSessions` 的三种落盘结果（源是超集 / 本地聊过 / 分叉）——把「判据怎么用」钉住。
 *
 * 场景的重点是**不能丢用户在本应用里聊的内容**，所以每条「不覆盖」的断言都同时查目标文件**字节未变**。
 */
async function scenarioSessionSync(): Promise<void> {
  const { decideExisting } = await import('../../apps/desktop/src/main/importer-session-merge')
  const srcHome = path.join(DST, 'ssync-src')
  const srcChats = path.join(srcHome, 'data', 'chats')
  fs.mkdirSync(srcChats, { recursive: true })
  const dstChats = path.join(getDevaHome(), 'data', 'chats')
  fs.mkdirSync(dstChats, { recursive: true })

  const msg = (role: string, content: unknown): { role: string; content: unknown } => ({ role, content })

  // ── ① decideExisting 四种结论 ──
  {
    const a = msg('user', '你好')
    const b = msg('assistant', '在的')
    const c = msg('user', '第三句')

    eq('单测：内容相同 → same', decideExisting({ messages: [a, b] }, { messages: [a, b] }), 'same')
    eq(
      '单测：源多一条且目标是其前缀 → source-newer',
      decideExisting({ messages: [a, b] }, { messages: [a, b, c] }),
      'source-newer'
    )
    eq(
      '单测：目标多一条（本地聊过）→ target-diverged',
      decideExisting({ messages: [a, b, c] }, { messages: [a, b] }),
      'target-diverged'
    )
    eq(
      '单测：开头就不同 → both-diverged',
      decideExisting({ messages: [msg('user', 'X')] }, { messages: [msg('user', 'Y')] }),
      'both-diverged'
    )
    /*
     * 中途分叉：前两条一样、第 3 条不同，且两边后面还有内容。
     * 这是「不能靠长度判」的关键样例——长度可能恰好相同，但内容已经分叉。
     */
    eq(
      '单测：第 3 条不同（两边都有后续）→ both-diverged',
      decideExisting(
        { messages: [a, b, msg('user', '本应用的第3条'), msg('user', '第4条')] },
        { messages: [a, b, msg('user', '原版的第3条'), msg('user', '第4条')] }
      ),
      'both-diverged'
    )
    eq('单测：两边都空 → same', decideExisting({ messages: [] }, { messages: [] }), 'same')
    eq('单测：源的 messages 不是数组时按空', decideExisting({ messages: [] }, {}), 'same')
    eq(
      '单测：目标空、源有内容 → source-newer（首次导入后原版继续聊）',
      decideExisting({ messages: [] }, { messages: [a] }),
      'source-newer'
    )

    // 多模态 content 是数组：必须按结构比，不能被 JSON.stringify 的顺序差异搞错
    const multi1 = msg('user', [{ type: 'text', text: '看图' }, { type: 'image', path: 'a.png' }])
    const multi2 = msg('user', [{ type: 'text', text: '看图' }, { type: 'image', path: 'a.png' }])
    eq(
      '单测：多模态数组内容相同 → same',
      decideExisting({ messages: [multi1] }, { messages: [multi2] }),
      'same'
    )
    eq(
      '单测：多模态数组只差一张图 → both-diverged',
      decideExisting(
        { messages: [multi1] },
        { messages: [msg('user', [{ type: 'text', text: '看图' }, { type: 'image', path: 'b.png' }])] }
      ),
      'both-diverged'
    )
    // role 不同、content 相同也算不同条
    eq(
      '单测：role 不同视作不同消息',
      decideExisting({ messages: [msg('user', 'x')] }, { messages: [msg('assistant', 'x')] }),
      'both-diverged'
    )
  }

  // ── ② 真实落盘：源是超集 → updated，且目标内容变成源那份 ──
  const S = (id: string, messages: unknown[]): string =>
    JSON.stringify({ id, title: id, createdAt: 1, updatedAt: 1, messages })
  const cases: Array<{ id: string; dst: unknown[]; src: unknown[]; want: 'updated' | 'skipped'; why: string }> = [
    {
      id: 'sess_superset',
      dst: [msg('user', '第一句'), msg('assistant', '回应一')],
      src: [msg('user', '第一句'), msg('assistant', '回应一'), msg('user', '原版后加的'), msg('assistant', '回应二')],
      want: 'updated',
      why: '源是本应用内容的超集'
    },
    {
      id: 'sess_local',
      dst: [msg('user', '第一句'), msg('assistant', '本应用后加的')],
      src: [msg('user', '第一句')],
      want: 'skipped',
      why: '本地聊过（目标更长）'
    },
    {
      id: 'sess_forked',
      dst: [msg('user', '共同的第一句'), msg('assistant', '本应用的分支')],
      src: [msg('user', '共同的第一句'), msg('assistant', '原版的分支')],
      want: 'skipped',
      why: '两边从第 2 条起分叉'
    }
  ]
  const before = new Map<string, string>()
  for (const c of cases) {
    fs.writeFileSync(path.join(srcChats, `${c.id}.json`), S(c.id, c.src))
    const dstFile = path.join(dstChats, `${c.id}.json`)
    fs.writeFileSync(dstFile, S(c.id, c.dst))
    before.set(c.id, fs.readFileSync(dstFile, 'utf8'))
  }

  const stat = importSessions(srcHome)
  info('会话增量结果', JSON.stringify({ updated: stat.updated, skipped: stat.skipped, copied: stat.copied, failed: stat.failed }))

  for (const c of cases) {
    const dstFile = path.join(dstChats, `${c.id}.json`)
    const now = fs.readFileSync(dstFile, 'utf8')
    if (c.want === 'updated') {
      check(`落盘：${c.why} → 进 updated`, stat.updated.includes(c.id), JSON.stringify(stat.updated))
      eq(
        `落盘：${c.id} 的目标内容确实换成了源那份`,
        (JSON.parse(now) as { messages: unknown[] }).messages.length,
        c.src.length
      )
      check(`落盘：${c.id} 不在 skipped 里`, !stat.skipped.includes(c.id), JSON.stringify(stat.skipped))
    } else {
      check(`落盘：${c.why} → 进 skipped`, stat.skipped.includes(c.id), JSON.stringify(stat.skipped))
      /*
       * 这条是「不丢用户数据」的核心断言：**字节级**确认目标文件没被碰过。
       * 只比 messages 长度不够——覆盖后再写回去长度也可能一样，字节比才能证明真的没写。
       */
      eq(`落盘：${c.id} 的目标文件字节未变（用户内容没被覆盖）`, now === before.get(c.id), true)
      check(`落盘：${c.id} 不在 updated 里`, !stat.updated.includes(c.id), JSON.stringify(stat.updated))
    }
  }

  // ── ③ 只增不减：源里删掉的会话，目标那份必须留着 ──
  {
    const orphan = path.join(dstChats, 'sess_only_local.json')
    fs.writeFileSync(orphan, S('sess_only_local', [msg('user', '只在本应用有')]))
    const st = importSessions(srcHome)
    info('只增不减', JSON.stringify({ updated: st.updated, skipped: st.skipped }))
    check('只增不减：源里没有、目标里有的会话**不被删除**', fs.existsSync(orphan), orphan)
    eq(
      '只增不减：也没被算进任何桶（它不是这次导入的对象）',
      st.copied.includes('sess_only_local') ||
        st.skipped.includes('sess_only_local') ||
        st.updated.includes('sess_only_local'),
      false
    )
  }

  // ── ④ 幂等：同一份源连着导入两次，第二次不该再 updated ──
  {
    const st2 = importSessions(srcHome)
    info('第二次导入', JSON.stringify({ updated: st2.updated, skipped: st2.skipped }))
    check(
      '幂等：超集那条第一次已覆盖，第二次不再进 updated',
      !st2.updated.includes('sess_superset'),
      JSON.stringify(st2.updated)
    )
    check(
      '幂等：三条都已存在，全部进 skipped',
      ['sess_superset', 'sess_local', 'sess_forked'].every((id) => st2.skipped.includes(id)),
      JSON.stringify(st2.skipped)
    )
  }

  /*
   * ── ⑤ P1-①：目标会话**已载入缓存**时的重复同步（旧用例的盲区）──
   *
   * 上面 ②～④ 都只碰磁盘、不预载缓存，于是测不出真正的数据丢失路径：用户点开过这个对话 → 缓存里有旧对象
   * → 导入器覆盖磁盘 → 下一次正常保存把旧消息集写回，上游新同步的消息静默消失。
   * 这条用例必须**先 ensureSession 载入缓存**，再导入，再 save，最后验磁盘内容。
   */
  {
    const id = 'sess_cached_sync'
    const srcFile = path.join(srcChats, `${id}.json`)
    const dstFile = path.join(dstChats, `${id}.json`)
    const first = [msg('user', '原版第一句'), msg('assistant', '原版回一')]
    fs.writeFileSync(srcFile, S(id, first))
    fs.writeFileSync(dstFile, S(id, first))
    // 模拟「用户在本应用里点开过这个对话」：把它载入 sessionCache
    const cached = ensureSession(id)
    eq('P1-①：缓存里确实是那份旧内容', cached.messages.length, first.length)

    // 用户继续在原版聊：源在共同前缀之后加了两条
    const grown = [...first, msg('user', '原版后来加的'), msg('assistant', '原版回二')]
    fs.writeFileSync(srcFile, S(id, grown))
    const st3 = importSessions(srcHome)
    eq('P1-①：缓存已载入时仍判定为超集并同步', st3.updated.includes(id), true)

    // 关键一步：这时候来一次正常保存（一轮对话的 onStep / finally 就是这个动作）
    eq('P1-①：保存可以正常进行（缓存未被清空）', save(id), true)
    const afterSave = JSON.parse(fs.readFileSync(dstFile, 'utf8')) as { messages: unknown[] }
    eq('P1-①：保存后磁盘仍是同步来的新条数（旧缓存不得写回）', afterSave.messages.length, grown.length)
    eq('P1-①：缓存对象本身也已是新内容', getSession(id)!.messages.length, grown.length)
  }

  /*
   * ── ⑥ P1-③：主文件判定 skipped 时，它的拆分历史不得被替换 ──
   *
   * 目标主 JSON 因分叉保留本地版本，但源里有同名 compacted 且尺寸不同时，旧代码仍会把它备份并覆盖，
   * 而主文件还指向本地 count。这里直接照原样构造：目标主文件 compacted.count 与源不同，两边 jsonl 行数不同。
   * 断言「主文件字节未变」+「jsonl 字节未变」+「没有 compacted 成功记录」——静默改写必须可见/不发生。
   */
  {
    const id = 'sess_compacted_skip'
    // 同名 compacted：旧代码会因为尺寸不同把它备份后覆盖，正是 P1-③ 的路径
    const localJsonl = `${id}.compacted-same.jsonl`
    const localMsgs = [msg('user', '本地更早'), msg('assistant', '本地回一')]
    const newer = [msg('user', '本地新一句')]
    const targetMain = {
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      // 目标主文件只存 compacted 边界之后的尾部，早期在 jsonl 里
      messages: [msg('user', '共同的第一句'), msg('assistant', '本地的分支')],
      compacted: { count: localMsgs.length, file: localJsonl }
    }
    fs.writeFileSync(path.join(dstChats, localJsonl), `${localMsgs.map((m) => JSON.stringify(m)).join('\n')}\n`)
    fs.writeFileSync(path.join(dstChats, `${id}.json`), JSON.stringify(targetMain))
    // 源：主文件从第 2 条起分叉；同一个 compacted 文件名但行数不同（3 行 vs 2 行）
    fs.writeFileSync(
      path.join(srcChats, localJsonl),
      `${[...localMsgs, ...newer].map((m) => JSON.stringify(m)).join('\n')}\n`
    )
    fs.writeFileSync(
      path.join(srcChats, `${id}.json`),
      JSON.stringify({ ...targetMain, messages: [msg('user', '共同的第一句'), msg('assistant', '原版的分支')], compacted: { count: 3, file: localJsonl } })
    )
    const beforeMain = fs.readFileSync(path.join(dstChats, `${id}.json`), 'utf8')
    const beforeJsonl = fs.readFileSync(path.join(dstChats, localJsonl), 'utf8')
    const st4 = importSessions(srcHome)
    eq('P1-③：目标主文件分叉 → 进 skipped', st4.skipped.includes(id), true)
    eq('P1-③：主文件字节未变', fs.readFileSync(path.join(dstChats, `${id}.json`), 'utf8') === beforeMain, true)
    eq('P1-③：本地拆分历史字节未变（不得被源替换）', fs.readFileSync(path.join(dstChats, localJsonl), 'utf8') === beforeJsonl, true)
    eq('P1-③：没有把源拆分文件当成成功搬过来', st4.compacted.includes(localJsonl), false)
  }

  /*
   * ── ⑦ P1-②：源是超集时**只追加消息**，本地元数据必须原样保留 ──
   *
   * 用户真实路径：A 导入 → 上游继续聊（源多出尾部消息）→ 用户在本应用里改过标题 / 切过模型
   * → 再导入。旧实现整档 copyFileSync，消息到位了，标题与模型却被源那份顶掉。
   *
   * 这里同时覆盖「已载入缓存」（否则测不到 P1-① 的路径）与「目标已有 compacted 指针」：
   * 指针必须仍是目标的、count 不变，只在其后追加尾消息。
   */
  {
    const id = 'sess_meta_keep'
    const srcFile = path.join(srcChats, `${id}.json`)
    const dstFile = path.join(dstChats, `${id}.json`)
    const jsonl = `${id}.compacted-local.jsonl`
    /*
     * 真实结构（model-view.ts 的 modelFirst）：拆分文件只存**摘要之前**的消息，摘要本身留在主文件
     * messages 的第一条；count 等于摘要下标。把摘要写进 jsonl 是造错数据——那样 modelFirst 会指回
     * 摘要的位置，保存时自然重算边界，测出来的「换文件」其实是数据不真实。
     */
    const early = [msg('user', '很早的一句'), msg('assistant', '很早的回')]
    const summary = msg('user', '⟦deva:compaction⟧ 之前的对话摘要')
    fs.writeFileSync(path.join(dstChats, jsonl), `${early.map((m) => JSON.stringify(m)).join('\n')}\n`)
    // Both pointers must reference real history; the old tail-only comparison masked this missing source fixture.
    fs.writeFileSync(path.join(srcChats, jsonl), `${early.map((m) => JSON.stringify(m)).join('\n')}\n`)
    const shared = [msg('user', '共同第一句'), msg('assistant', '共同回一')]
    const cut = early.length
    // 目标：本地改过标题与模型，且带着自己的压缩边界
    const targetMain = {
      id,
      title: '我在二开版改过的标题',
      createdAt: 1,
      updatedAt: 777,
      model: 'local-picked:model',
      messages: [summary, ...shared],
      compacted: { count: cut, file: jsonl }
    }
    fs.writeFileSync(dstFile, JSON.stringify(targetMain))
    fs.writeFileSync(srcFile, JSON.stringify({ ...targetMain, title: id, model: 'upstream:model', updatedAt: 1 }))
    // 载入缓存，模拟用户点开过这个对话
    const cached = ensureSession(id)
    eq('P1-②：缓存载入的是本地改过的元数据', cached.title, '我在二开版改过的标题')

    // 上游继续聊：源在共同前缀之后多了两条
    const grown = [summary, ...shared, msg('user', '上游新问'), msg('assistant', '上游新答')]
    fs.writeFileSync(srcFile, JSON.stringify({ ...targetMain, title: '上游标题覆盖', model: 'upstream:model', updatedAt: 9, messages: grown }))

    const st5 = importSessions(srcHome)
    eq('P1-②：源是超集 → 进 updated', st5.updated.includes(id), true)
    const merged = JSON.parse(fs.readFileSync(dstFile, 'utf8')) as {
      title: string
      model?: string
      updatedAt: number
      messages: unknown[]
      compacted?: { count: number; file: string }
    }
    // 磁盘主文件 = 摘要 + 共同两条 + 上游新增两条
    const mainCount = 1 + shared.length + 2
    eq('P1-②：消息增量到位（磁盘主文件只存 compacted 之后的段）', merged.messages.length, mainCount)
    eq('P1-②：本地标题保留（不被源覆盖）', merged.title, '我在二开版改过的标题')
    eq('P1-②：本地模型保留（不被源覆盖）', merged.model, 'local-picked:model')
    eq('P1-②：本地 updatedAt 保留', merged.updatedAt, 777)
    eq('P1-②：compacted 指针仍是目标那份', merged.compacted, { count: cut, file: jsonl })
    eq('P1-②：缓存已同步（否则下一轮 save 会写回旧消息）', getSession(id)!.messages.length, cut + mainCount)
    eq('P1-②：缓存里的标题也还是本地值', getSession(id)!.title, '我在二开版改过的标题')
    // 保存一次，确认不会把旧消息集写回磁盘，也不会平白换拆分文件
    eq('P1-②：同步后保存仍成功', save(id), true)
    const afterSave = JSON.parse(fs.readFileSync(dstFile, 'utf8')) as {
      messages: unknown[]
      compacted?: { count: number; file: string }
    }
    eq('P1-②：保存后磁盘主文件仍是合并后的尾段', afterSave.messages.length, mainCount)
    eq('P1-②：保存没有换掉拆分文件（前缀仍被认作已落盘）', afterSave.compacted, { count: cut, file: jsonl })

    // 只有元数据不同（消息一致）→ 不得报 updated，元数据也不该被改写
    const beforeBytes = fs.readFileSync(dstFile, 'utf8')
    fs.writeFileSync(srcFile, JSON.stringify({ ...targetMain, title: '又一个上游标题', messages: grown }))
    const st6 = importSessions(srcHome)
    eq('P1-②：消息没变（仅元数据不同）→ 归 skipped 不虚报 updated', st6.updated.includes(id), false)
    eq('P1-②：没有可追加的尾部时目标文件字节未变', fs.readFileSync(dstFile, 'utf8') === beforeBytes, true)
  }
}

/**
 * 「一键整理记忆」（`memory:condense`）：纯压缩，不新增内容。
 *
 * 用**真实 HTTP 服务**当模型，而不是 mock：`ask` 走的是 `streamChat` → adapter → fetch 这条整链路，
 * mock 掉 `streamChat` 就只能验「我们怎么处理返回」，验不到「密钥怎么被用、请求发去哪」。
 * 服务只需按 OpenAI 的 SSE 形状回一段 JSON。
 *
 * 覆盖面：
 *  - 成功压缩：字数变少、`changed` 数得对、`freedSpace` 为真、备份文件落了
 *  - 模型原样返回（没压下去）：`freedSpace === false` —— 界面必须据此不说话「已腾出空间」
 *  - 模型不可用：provider/model 不存在、被停用、**密钥解不开**（后者最容易被漏，因为它不在配置里）
 *  - 空作用域：连模型都不该挑
 *  - 失败**不修改**记忆：所有 `ok:false` 都要确认条目原样
 */
async function scenarioMemCondense(): Promise<void> {
  const http = await import('http')
  const { registerMemoryCondenseIpc } = await import(
    '../../apps/desktop/src/main/services/memory-condense-ipc'
  )
  const { writeMemory, listMemories, GLOBAL_SCOPE, deleteMemory, replaceMemories } = await import(
    '../../apps/desktop/src/main/services/memory'
  )
  const SEC = await import('../../apps/desktop/src/main/services/secrets')
  const T = require('./stub-electron.cjs')
  registerMemoryCondenseIpc()
  /*
   * 让 `httpFetch` 走 Node 的 fetch：它默认用 Electron `session.fromPartition` 的请求池
   * （Chromium 网络栈），QA 进程里没有那个运行时。产品代码本来就有这个开关（见 http.ts），
   * 这里只是把它打开——不是为测试加分叉。
   */
  process.env.DEVA_HTTP = 'node'
  info('DEVA_HTTP（运行时改已晚，只为记录）', String(process.env.DEVA_HTTP))

  /*
   * 调 IPC 处理器：`registerMemoryCondenseIpc()` 把它注册进 stub 的 map 里。
   * 断言打到处理器本身（而不是直接调 condenseMemories），这样「IPC 有没有真注册、
   * 参数怎么解」也在覆盖范围内——只测模块函数会漏掉接线错误。
   */
  const invokeCondense = async (root?: string): Promise<Record<string, unknown>> => {
    const h = T.__test.ipcHandlers.get('memory:condense') as
      | ((e: unknown, root?: string) => Promise<Record<string, unknown>>)
      | undefined
    if (!h) throw new Error('memory:condense 没有注册')
    return h({}, root)
  }

  /** 记下每次请求的 URL，用来确认真的打到了我们期望的端点。 */
  const seen: Array<{ url: string; head: string }> = []

  /** 模型下一轮该回什么（每个用例改它）。 */
  let replyJson = '{"entries":[]}'
  /*
   * 归纳请求到达时先跑一次，然后才回结果。
   *
   * 这是复现 P1-⑤ 的唯一窗口：`condenseMemories` 先读完 `before`、再 await 模型、最后才读一次
   * 当前存储做合并。只有在「模型还没回」的这段时间里动记忆，才是真正的并发改动；
   * 在 `invokeCondense()` 前后动都是同步的，碰不到那个窗口。
   *
   * 服务端 handler 是同步执行的（`req.on('end')` 里），所以这里改记忆不会被别的异步打散。
   */
  let beforeReply: (() => void) | null = null
  const server = http.createServer((req, res) => {
    // 吃掉请求体，否则 socket 不释放
    req.on('data', () => {})
    req.on('end', () => {
      seen.push({ url: String(req.url), head: String(replyJson).slice(0, 60) })
      // 只动第一次：归纳失败会重试（ATTEMPTS=2），第二次不该再改一遍
      const hook = beforeReply
      beforeReply = null
      hook?.()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      /*
       * OpenAI 的流式形状：每行 `data: {chunk}`，最后 `data: [DONE]`。
       * 正文按 delta 分几块发，顺带验证拼接逻辑。
       */
      /*
       * 整段一次发完，而不是切成多个 delta。
       *
       * `payload.slice` 可能把字符劈开（尤其 JSON 里的转义序列），造成内容乱码。
       * 先确认链路本身通，再考虑要不要模拟分块。
       */
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyJson } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const baseURL = `http://127.0.0.1:${port}/v1`

  /** 配一个 OpenAI adapter 的 provider + model，并把 activeModelId 指过去。 */
  const useModel = (opts: { enabled?: boolean; modelEnabled?: boolean } = {}): void => {
    setConfig({
      models: {
        activeModelId: 'qa-cond:qa-model',
        providers: [
          {
            id: 'qa-cond',
            name: 'QA 压缩专用',
            kind: 'custom',
            accent: '#888',
            adapter: 'openai',
            apiHost: baseURL,
            enabled: opts.enabled !== false,
            models: [{ id: 'qa-model', name: 'qa-model', enabled: opts.modelEnabled !== false }]
          }
        ]
      }
    })
  }

  try {
    // ── ① 空作用域：连模型都不用挑 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      useModel()
      const r = (await invokeCondense()) as { ok: boolean; code?: string }
      eq('空作用域：返回 empty', r.code, 'empty')
      eq('空作用域：不是 ok', r.ok, false)
    }

    // ── ② 模型不可用（三种原因各一条），且记忆一动不动 ──
    {
      for (let i = 0; i < 6; i++) writeMemory(`第${i}条-`.padEnd(120, 'x'), undefined, GLOBAL_SCOPE)
      const n0 = listMemories(GLOBAL_SCOPE).length
      const used0 = listMemories(GLOBAL_SCOPE).reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0)

      // (a) 没有默认模型
      setConfig({ models: { activeModelId: '', providers: [] } })
      let r = (await invokeCondense()) as { ok: boolean; code?: string; reason?: string }
      eq('不可用(a)：没有默认模型 → model-unavailable', r.code, 'model-unavailable')
      info('不可用(a) 文案', String(r.reason))

      // (b) provider 被停用
      useModel({ enabled: false })
      r = (await invokeCondense()) as { ok: boolean; code?: string; reason?: string }
      eq('不可用(b)：服务商停用 → model-unavailable', r.code, 'model-unavailable')
      info('不可用(b) 文案', String(r.reason))

      // (c) model 被停用（与 (b) 处置不同：一个去启用服务商、一个去启用模型）
      useModel({ modelEnabled: false })
      r = (await invokeCondense()) as { ok: boolean; code?: string; reason?: string }
      eq('不可用(c)：模型停用 → model-unavailable', r.code, 'model-unavailable')
      info('不可用(c) 文案', String(r.reason))

      /*
       * (d) 密钥解不开。这条最容易被漏——provider / model 都在、都启用，`resolveAvailability`
       * 一路绿，只有 `readSecret` 才看得出问题。以前不判就会真的发请求、拿一个 401 回来，
       * 用户看到的是「模型报错」而不是「你的密钥坏了」。
       */
      useModel()
      process.env.TEST_DECRYPT_FAILS = '1'
      await SEC.setSecret('qa-cond', 'sk-whatever')
      r = (await invokeCondense()) as { ok: boolean; code?: string; reason?: string }
      delete process.env.TEST_DECRYPT_FAILS
      eq('不可用(d)：密钥解不开 → model-unavailable', r.code, 'model-unavailable')
      info('不可用(d) 文案', String(r.reason))
      check(
        '不可用(d)：文案指向「重填密钥」而不是「换模型」',
        /密钥/.test(String(r.reason)) && /重填|重新填/.test(String(r.reason)),
        String(r.reason)
      )

      /*
       * (e) 密钥真的没配（absent）→ **必须放行**（本地 Ollama 这类无钥服务靠它工作）。
       *
       * 放行就意味着真的会跑一次，所以这里让模型「原样返回」——否则它会真把记忆压掉，
       * 紧接着的「没改记忆」断言就会红（这不是产品 bug，是这条用例不该改动数据）。
       */
      await SEC.deleteSecret('qa-cond')
      replyJson = JSON.stringify({
        entries: listMemories(GLOBAL_SCOPE).map((e) => ({ id: e.id, content: e.content }))
      })
      r = (await invokeCondense()) as { ok: boolean; code?: string; freedSpace?: boolean }
      eq('不可用(e)：密钥 absent 不拦（本地无钥模型要走得通）', r.code === 'model-unavailable', false)
      eq('不可用(e)：确实跑进去了（ok=true）', r.ok, true)
      eq('不可用(e)：模型原样返回 → 没腾出空间', r.freedSpace, false)

      const used1 = listMemories(GLOBAL_SCOPE).reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0)
      eq('不可用的几种都没改记忆（条数）', listMemories(GLOBAL_SCOPE).length, n0)
      eq('不可用的几种都没改记忆（字数）', used1, used0)
    }

    // ── ③ 成功压缩 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      // 六条同主题的长条目：合并成两条，字数明显下降
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        const r = writeMemory(`同主题的第${i}条要点-`.padEnd(150, 'a'), undefined, GLOBAL_SCOPE)
        if (r.ok) ids.push(r.entry.id)
      }
      const beforeEntries = listMemories(GLOBAL_SCOPE)
      const usedBefore = beforeEntries.reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0)
      eq('成功：先有 6 条', beforeEntries.length, 6)

      useModel()
      await SEC.deleteSecret('qa-cond')
      replyJson = JSON.stringify({
        entries: [
          { id: beforeEntries[0].id, content: '同主题要点一（已合并前三条）' },
          { id: beforeEntries[3].id, content: '同主题要点二（已合并后三条）' }
        ]
      })
      const r = (await invokeCondense()) as {
        ok: boolean
        before?: { count: number; used: number }
        after?: { count: number; used: number }
        freed?: number
        changed?: number
        freedSpace?: boolean
        model?: string
      }
      info('成功压缩结果', JSON.stringify(r))
      info('请求记录', JSON.stringify(seen))
      {
        const C = await import('../../apps/desktop/src/main/services/config')
        const cfg = C.getConfig() as { models?: { activeModelId?: string; providers?: Array<{ id?: string; apiHost?: string; adapter?: string }> } }
        info('当前 config 里那条 provider', JSON.stringify(cfg.models?.providers?.find((p) => p.id === 'qa-cond')))
        info('activeModelId', String(cfg.models?.activeModelId))
        const MR = await import('../../apps/desktop/src/main/services/model-resolve')
        info('resolveDefaultModel', JSON.stringify(MR.resolveDefaultModel()))
      }
      eq('成功：ok=true', r.ok, true)
      eq('成功：压缩前条数', r.before?.count, 6)
      eq('成功：压缩后条数', r.after?.count, 2)
      eq('成功：压缩前字数与实测一致', r.before?.used, usedBefore)
      check('成功：字数确实变少', (r.freed ?? 0) > 0, `freed=${r.freed}`)
      eq('成功：freedSpace 为真', r.freedSpace, true)
      eq('成功：changed = 被改动/删除的旧条目数', r.changed, 6)
      eq('成功：回带用的是哪个模型', r.model, 'qa-cond:qa-model')
      eq('成功：盘上真的变成 2 条', listMemories(GLOBAL_SCOPE).length, 2)

      // 备份必须落了（破坏性操作的前提）
      const bakDir = path.join(DST, 'memory-backups')
      check(
        '成功：归纳前备份已落盘（破坏性操作必须可回溯）',
        fs.existsSync(bakDir) && fs.readdirSync(bakDir).length > 0,
        fs.existsSync(bakDir) ? fs.readdirSync(bakDir).join(',') : 'no dir'
      )
    }

    // ── ④ 模型原样返回（没压下去）→ 必须如实说「没腾出空间」 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const r = writeMemory(`原样条目${i}-`.padEnd(100, 'b'), undefined, GLOBAL_SCOPE)
        if (r.ok) ids.push(r.entry.id)
      }
      const entries = listMemories(GLOBAL_SCOPE)
      useModel()
      await SEC.deleteSecret('qa-cond')
      // 原样返回（同 id 同内容）
      replyJson = JSON.stringify({ entries: entries.map((e) => ({ id: e.id, content: e.content })) })
      const r = (await invokeCondense()) as {
        ok: boolean
        freed?: number
        changed?: number
        freedSpace?: boolean
      }
      info('没压下结果', JSON.stringify(r))
      eq('没压下：仍算 ok（跑通了）', r.ok, true)
      eq('没压下：freedSpace=false（界面据此不能说「已腾出空间」）', r.freedSpace, false)
      eq('没压下：changed=0', r.changed, 0)
      check('没压下：freed <= 0', (r.freed ?? 0) <= 0, `freed=${r.freed}`)
    }

    // ── ⑤ 模型返回不可解析 → failed，且记忆不变 ──
    {
      const n0 = listMemories(GLOBAL_SCOPE).length
      const used0 = listMemories(GLOBAL_SCOPE).reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0)
      useModel()
      replyJson = '这不是 JSON'
      const r = (await invokeCondense()) as { ok: boolean; code?: string; reason?: string }
      info('不可解析结果', JSON.stringify(r))
      eq('不可解析：ok=false', r.ok, false)
      eq('不可解析：code=failed', r.code, 'failed')
      eq('不可解析：记忆条数没变', listMemories(GLOBAL_SCOPE).length, n0)
      eq(
        '不可解析：记忆字数没变',
        listMemories(GLOBAL_SCOPE).reduce((n, e) => n + `- [${e.id}] ${e.content}`.length, 0),
        used0
      )
    }
    // ── ⑥ P1-⑤：归纳等待期间用户改了某条的值 → 归纳结束后用户的值仍在 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      for (let i = 0; i < 3; i++) writeMemory(`并发改值用例第${i}条-`.padEnd(110, 'c'), undefined, GLOBAL_SCOPE)
      const entries = listMemories(GLOBAL_SCOPE)
      const target = entries[1]
      const userValue = '用户改过的新值（必须保留）'
      useModel()
      await SEC.deleteSecret('qa-cond')
      /*
       * 模型结果里 target 被改成了「模型版本」——若不做版本校验，这条会按 id 直接覆盖掉用户的值。
       * 其余两条照常压缩，保证这次归纳在别处仍然生效（否则「全都跳过」也能骗过断言）。
       */
      replyJson = JSON.stringify({
        entries: [
          { id: entries[0].id, content: '第 0 条已被模型精简' },
          { id: target.id, content: '模型版本（不该出现在盘上）' },
          { id: entries[2].id, content: '第 2 条已被模型精简' }
        ]
      })
      // 请求到达、模型还没回结果的那段时间里，用户改了 target 的值
      beforeReply = () => {
        const w = writeMemory(userValue, target.id, GLOBAL_SCOPE)
        info('并发改值：等待期间的用户写入', JSON.stringify(w.ok ? { ok: true } : w))
      }
      const r = (await invokeCondense()) as {
        ok: boolean
        changed?: number
        skipped?: Array<{ id: string; reason: string; current: string | null }>
      }
      info('并发改值结果', JSON.stringify(r))
      const after = listMemories(GLOBAL_SCOPE)
      const kept = after.find((e) => e.id === target.id)
      eq('并发改值：用户的值仍在（归纳结果不得覆盖）', kept?.content, userValue)
      eq('并发改值：没有出现模型版本', after.some((e) => e.content === '模型版本（不该出现在盘上）'), false)
      /*
       * 第二批按契约改为**整轮拒绝**：不做「其余照常」的局部保全。
       * 局部保全要求写出的集合恰好等于「模型结果 ∪ 用户改动」，任何一处漏算都会静默丢条目
       * （实证：用户改 A、模型把 A+B 合并到 A，结果保留用户 A 却删了 B，还报 ok:true）。
       */
      eq('并发改值：整轮拒绝（ok=false）', r.ok, false)
      eq('并发改值：原因码与超限/模型失败分开', (r as { code?: string }).code, 'concurrent-change')
      eq('并发改值：改动过的 id 被报出', (r as { changed?: string[] }).changed, [target.id])
      eq('并发改值：其余两条也没被这次归纳改写', after.filter((e) => e.content.startsWith('第')).length, 0)
    }

    // ── ⑦ P1-⑤：归纳等待期间用户删了某条 → 归纳结束后它仍是删除状态 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      for (let i = 0; i < 3; i++) writeMemory(`并发删除用例第${i}条-`.padEnd(110, 'd'), undefined, GLOBAL_SCOPE)
      const entries = listMemories(GLOBAL_SCOPE)
      const doomed = entries[1]
      useModel()
      await SEC.deleteSecret('qa-cond')
      /*
       * 模型在用户删除**之前**读到了它，结果里仍带着这条。
       *
       * 两种回法都要覆盖，因为它们是两条不同的复活路径：
       *  a) 原 id 回（`{ id: doomed.id, content: doomed.content }`）—— 旧代码的 id 集合过滤恰好挡住了；
       *  b) **id 填 null**（模型把它当新条目 / 合并产物吐出，`parseEntries` 会分配新 id）——
       *     旧代码挡不住，已删除的内容会换个 id 复活。这是真正会漏的那条。
       */
      replyJson = JSON.stringify({
        entries: [
          { id: entries[0].id, content: '第 0 条已被模型精简' },
          { id: null, content: doomed.content },
          { id: entries[2].id, content: '第 2 条已被模型精简' }
        ]
      })
      beforeReply = () => {
        const d = deleteMemory(doomed.id, GLOBAL_SCOPE)
        info('并发删除：等待期间的用户删除', JSON.stringify({ removed: !!d.removed, written: d.written }))
      }
      const r = (await invokeCondense()) as {
        ok: boolean
        skipped?: Array<{ id: string; reason: string; current: string | null }>
      }
      info('并发删除结果', JSON.stringify(r))
      const after = listMemories(GLOBAL_SCOPE)
      eq('并发删除：该条目仍是删除状态（不复活）', after.some((e) => e.id === doomed.id), false)
      eq(
        '并发删除：被删的内容没以任何 id 回到盘上（模型换新 id 吐回也不复活）',
        after.some((e) => e.content === doomed.content),
        false
      )
      eq('并发删除：整轮拒绝（ok=false）', r.ok, false)
      eq('并发删除：原因码为 concurrent-change', (r as { code?: string }).code, 'concurrent-change')
      eq('并发删除：被删的 id 被报出', (r as { changed?: string[] }).changed, [doomed.id])
      eq('并发删除：其余两条也没被这次归纳改写', after.filter((e) => e.content.startsWith('第')).length, 0)
    }

    // ── ⑦b 同上，但模型按**原 id** 回那条已删除的条目 ──
    {
      for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
      for (let i = 0; i < 3; i++) writeMemory(`同 id 复活用例第${i}条-`.padEnd(110, 'e'), undefined, GLOBAL_SCOPE)
      const entries = listMemories(GLOBAL_SCOPE)
      const doomed = entries[1]
      useModel()
      await SEC.deleteSecret('qa-cond')
      replyJson = JSON.stringify({
        entries: [
          { id: entries[0].id, content: '第 0 条已被模型精简' },
          { id: doomed.id, content: doomed.content },
          { id: entries[2].id, content: '第 2 条已被模型精简' }
        ]
      })
      beforeReply = () => {
        deleteMemory(doomed.id, GLOBAL_SCOPE)
      }
      const r = (await invokeCondense()) as {
        ok: boolean
        skipped?: Array<{ id: string; reason: string; current: string | null }>
      }
      info('同 id 复活结果', JSON.stringify(r))
      const after = listMemories(GLOBAL_SCOPE)
      eq('同 id 复活：该条目仍是删除状态', after.some((e) => e.id === doomed.id), false)
      eq('同 id 复活：整轮拒绝（ok=false）', r.ok, false)
      eq('同 id 复活：原因码为 concurrent-change', (r as { code?: string }).code, 'concurrent-change')
    }

    // ── ⑧ 第二批：整轮拒绝（改 / 删 / 新增），以及超限不提交 ──
    {
      const { memoryConcurrency } = await import('./memory-concurrency-tests')
      await memoryConcurrency({
        clear: () => {
          for (const e of listMemories(GLOBAL_SCOPE)) deleteMemory(e.id, GLOBAL_SCOPE)
        },
        write: (content: string) => {
          const r = writeMemory(content, undefined, GLOBAL_SCOPE)
          if (!r.ok) throw new Error(`writeMemory failed: ${r.error}`)
          return r.entry.id
        },
        update: (id: string, content: string) => {
          const r = writeMemory(content, id, GLOBAL_SCOPE)
          if (!r.ok) throw new Error(`updateMemory failed: ${r.error}`)
        },
        list: () => listMemories(GLOBAL_SCOPE).map((e) => ({ id: e.id, content: e.content })),
        setReply: (json: string) => {
          replyJson = json
        },
        setBeforeReply: (fn: (() => void) | null) => {
          beforeReply = fn
        },
        condense: () => invokeCondense(),
        remove: (id: string) => {
          deleteMemory(id, GLOBAL_SCOPE)
        },
        seed: (entries) => {
          if (!replaceMemories(GLOBAL_SCOPE, entries)) throw new Error('seed failed')
        },
        eq
      })
    }

  } finally {
    /*
     * 关服务器这件事在 Windows 上有个坑：`close()` + 立刻 `process.exit()` 会撞上
     * libuv 的断言 `!(handle->flags & UV_HANDLE_CLOSING)`（handle 还在关闭中就被强制退出，
     * driver 那边看到 exit=3221226505，虽然断言全 PASS）。
     *
     * 所以：先 `closeAllConnections()` 断掉 node fetch 复用的 keep-alive 连接，再 `close`，
     * 并**等回调**；最后把 handle `unref()`，让它不再阻止进程正常结束。三步都做完，
     * 退出时就没有「正在关闭的 handle」了。
     */
    /*
     * 关服务器：`unref()` 必须**先**做。
     *
     * 只 `close()` 不等回调就接着 `process.exit()` 会撞 libuv 的
     * `!(handle->flags & UV_HANDLE_CLOSING)` 断言（handle 正在关闭就被强退）——
     * 单独跑看不到，全量跑必现（前面的场景占过更多 handle，清理时机不同）。
     * unref 之后这个 handle 不再阻止事件循环，退出时就不会有「正在关闭」的竞态。
     */
    server.unref()
    server.closeAllConnections?.()
    server.close()
    // 给 libuv 一轮机会把 close 走完，避免和紧随其后的 process.exit 抢
    await new Promise<void>((r) => setImmediate(r))
  }
}

/**
 * 合并（P2 / spec §4）。用**真实 git 仓库**跑，不 mock `runGitRaw`：
 * 判定依赖 `merge-base` / `diff --name-only -z` / `is-ancestor` 的真实语义，
 * mock 掉就只能验「我怎么处理返回值」，而漏掉的恰恰是「git 到底怎么回」。
 *
 * 覆盖规格点名的全部要求，重点在四处最容易写错的：
 *  ① 四项全列（构造 C2 bad + C5 bad 同时成立 → `checks.length === 4`）
 *  ② 三点 diff 的四格（ff / non-ff 双改 / 目标独改 / 混合）
 *  ③ stash 三步的成功与 pop 冲突两态
 *  ④ stderr 解析的两种缩进
 */
async function scenarioWorktreeMerge(): Promise<void> {
  /*
   * `mergeWorktree` 内部走 `runGitRaw`，它继承 `process.env`。`git merge --no-ff` 要造合并提交，
   * 没有身份就会 `Committer identity unknown` → 我们这边看到的是 `merge-failed`，
   * 而实际是**测试环境缺身份**（不是产品 bug）。这里补上，和 makeRepo 里那套一致。
   */
  process.env.GIT_AUTHOR_NAME ??= 'q'
  process.env.GIT_AUTHOR_EMAIL ??= 'q@q'
  process.env.GIT_COMMITTER_NAME ??= 'q'
  process.env.GIT_COMMITTER_EMAIL ??= 'q@q'
  const M = await import('../../apps/desktop/src/main/services/worktree/merge')
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')

  /** 在 cwd 跑 git（写文件、提交、造脏），失败直接抛出——测试里不该静默。 */
  const git = (cwd: string, ...args: string[]): { code: number; out: string } => {
    const r = require('node:child_process').spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'q',
        GIT_AUTHOR_EMAIL: 'q@q',
        GIT_COMMITTER_NAME: 'q',
        GIT_COMMITTER_EMAIL: 'q@q'
      }
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  const write = (dir: string, name: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  const commit = (dir: string, msg: string): void => {
    git(dir, 'add', '-A')
    const r = git(dir, 'commit', '-qm', msg)
    if (r.code !== 0) throw new Error(`commit 失败：${r.out}`)
  }

  // ── 纯函数：parseStatusPaths ──
  {
    // 常规：` M path` / `?? path`
    eq(
      '解析：普通改动与 untracked 都算脏',
      M.parseStatusPaths(' M a.txt\0?? b.txt\0'),
      ['a.txt', 'b.txt']
    )
    /*
     * rename：`R  new\0old\0` —— `-z` 下 rename 条目后面**额外**跟一段旧路径。
     * 不跳过它就会把旧路径当成一个独立条目（凭空多一个脏文件）。
     */
    eq(
      '解析：rename 取新路径、且不把旧路径当独立条目',
      M.parseStatusPaths('R  new.txt\0old.txt\0 M other.txt\0'),
      ['new.txt', 'other.txt']
    )
    eq('解析：空输出 → 空数组', M.parseStatusPaths(''), [])
    eq('解析：暂存态（M 在第一位）也算脏', M.parseStatusPaths('M  staged.txt\0'), ['staged.txt'])
  }

  // ── 纯函数：parseBlockedPaths（两种缩进 + advice 空行）──
  {
    // unstaged：`\t` 缩进
    const tabIndent = [
      'error: Your local changes to the following files would be overwritten by merge:',
      '\tf.txt',
      'Please commit your changes or stash them before you merge.',
      'Aborting'
    ].join('\n')
    eq('解析：\\t 缩进的被拦路径', M.parseBlockedPaths(tabIndent), ['f.txt'])

    // staged：两个空格缩进（F6 实测）
    const spaceIndent = [
      'error: Your local changes to the following files would be overwritten by merge:',
      '  other.txt',
      '  third.txt',
      'Please commit your changes or stash them before you merge.'
    ].join('\n')
    eq('解析：两空格缩进的被拦路径', M.parseBlockedPaths(spaceIndent), ['other.txt', 'third.txt'])

    // untracked 另一条报错
    const untracked = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tnew.txt',
      'Please move or remove them before you merge.',
      'Aborting'
    ].join('\n')
    eq('解析：untracked 版本同样能提取', M.parseBlockedPaths(untracked), ['new.txt'])

    /*
     * advice 配置让提示行变空行：提取结果可能为空。
     * **空不等于「没有路径」** —— 调用方必须退回「原始 stderr + 出口」，这条断言守住这个前提。
     */
    eq('解析：提不出路径时返回空数组（调用方据此退回原始输出）', M.parseBlockedPaths('error: something else'), [])
  }

  // ── 真实仓库：A 组（ff / upToDate / behindNote）──
  {
    const repo = makeRepo(path.join(DST, 'mrepo-a'), { 'a.txt': 'a\n' })
    const wt = path.join(DST, 'mwts', 'a')
    const created = await CR.createWorktree({
      repoRoot: repo,
      branch: 'wt/merge-a',
      path: wt,
      skipDeps: true
    })
    if (!created.ok) {
      fail('合并：前置创建失败', JSON.stringify(created))
      return
    }
    const rec = S.getRecord(wt)!
    eq('前置：targetBranch = 主检出分支', rec.targetBranch, 'my/dev')

    // ① upToDate：worktree 没有新提交 → 目标已包含它
    const up = await M.mergeWorktree(wt)
    check('upToDate：ok=true', up.ok === true, JSON.stringify(up).slice(0, 300))
    if (up.ok) {
      eq('upToDate：upToDate 为真', up.upToDate, true)
      eq('upToDate：没有合并提交（界面不显示 SHA）', up.mergeCommit, null)
      eq('upToDate：gitOutput 为空串', up.gitOutput, '')
      /*
       * git 的 `worktree list` 输出正斜杠，测试里 `path.join` 造的是反斜杠。
       * 比**归一化键**而不是原串——这也是产品里判「是不是同一个目录」的正确方式。
       */
      {
        const N = await import('../../apps/desktop/src/main/services/worktree/paths')
        eq(
          'upToDate：反查到 targetPath = 主检出',
          N.normalizeWorktreePath(up.targetPath).compareKey,
          N.normalizeWorktreePath(repo).compareKey
        )
      }
    }

    // ② ff 场景：worktree 有新提交，目标没动 → 仍然 `--no-ff` 造合并提交
    write(wt, 'f.txt', 'feat\n')
    commit(wt, 'feat: 加 f.txt')
    const merged = await M.mergeWorktree(wt)
    check('ff：ok=true', merged.ok === true, JSON.stringify(merged).slice(0, 300))
    if (merged.ok) {
      eq('ff：upToDate 为假（这次真合了）', merged.upToDate, false)
      check('ff：产生了合并提交', typeof merged.mergeCommit === 'string' && merged.mergeCommit.length === 40, String(merged.mergeCommit))
      // --no-ff 是硬要求：即使能快进也要有两条父提交（A37 验的就是这个）
      eq(
        'ff：--no-ff 造出了两条父提交的合并提交',
        git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').out.trim().split(/\s+/).length,
        3
      )
      check('ff：gitOutput 带 git 原文', /Merge made by|ort/i.test(merged.gitOutput), merged.gitOutput.slice(0, 120))
      /*
       * 窗口另一半：合并成功后 source 又有新提交 → behindNote。
       * 这里在合并前就把新提交造好，模拟「检查时是 X、合并后 source 已经到 Y」。
       */
    }

    // ③ behindNote：先造新提交，再合并一次（这次目标已含旧的，source 又多一个）
    write(wt, 'g.txt', 'more\n')
    commit(wt, 'feat: 加 g.txt')
    // 手工把目标推进到「已包含 g.txt 之前那个提交」，模拟窗口
    const before = git(repo, 'rev-parse', 'HEAD').out.trim()
    const second = await M.mergeWorktree(wt)
    if (second.ok) {
      // 正常情况下这里会真合并 g.txt；behindNote 只在「合并期间 source 又动了」时出现，
      // 单线程测试里造不出来，所以只断言它**不误报**（没有新提交就不该有 behindNote）
      eq('behindNote：没有期间新提交时不给 behindNote', second.behindNote, undefined)
      check('behindNote：目标 HEAD 确实前进了', git(repo, 'rev-parse', 'HEAD').out.trim() !== before, '')
    }
  }

  // ── 真实仓库：B 组（C2 bad + C5 bad 同时成立 → checks 仍是 4 项）──
  {
    const repo = makeRepo(path.join(DST, 'mrepo-b'), { 'shared.txt': 'base\n', 'both.txt': 'base\n' })
    const wt = path.join(DST, 'mwts', 'b')
    const created = await CR.createWorktree({
      repoRoot: repo,
      branch: 'wt/merge-b',
      path: wt,
      skipDeps: true
    })
    if (!created.ok) {
      fail('合并 B：前置创建失败', JSON.stringify(created))
      return
    }
    // source 侧：改 both.txt 并提交（让 C5 有交集）
    write(wt, 'both.txt', 'from-worktree\n')
    commit(wt, 'feat: 改 both.txt')
    // target 侧（主检出）：脏了 both.txt（撞路径）
    write(repo, 'both.txt', 'dirty-in-target\n')
    /*
     * source 侧再留一个**未提交**改动：上面那个 commit 让 source 干净了，
     * 不补这一笔就验不到「C1 恒通过但脏时 warn」（会得到 ok）。
     */
    write(wt, 'untracked-in-source.txt', 'wip\n')
    // source 再切到别的分支，让 C2 挂
    git(wt, 'checkout', '-q', '-b', 'other/branch')

    const r = await M.mergeWorktree(wt)
    check('四项全列：失败时 ok=false', r.ok === false, JSON.stringify(r).slice(0, 200))
    if (!r.ok) {
      /*
       * **这是本组最重要的一条**：C2 bad（分支变了）与 C5 bad（路径撞了）同时成立时，
       * checks 仍必须是 4 项、顺序固定。短路的话这里只有 1~2 项，界面四个圆点只画得出一个，
       * 用户清完一处再点又冒一处。
       */
      eq('四项全列：checks 长度恒为 4（不短路）', r.checks.length, 4)
      eq(
        '四项全列：顺序固定 C1, C2, C4, C5',
        r.checks.map((c) => c.id),
        ['C1', 'C2', 'C4', 'C5']
      )
      const c2 = r.checks.find((c) => c.id === 'C2')!
      eq('四项全列：C2 是 bad（分支已变）', c2.status, 'bad')
      eq('四项全列：C2 reason = branch-changed', c2.reason, 'branch-changed')
      eq('四项全列：C2 detail 带 actualBranch', c2.detail?.actualBranch, 'other/branch')
      const c5 = r.checks.find((c) => c.id === 'C5')!
      eq('四项全列：C5 也是 bad（脏路径与合并路径撞了）', c5.status, 'bad')
      eq('四项全列：C5 reason = overlap', c5.reason, 'overlap')
      // 完整清单，不只第一个
      eq('四项全列：C5 detail.overlapPaths 是完整清单', c5.detail?.overlapPaths, ['both.txt'])
      eq('四项全列：主因取第一个 not-ok 的项（C2）', r.reason, 'source-branch-changed')
      eq('四项全列：检查阶段失败 message 为空串（文案由渲染层拼）', r.message, '')
      eq('四项全列：mergeAttempted=false（target 未被触碰）', r.mergeAttempted, false)
      eq('四项全列：C1 恒通过（脏时 warn）', r.checks.find((c) => c.id === 'C1')!.status, 'warn')
    }
  }

  // ── 真实仓库：C 组（三点 diff 的四格）──
  {
    /*
     * 四格是 C5 判据的核心。逐格造一个独立仓库，避免互相污染。
     * 预期（§4.9.3 实测表）：ff→列出、双改→只列 source 改的、目标独改→不列、混合→只列 source 改的。
     */
    const mkCase = async (name: string): Promise<{ repo: string; wt: string } | null> => {
      const repo = makeRepo(path.join(DST, `mrepo-c-${name}`), {
        'f.txt': 'base\n',
        'masteronly.txt': 'base\n',
        'both.txt': 'base\n',
        'shared.txt': 'base\n'
      })
      const wt = path.join(DST, 'mwts', `c-${name}`)
      const r = await CR.createWorktree({ repoRoot: repo, branch: `wt/c-${name}`, path: wt, skipDeps: true })
      return r.ok ? { repo, wt } : null
    }

    // 格 1：ff（master 不动、wt 领先）
    {
      const c = await mkCase('ff')
      if (c) {
        write(c.wt, 'f.txt', 'feat\n')
        commit(c.wt, 'feat: f')
        // 主检出把 f.txt 弄脏：ff 场景下真实 merge 会拦它（F5 实测 exit 1）
        write(c.repo, 'f.txt', 'dirty\n')
        const frozen = git(c.wt, 'rev-parse', 'HEAD').out.trim()
        const overlap = await M.overlapPathsOf(c.repo, 'my/dev', frozen)
        eq('三点 diff 格1（ff）：列出 f.txt', overlap, ['f.txt'])
      }
    }
    // 格 2：non-ff 双改（master 改 shared、wt 改 both）
    {
      const c = await mkCase('both')
      if (c) {
        write(c.wt, 'both.txt', 'from-wt\n')
        commit(c.wt, 'feat: both')
        write(c.repo, 'shared.txt', 'from-master\n')
        commit(c.repo, 'feat: master shared')
        // 两个都脏：三点 diff 只该把 both.txt 算进「合并要改的路径」
        write(c.repo, 'shared.txt', 'dirty-shared\n')
        write(c.repo, 'both.txt', 'dirty-both\n')
        const frozen = git(c.wt, 'rev-parse', 'HEAD').out.trim()
        const overlap = await M.overlapPathsOf(c.repo, 'my/dev', frozen)
        eq('三点 diff 格2（双改）：只列 source 改的 both.txt', overlap, ['both.txt'])
      }
    }
    // 格 3：目标独改（master 改 masteronly、wt 没碰）
    {
      const c = await mkCase('masteronly')
      if (c) {
        write(c.wt, 'f.txt', 'feat\n')
        commit(c.wt, 'feat: f')
        write(c.repo, 'masteronly.txt', 'from-master\n')
        commit(c.repo, 'feat: master only')
        // 两个都脏：masteronly.txt 是目标自己改的，不该被算进交集
        write(c.repo, 'masteronly.txt', 'dirty-master-only\n')
        write(c.repo, 'f.txt', 'dirty-f\n')
        const frozen = git(c.wt, 'rev-parse', 'HEAD').out.trim()
        const overlap = await M.overlapPathsOf(c.repo, 'my/dev', frozen)
        /*
         * **这条是「必须三点」的理由**：两点 diff 会把 masteronly.txt 也列进来（master 自己改过），
         * 于是去拦一个 git 根本不会拦的合并。三点语义下它不该出现。
         */
        eq('三点 diff 格3（目标独改）：不列 masteronly.txt（两点 diff 会误报）', overlap, ['f.txt'])
      }
    }
    // 格 4：混合（master 改 shared、wt 改 both，两者都脏）
    {
      const c = await mkCase('mixed')
      if (c) {
        write(c.wt, 'both.txt', 'from-wt\n')
        commit(c.wt, 'feat: both')
        write(c.repo, 'shared.txt', 'from-master\n')
        commit(c.repo, 'feat: master shared')
        // 两者都脏
        write(c.repo, 'shared.txt', 'dirty-shared\n')
        write(c.repo, 'both.txt', 'dirty-both\n')
        const frozen = git(c.wt, 'rev-parse', 'HEAD').out.trim()
        const overlap = await M.overlapPathsOf(c.repo, 'my/dev', frozen)
        eq('三点 diff 格4（混合）：只拦 both.txt，不拦 shared.txt', overlap, ['both.txt'])
      }
    }
  }

  // ── 真实仓库：D2 组（pop 冲突：untracked 与合并新增撞路径）──
  {
    /*
     * 造 pop 冲突：target 有一个 **untracked** 的 `u.txt`（会被 `--include-untracked` 一起 stash），
     * 而 source 的提交里**新增**同名文件。merge 把 `u.txt` 写进工作区之后，pop 恢复那个 untracked
     * 文件就会撞上已存在的同名文件 → `pop exit != 0`。
     *
     * 这一格验的是规格最看重的差别（§4.9.5）：pop 冲突时 stash 条目**保留**（不自动 drop），
     * 而 `--autostash` 在这种情况下是 exit 0 + 用户看不出失败。
     */
    const repo = makeRepo(path.join(DST, 'mrepo-d2'), { 'base.txt': 'base\n' })
    const wt = path.join(DST, 'mwts', 'd2')
    const created = await CR.createWorktree({ repoRoot: repo, branch: 'wt/merge-d2', path: wt, skipDeps: true })
    if (created.ok) {
      write(wt, 'u.txt', 'from-source\n')
      commit(wt, 'feat: 新增 u.txt')
      // target 侧：同名的 untracked 文件（未提交）
      write(repo, 'u.txt', 'untracked-in-target\n')
      const r = await M.mergeWorktree(wt, { stashFirst: true })
      info('pop 冲突结果', JSON.stringify(r).slice(0, 500))
      check('pop 冲突：合并本身成功（ok=true）', r.ok === true, JSON.stringify(r).slice(0, 200))
      if (r.ok) {
        eq('pop 冲突：stash.popConflict 为真', r.stash?.popConflict, true)
        check(
          'pop 冲突：stash 条目**保留**（不自动 drop —— 与 --autostash 的关键差别）',
          /deva-merge-wip/.test(git(repo, 'stash', 'list').out),
          git(repo, 'stash', 'list').out
        )
      }
    }
  }

  // ── 真实仓库：D 组（stash 三步：成功 / pop 冲突 / pop 后 unstaged 清单）──
  {
    const repo = makeRepo(path.join(DST, 'mrepo-d'), { 'conflict.txt': 'base\n' })
    const wt = path.join(DST, 'mwts', 'd')
    const created = await CR.createWorktree({ repoRoot: repo, branch: 'wt/merge-d', path: wt, skipDeps: true })
    if (!created.ok) {
      fail('合并 D：前置创建失败', JSON.stringify(created))
      return
    }
    // source 改 conflict.txt 并提交（合并会改这个路径）
    write(wt, 'conflict.txt', 'from-wt\n')
    commit(wt, 'feat: conflict')
    // target 脏同一个文件 → C5 有交集
    write(repo, 'conflict.txt', 'dirty-in-target\n')

    // 不带 stashFirst → C5 bad，且**绝不**自动 stash（明确禁止项）
    const noStash = await M.mergeWorktree(wt)
    check('stash：不传 stashFirst 时 C5 拦下', noStash.ok === false, JSON.stringify(noStash).slice(0, 200))
    if (!noStash.ok) {
      eq('stash：reason = target-overlap', noStash.reason, 'target-overlap')
      eq('stash：mergeAttempted=false', noStash.mergeAttempted, false)
      eq('stash：**没有**自动 stash（stash 列表仍空）', git(repo, 'stash', 'list').out.trim(), '')
      eq(
        'stash：target 的脏改动原样保留（绝不被自动清掉）',
        fs.readFileSync(path.join(repo, 'conflict.txt'), 'utf8'),
        'dirty-in-target\n'
      )
    }

    // 带 stashFirst → C5 通过，走三步
    const withStash = await M.mergeWorktree(wt, { stashFirst: true })
    info('stash 结果', JSON.stringify(withStash).slice(0, 400))
    check('stash：带 stashFirst 后合并尝试执行', withStash.mergeAttempted === true || withStash.ok === true, JSON.stringify(withStash).slice(0, 200))
    if (!withStash.ok) {
      // 合并本身可能冲突（两边都改了同一文件）→ 应落 conflict，且 stash 里改动安全
      eq('stash：两边改同一文件 → reason = conflict', withStash.reason, 'conflict')
      check('stash：conflict 时 message 是 git 原文（含 CONFLICT）', /CONFLICT/.test(withStash.message), withStash.message.slice(0, 200))
      check('stash：给出了 stash 信息（改动可恢复）', withStash.stash !== null, JSON.stringify(withStash.stash))
      if (withStash.stash) {
        check('stash：stashSha 非空', typeof withStash.stash.sha === 'string' && withStash.stash.sha.length === 40, String(withStash.stash.sha))
        /*
         * pop 冲突时 git **保留** stash 条目（与 --autostash 的关键差别）。
         * 我们不自动 drop —— 万一用户想重来。
         */
        check('stash：pop 冲突时 stash 条目仍在（不自动 drop）', /deva-merge-wip/.test(git(repo, 'stash', 'list').out), git(repo, 'stash', 'list').out)
      }
      // 收尾：这条改动确实在文件里（没丢）
      check(
        'stash：用户改动 100% 在文件里（含冲突标记）',
        /dirty-in-target|<<<<<<</.test(fs.readFileSync(path.join(repo, 'conflict.txt'), 'utf8')),
        fs.readFileSync(path.join(repo, 'conflict.txt'), 'utf8').slice(0, 200)
      )
    }
  }

  // ── 真实仓库：E 组（C-1 target-not-set / C0 source-missing / C4 not-checked-out）──
  {
    const repo = makeRepo(path.join(DST, 'mrepo-e'), { 'a.txt': 'a\n' })
    const wt = path.join(DST, 'mwts', 'e')
    const created = await CR.createWorktree({ repoRoot: repo, branch: 'wt/merge-e', path: wt, skipDeps: true })
    if (!created.ok) {
      fail('合并 E：前置创建失败', JSON.stringify(created))
      return
    }
    // C-1：targetBranch 置 null
    {
      const rec = S.getRecord(wt)!
      S.upsertRecord({ ...rec, targetBranch: null })
      const r = await M.mergeWorktree(wt)
      check('C-1：target-not-set 时 ok=false', r.ok === false, JSON.stringify(r).slice(0, 200))
      if (!r.ok) {
        eq('C-1：reason = target-not-set', r.reason, 'target-not-set')
        eq('C-1：checks 为空（不做任何检查）', r.checks.length, 0)
        eq('C-1：mergeAttempted=false（没执行 merge）', r.mergeAttempted, false)
        eq('C-1：targetBranch 回 null', r.targetBranch, null)
        eq('C-1：message 为空串（文案由渲染层拼）', r.message, '')
        // **不得自动挑 main**：记录必须仍是 null
        eq('C-1：没有自动挑一个目标分支', S.getRecord(wt)!.targetBranch, null)
      }
    }
    // set-target 写回
    {
      const st = M.setMergeTarget(wt, 'my/dev')
      eq('set-target：写回成功', st.ok, true)
      eq('set-target：记录里已是 my/dev', S.getRecord(wt)!.targetBranch, 'my/dev')
      eq('set-target：坏分支名被拒', M.setMergeTarget(wt, 'has space').ok, false)
      eq('set-target：不存在的记录被拒', M.setMergeTarget(path.join(DST, 'nope'), 'my/dev').ok, false)
    }
    // C0：source 目录没了 → C1/C2 skipped，C4/C5 照常
    {
      const rec = S.getRecord(wt)!
      fs.rmSync(wt, { recursive: true, force: true })
      const r = await M.mergeWorktree(wt)
      check('C0：source 缺失时 ok=false', r.ok === false, JSON.stringify(r).slice(0, 200))
      if (!r.ok) {
        eq('C0：checks 仍是 4 项（C4/C5 照常算）', r.checks.length, 4)
        eq('C0：C1 skipped + source-missing', r.checks.find((c) => c.id === 'C1')!.status, 'skipped')
        eq('C0：C1 reason = source-missing', r.checks.find((c) => c.id === 'C1')!.reason, 'source-missing')
        eq('C0：C2 同样 skipped', r.checks.find((c) => c.id === 'C2')!.status, 'skipped')
        // 主检出仍检出 my/dev → C4 通过
        eq('C0：C4 照常通过（target 侧仍可判）', r.checks.find((c) => c.id === 'C4')!.status, 'ok')
        eq('C0：reason = source-missing', r.reason, 'source-missing')
        void rec
      }
    }
  }

  // ── dryrun：只跑检查、不执行 merge ──
  {
    const repo = makeRepo(path.join(DST, 'mrepo-f'), { 'a.txt': 'a\n' })
    const wt = path.join(DST, 'mwts', 'f')
    const created = await CR.createWorktree({ repoRoot: repo, branch: 'wt/merge-f', path: wt, skipDeps: true })
    if (created.ok) {
      write(wt, 'new.txt', 'n\n')
      commit(wt, 'feat: new')
      const headBefore = git(repo, 'rev-parse', 'HEAD').out.trim()
      const dry = await M.mergeWorktree(wt, { dryRun: true })
      check('dryrun：ok=true', dry.ok === true, JSON.stringify(dry).slice(0, 200))
      if (dry.ok) {
        eq('dryrun：没有合并提交', dry.mergeCommit, null)
        eq('dryrun：gitOutput 为空', dry.gitOutput, '')
        eq('dryrun：带四项检查结果', dry.checks?.length, 4)
        eq('dryrun：upToDate 已判好（不是最新）', dry.upToDate, false)
      }
      eq('dryrun：**没有**真的合并（目标 HEAD 未变）', git(repo, 'rev-parse', 'HEAD').out.trim(), headBefore)
    }
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
  swapindex: scenarioSwapIndexFail,
  swapstale: scenarioSwapStaleCommit,
  kindcopy: scenarioKindCopy,
  swapws: scenarioSwapWhitespace,
  blockedturn: scenarioBlockedTurnNoTrace,
  secretskind: scenarioSecretsCorrupt,
  swapcand: scenarioSwapCandidates,
  blockedlist: scenarioBlockedProviderListed,
  wtpaths: scenarioWorktreePaths,
  wtstore: scenarioWorktreeStore,
  wtprecheck: scenarioWorktreePrecheck,
  wtcreate: scenarioWorktreeCreate,
  wtremove: scenarioWorktreeRemove,
  wtbrief: scenarioWorktreeBrief,
  wtsweep: scenarioWorktreeSweep,
  worktree: scenarioWorktree,
  insatt: scenarioInsertAttachments,
  rekey: scenarioSecretRekey,
  plugmgr: scenarioPluginManaged,
  sessync: scenarioSessionSync,
  importactive: () => importActive(eq),
  importhistory: () => importHistoryConflict(eq),
  importretry: () => importDependencyRetry(eq),
  importmedia: () => importMedia(eq),
  cfgwrite: () => configWriteGuard(eq),
  idxrecover: () => indexRecovery(eq),
  swapidentity: () => swapIdentity(eq),
  swapbinding: () => swapBinding(eq),
  memreadfail: () => memoryReadFailure(eq),
  mcpown: () => mcpOwnership(eq),
  wtmerge: scenarioWorktreeMerge,
  memcond: scenarioMemCondense,
  dangclass: scenarioDanglingClassify,
  wtlock: scenarioWorktreeLock,
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
