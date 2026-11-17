import { app } from 'electron'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
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
 * ⚠️ 判「在运行」不能用「lockfile 是否存在」。Chromium 的 ProcessSingleton 用 `FILE_FLAG_DELETE_ON_CLOSE` 创建它
 * （`process_singleton_win.cc`）：**正常退出会删，只有崩溃/强杀才残留**。所以「文件在」既不能证明正在运行
 * （崩溃残留），也不能证明没运行（刚启动、还没建）；「文件不在」同样两可。mtime 也不行（不随运行刷新）。
 * 可靠判据只有**独占打开**：被持有者打开时 `open('r+')` 返回 EBUSY，没人持有则能打开。
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

/** 独占打开 lockfile 的三个结果：没运行 / 正在运行 / 探测不了（权限原因）。 */
type ProbeResult = 'free' | 'running' | 'unknown-perm'

/**
 * 试着独占打开 lockfile。
 *
 * 文件不存在 → free（从没启动过，或正常退出时已删）。
 * EBUSY / EACCES / 其它共享冲突 → running（被某个进程持有）。
 * EPERM（例如 lockfile 被设成只读）→ **unknown-perm**：我们查不出状态，但这不是「在运行」的证据。
 *
 * ⚠️ 以前把 EPERM 也笼统当成 running，结果用户会**永远**看到「原版 Deva 正在运行」——怎么退出都没用，
 * 而文案只给了这一种可能，用户对着一个查不出原因的提示干瞪眼。判据仍是 fail-closed（拿不到确定结论就不放行），
 * 但文案必须把「无法检测（权限不足）」和「确实在运行」分开。
 */
function probeLock(path: string): ProbeResult {
  if (!existsSync(path)) return 'free'
  try {
    const fd = openSync(path, 'r+')
    closeSync(fd) // 只测能不能独占打开，不留句柄
    return 'free'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // EPERM = 权限不足（只读属性 / ACL），EACCES 同属权限问题；其余（EBUSY 等）按「被持有」处理
    return code === 'EPERM' || code === 'EACCES' ? 'unknown-perm' : 'running'
  }
}

/** 把探测结果翻成闸门失败原因；free 返回 null。 */
function heldReason(): { code: 'source-running' | 'source-unreadable'; message: string } | null {
  const r = probeLock(upstreamLockPath())
  if (r === 'free') return null
  if (r === 'unknown-perm') {
    return {
      code: 'source-unreadable',
      message: isEn()
        ? `Cannot check whether Deva is running (permission denied on its lockfile). Check the file's permissions, then retry.`
        : '无法检测原版 Deva 是否正在运行（锁文件权限不足）。请检查该文件的权限后重试。'
    }
  }
  return {
    code: 'source-running',
    message: isEn() ? 'Deva is running. Quit it first, then import.' : '原版 Deva 正在运行，请先退出它再导入。'
  }
}

/**
 * 数目录下的条目数。**读不出来返回 `null`**（不是 0）。
 *
 * ⚠️ 以前 `catch { return 0 }`：源目录被同名文件占住 / ACL 改坏 / 被杀毒锁住时，概览显示
 * 「0 个会话」——与「原版本来就是空的」完全一样。验收实测：`sessions` 从 34 变 0 而 `canImport()`
 * 仍返回 `ok:true`，按钮照常可点，用户会导入一份残缺数据。0 是**一个数字**，null 才表示「不知道」。
 * ENOENT 才是真的「没有」，返回 0。
 */
function countEntries(dir: string, filter?: (name: string, isDir: boolean) => boolean): number | null {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) =>
      filter ? filter(d.name, d.isDirectory()) : true
    ).length
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
  }
}

/** 读原版的某个 JSON 并数出里面的一项。
 *
 * 三态：
 *  - ENOENT → 0（原版没配过，正常）；
 *  - **读不出来**（EACCES/EBUSY）→ `null`（不知道，闸门要拦）；
 *  - **读到了但解析失败**（内容坏）→ 0 且**不算闸门失败**：坏内容导入器自己能跳过并逐条上报
 *    （`source-config-corrupt` / `source-memory-corrupt`），那不是「读不出来」，
 *    拦掉整个导入反而让用户连其他能导的数据都拿不到。
 */
