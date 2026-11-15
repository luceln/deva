import { app } from 'electron'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { isEn } from './locale'
import { getDevaHome } from './services/config'
import { isImporting } from './importer-lock'
import type { GateResult, SourceSummary } from '../shared/import-protocol'

/**
 * 导入闸门：原版正在运行时不许导入。
 *
 * 为什么必须拦：原版保存会话是**全量重写** JSON（chat-store.ts 的 save），这一刻读到的可能是半截文件；media blob
 * 也可能正在写。导入器本身只读、不会破坏原版，但会把坏数据搬进 DevaPlus。所以宁可让用户先退出原版。
 *
 * ⚠️ 判「在运行」不能用「lockfile 是否存在」——Electron 退出时**不删**这个文件，DevaPlus 自己没运行时
 * `%APPDATA%\devaplus\lockfile` 照样在。mtime 也不行（不随运行刷新，停在与启动时刻）。可靠判据是**独占打开**：
 * 被进程持有的文件在 Windows 上 open('r+') 返回 EBUSY，没人持有则能打开。三组实测对照：原版运行中 EBUSY、
 * DevaPlus dev 运行中 EBUSY、手工造的陈旧 lockfile 可打开。
 *
 * 探测全程只读：打开后立即关闭，不写、不删、不改名。原版路径只在主进程内部拼，渲染层永远拿不到可写句柄。
 */

/** 原版 Deva 的数据目录：恒为 `~/.deva`（不受 DEVA_HOME 影响——那是**本应用**的覆盖变量）。 */
export function upstreamHome(): string {
  return join(homedir(), '.deva')
}

/**
 * 原版 Electron 的单实例锁路径：`%APPDATA%/<userData 目录名>/lockfile`。
 *
 * 目录名由**上游 package.json 的 name** 派生（`@deva/desktop` → `@deva/desktop`），不是 productName——
 * 上游从未改过这个名字，所以它是稳定的。用 app.getPath('appData') 拼，别硬编码盘符
 * （macOS 是 ~/Library/Application Support）。
 */
function upstreamLockPath(): string {
  return join(app.getPath('appData'), '@deva', 'desktop', 'lockfile')
}

/**
 * 该文件是否被某个进程独占持有（= 那个应用正在运行）。
 *
 * 文件不存在 → 没运行（从没启动过）。其余任何打不开的情形（EBUSY / EACCES / EPERM）**一律当在运行**：宁可误拦
 * 让用户退出原版重试，也不要放着可能写了一半的会话文件被读进来。
 */
function isHeldExclusively(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const fd = openSync(path, 'r+')
    closeSync(fd) // 只测能不能独占打开，不留句柄
    return false
  } catch {
    return true
  }
}

/** 数目录下的条目数（不存在 / 不可读 → 0）。 */
function countEntries(dir: string, filter?: (name: string, isDir: boolean) => boolean): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) =>
      filter ? filter(d.name, d.isDirectory()) : true
    ).length
  } catch {
    return 0
  }
}

/** 读原版的某个 JSON 并数出里面的一项；读不到记 0。 */
function countInJson(srcHome: string, file: string, pick: (cfg: Record<string, unknown>) => number): number {
  try {
    return pick(JSON.parse(readFileSync(join(srcHome, file), 'utf8')) as Record<string, unknown>)
  } catch {
    return 0
  }
}

/**
 * 原版数据概况：给界面在按钮旁展示「将导入什么」，也用于空态提示。
 * 只数目录条目、只解析必要文件；任何一项读不到都记 0，绝不抛错——概览不该阻断导入。
 */
function summarize(srcHome: string): SourceSummary {
  const chats = join(srcHome, 'data', 'chats')
  let sessions = 0
  let compacted = 0
  let memberSessions = 0
  try {
    for (const d of readdirSync(chats, { withFileTypes: true })) {
      if (!d.isFile()) continue
      // 拆分存盘的较早记录：<id>.compacted-<ts>.jsonl
      if (d.name.endsWith('.jsonl') && d.name.includes('.compacted-')) compacted++
      if (!d.name.endsWith('.json') || d.name === '_index.json') continue
      sessions++
      try {
        const s = JSON.parse(readFileSync(join(chats, d.name), 'utf8')) as { parentId?: unknown }
        if (typeof s?.parentId === 'string' && s.parentId) memberSessions++
      } catch {
        /* 坏文件不计入成员会话 */
      }
    }
  } catch {
    /* 没有对话目录 */
  }
  return {
    sessions,
    compacted,
    memberSessions,
    providers: countInJson(srcHome, 'config.json', (cfg) => {
      const models = cfg.models as { providers?: unknown } | undefined
      return Array.isArray(models?.providers) ? models.providers.length : 0
    }),
    personas: countEntries(join(srcHome, 'personas'), (n) => n.endsWith('.md')),
    memories: countInJson(srcHome, 'memory.json', (cfg) => {
      const entries = cfg.entries
      return Array.isArray(entries) ? entries.length : 0
    }),
    skills: countEntries(join(srcHome, 'skills')),
    media: countEntries(join(srcHome, 'data', 'media')),
    checkpoints: countEntries(join(srcHome, 'data', 'checkpoints'), (_n, isDir) => isDir),
    subagents: countEntries(join(srcHome, 'data', 'subagents'), (_n, isDir) => isDir),
    toolResults: countEntries(join(srcHome, 'data', 'tool-results'))
  }
}

/**
 * 能不能导入。两处都要调：`import:probe`（按钮置灰用）与 `import:run` 开头
 * （防「探测之后用户又把原版打开了」——这两次之间用户完全可能去开了原版）。
 *
 * 顺带给出 `importing`（本应用这一侧是否已有一轮在跑）：界面需要它把按钮置灰，但它与闸门是两件事——
 * 混进 ok 会让「原版在跑」和「自己正在导」变成同一个状态，界面也就没法给出不同的提示。
 * 这里的判活走 isLockLive（残留锁视为不在导入），否则崩溃一次就会永久灰按钮。
 */
export async function canImport(): Promise<GateResult> {
  const importing = isImporting(getDevaHome())
  const sourceHome = upstreamHome()
  if (!existsSync(sourceHome)) {
    return {
      ok: false,
      code: 'no-source',
      importing,
      message: isEn() ? `Upstream data folder not found (${sourceHome})` : `未找到原版数据目录（${sourceHome}）`
    }
  }
  if (isHeldExclusively(upstreamLockPath())) {
    return {
      ok: false,
      code: 'source-running',
      importing,
      message: isEn()
        ? 'Deva is running. Quit it first, then import.'
        : '原版 Deva 正在运行，请先退出它再导入。'
    }
  }
  return { ok: true, sourceHome, importing, summary: summarize(sourceHome) }
}

/** 只判原版是否在运行（importer 开头用，不必再算一次概况）。 */
export function isUpstreamRunning(): boolean {
  return isHeldExclusively(upstreamLockPath())
}

/** 存在且是目录。导入器各步的前置判断，统一走这里省得各写一份 try。 */
export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