function countInJson(
  srcHome: string,
  file: string,
  pick: (cfg: Record<string, unknown>) => number
): number | null {
  let raw: string
  try {
    raw = readFileSync(join(srcHome, file), 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
  }
  try {
    return pick(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return 0 // 内容坏：不是「读不出来」，交给导入器逐条上报
  }
}

/**
 * 原版数据概况：给界面在按钮旁展示「将导入什么」，也用于空态提示。
 *
 * 返回 `{ summary, unreadable }`：`unreadable` 非空表示**至少有一项读不出来**，此时概览里的 0
 * 不可信（它可能是「读不到」而不是「没有」）。`canImport` 据此拒绝放行——理由写在那里。
 */
function summarize(srcHome: string): { summary: SourceSummary; unreadable: string[] } {
  const chats = join(srcHome, 'data', 'chats')
  let sessions = 0
  let compacted = 0
  let memberSessions = 0
  const unreadable: string[] = []
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
        /* 单个会话文件读不出来：它已计入 sessions，不必让整份概览失效 */
      }
    }
  } catch (e) {
    // 整个目录读不出来：sessions 记 0 是**假的**，必须挂进 unreadable
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push('data/chats')
  }

  const num = (label: string, v: number | null): number => {
    if (v === null) {
      unreadable.push(label)
      return 0
    }
    return v
  }
  const summary: SourceSummary = {
    sessions,
    compacted,
    memberSessions,
    providers: num('config.json', countInJson(srcHome, 'config.json', (cfg) => {
      const models = cfg.models as { providers?: unknown } | undefined
      return Array.isArray(models?.providers) ? models.providers.length : 0
    })),
    personas: num('personas', countEntries(join(srcHome, 'personas'), (n) => n.endsWith('.md'))),
    memories: num('memory.json', countInJson(srcHome, 'memory.json', (cfg) => {
      const entries = cfg.entries
      return Array.isArray(entries) ? entries.length : 0
    })),
    skills: num('skills', countEntries(join(srcHome, 'skills'))),
    media: num('data/media', countEntries(join(srcHome, 'data', 'media'))),
    checkpoints: num('data/checkpoints', countEntries(join(srcHome, 'data', 'checkpoints'), (_n, isDir) => isDir)),
    subagents: num('data/subagents', countEntries(join(srcHome, 'data', 'subagents'), (_n, isDir) => isDir)),
    toolResults: num('data/tool-results', countEntries(join(srcHome, 'data', 'tool-results'))),
    /*
     * 项目记忆目录也要数：它读不出来时「所有项目」的记忆都导不进来（爆炸半径最大的一处），
     * 若不进 summarized，闸门就看不到它，用户会拿到一份只有全局记忆的报告。
     */
    projects: num('projects', countEntries(join(srcHome, 'projects'), (_n, isDir) => isDir))
  }
  return { summary, unreadable }
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

  /**
   * 最后一道保险：目标目录不能与原版目录重合（相等或互相包含）。
   *
   * `getDevaHome()` 直接返回 `DEVA_HOME`，而它是用户可以随手设的环境变量（便携安装 / 脚本 / CI）。实测把它指成
   * `~/.deva` 时，导入器会删掉**原版**的 `data/chats/_index.json`（invalidateIndex），并把 `import.lock` 写进原版
   * ——数据不丢（索引会自愈），但「原版全程只读，一个字节都不改」这个硬承诺就破了。这种错配置代价极低就能拦，
   * 而且一旦发生是无声的（用户不会知道自己在动原版），所以在闸门里直接拒。
   *
   * 用 resolve 归一化再比，避免 `E:\x\.deva` 与 `E:\x\.deva\` 这类写法差异漏判。
   *
   * ⚠️ **大小写归一化只在该平台文件系统大小写不敏感时才做**（Windows / macOS 默认如此）。以前无条件
   * `toLowerCase()`，Linux 上会把 `/home/u/Data` 与 `/home/u/data` 当成同一个目录——**误拦**（fail-closed，
   * 方向安全但会挡住正当操作）。判据与 `projectMemoryKey` 里那条一致，两处不应各说各话。
   */
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (p: string): string => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p))
  const sameOrNested = (() => {
    const a = norm(getDevaHome())
    const b = norm(sourceHome)
    if (a === b) return true
    const sep = process.platform === 'win32' ? '\\' : '/'
    return a.startsWith(b + sep) || b.startsWith(a + sep)
  })()
  if (sameOrNested) {
    return {
      ok: false,
      code: 'same-home',
      importing,
      message: isEn()
        ? `Target data folder overlaps the upstream one (${getDevaHome()}). Point DEVA_HOME elsewhere — the upstream folder must stay untouched.`
        : `目标数据目录与原版目录重合（${getDevaHome()}）：DEVA_HOME 请指向别处。导入绝不允许改动原版。`
    }
  }

  /**
   * 源目录「不在」与「读不出来」必须分开报：都是 fail-closed（不放行），但用户处置完全不同——
   * 前者是「你是不是没装原版 / 没设过数据」，后者是「目录在，但你打不开它（权限 / 被你自己的策略挡住）」。
   * 以前只判 `existsSync` 假就报 `no-source`，于是 ACL 被改坏的用户会被告知「没找到原版数据目录」，
   * 按那个提示他会去翻安装路径，永远修不好。
   */
  let srcStat
  try {
    srcStat = statSync(sourceHome)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    const missing = code === 'ENOENT'
    return {
      ok: false,
      code: missing ? 'no-source' : 'source-unreadable',
      importing,
      message: missing
        ? isEn()
          ? `Upstream data folder not found (${sourceHome})`
          : `未找到原版数据目录（${sourceHome}）`
        : isEn()
          ? `Upstream data folder exists but can’t be read (${sourceHome}): check its permissions`
          : `原版数据目录存在但读不出来（${sourceHome}）：请检查目录权限`
    }
  }
  if (!srcStat.isDirectory()) {
    return {
      ok: false,
      code: 'no-source',
      importing,
      message: isEn()
        ? `Upstream data path is not a folder (${sourceHome})`
        : `原版数据路径不是一个目录（${sourceHome}）`
    }
  }
  const held = heldReason()
  if (held) {
    return { ok: false, code: held.code, importing, message: held.message }
  }
  /**
   * 概况读不出来 → **fail closed（拒绝放行）**。
   *
   * 为什么这算硬拦截而不是「给个不精确的概览就行」：概览里的 0 与「原版本来就是空的」无法区分，
   * 用户看到「原版有 16 个服务商、391 个媒体，但 0 个会话」时，最可能的判断是「原版确实没有会话」，
   * 于是照常点导入——而这是一次性导入，缺的那块永远缺。拦下来并说明哪几项读不出来，
   * 用户才能去查权限 / 关掉占用它的程序。
   *
   * 与 `source-unreadable` 分开一个新码：那条讲的是源目录本身打不开（闸门连 stat 都失败），
   * 这条是目录能 stat、但其中**某些项**读不出来。界面按 code 分支，两者提示不同。
   */
  const { summary, unreadable } = summarize(sourceHome)
  if (unreadable.length) {
    return {
      ok: false,
      code: 'source-partially-unreadable',
      importing,
      message: isEn()
        ? `Some upstream data can’t be read (${unreadable.join(', ')}). Fix permissions or close the app using it, then retry — importing now would silently skip that data.`
        : `原版的这部分数据读不出来（${unreadable.join('、')}）：请检查权限或关掉占用它的程序后重试；现在导入会静默丢掉这部分。`
    }
  }
  return { ok: true, sourceHome, importing, summary }
}
