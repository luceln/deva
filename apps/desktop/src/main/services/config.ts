import { app, ipcMain, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './atomic-write'
import type { ConfigChangedEvent } from '../../shared/config-protocol'

/**
 * 应用配置存储（主进程）。
 * 非敏感的用户配置（主题 / 语言 / 服务商与模型 / 默认模型等）以**明文 JSON** 存于
 * `~/.deva-plus/config.json`，开发者可手改 / 备份 / 版本化（对标 ~/.claude）。
 * 根目录可用环境变量 `DEVA_HOME` 覆盖（便携安装 / 测试 / CI）。
 * **敏感信息（API 密钥）绝不进此文件**——见 services/secrets.ts（safeStorage 加密的 secrets.json）。
 * 详见 docs/architecture/security.md。
 */

let home = ''

/**
 * DevaPlus 配置根目录：DEVA_HOME 覆盖，否则 ~/.deva-plus。首次调用即确保目录存在。
 *
 * 目录名与上游的 ~/.deva 分开（DevaPlus 与 Deva 要能同时运行）：共用同一个目录会让两个独立进程同时写
 * config.json / _index.json，彼此覆盖，且没有锁拦着——比"跑 dev 看了眼数据"严重得多。
 * 不跟随 productName / app name 走，是刻意的：DEVA_HOME 与这里都是用户可预期的固定路径（文档、脚本、备份都引用它）。
 * 也不从 ~/.deva 搬任何东西过来：新装的 DevaPlus 就是全新安装的样子（预置服务商连接信息、零模型、零密钥），
 * 用户自己配置；把上游的用户资产搬过来属于"与上游同步"，是独立的功能，不该藏在启动路径里。
 */
export function getDevaHome(): string {
  if (home) return home
  const override = process.env.DEVA_HOME?.trim()
  home = override && override.length > 0 ? override : join(app.getPath('home'), '.deva-plus')
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 目录创建失败：后续读写各自兜底，不阻断启动 */
  }
  return home
}

function configPath(): string {
  return join(getDevaHome(), 'config.json')
}

let config: Record<string, unknown> = {}
let loaded = false

/** 同步载入（配置很小；同步读简化了首帧同步 IPC）。 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>
  } catch {
    // 首次运行 / 文件不存在 / 解析失败 —— 视为空配置
    config = {}
  }
  loaded = true
}

function persist(): void {
  try {
    // 原子写：写到一半崩溃不会留下半截 JSON——那样下次启动解析失败即回落空配置，服务商与模型全丢。
    writeFileAtomic(configPath(), JSON.stringify(config, null, 2))
  } catch {
    /* 持久化失败静默：不影响本次会话的内存态 */
  }
}

/**
 * 主进程内读取整份配置（只读快照）。
 * 供其它服务在进程内复用（如 git.ts 读 `git.path` 覆盖），避免各自重复读文件。
 */
export function getConfig(): Record<string, unknown> {
  ensureLoaded()
  return config
}

/**
 * 主进程内写配置（顶层浅合并，值为 undefined 时删除该键），并落盘。
 * 供 skills.ts / personas.ts 等服务在进程内维护启用态（config.json 内的 skills/personas 段），
 * 与渲染层的 `config:set` IPC 走同一份内存态 + 持久化路径。
 *
 * ⚠️ **这里刻意不广播 config:changed**。渲染层 `store/models.tsx` 有「providers 一变就 config:set」的回写 effect，
 * 若每次写盘都广播，就会形成「广播 → 渲染层重载 → 回写 → 广播」的刷新循环（打字卡顿、磁盘狂写）。
 * 需要通知渲染层的场景只有「外部批量改动」（导入），由调用方在改完后显式调 `publishConfigChanged`。
 */
export function setConfig(patch: Record<string, unknown>): void {
  ensureLoaded()
  if (!patch || typeof patch !== 'object') return
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete config[k]
    else config[k] = v
  }
  persist()
}

/* ───────────── 配置变更广播 ───────────── */

type ConfigChangedListener = (p: ConfigChangedEvent) => void
const changedListeners = new Set<ConfigChangedListener>()

/**
 * 通知渲染层「配置被外部改动了」，由 registerConfigIpc 订阅后转发成 `config:changed`。
 * 订阅者回调里抛错不能打断发布方（导入正在收尾），故逐个 try/catch 隔离。
 */
export function publishConfigChanged(p: ConfigChangedEvent): void {
  for (const l of changedListeners) {
    try {
      l(p)
    } catch (e) {
      console.warn('[config] config:changed 订阅者异常：', (e as Error)?.message ?? e)
    }
  }
}

export function onConfigChanged(listener: ConfigChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

export function registerConfigIpc(getWindow: () => BrowserWindow | null): void {
  ensureLoaded()

  // 外部批量改动（导入）后转发给渲染层：渲染层据此重载模型/角色列表，不必重启或切页。
  // 只由显式 publishConfigChanged 触发；config:set 回写不广播，故不会自激（见 setConfig 的说明）。
  onConfigChanged((p) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('config:changed', p)
  })

  // 同步读取整份配置：供渲染层首帧读取主题/语言，避免闪烁（FOUC）。
  ipcMain.on('config:get-sync', (evt) => {
    ensureLoaded()
    evt.returnValue = config
  })

  // 异步读取整份配置。
  ipcMain.handle('config:get', () => {
    ensureLoaded()
    return config
  })

  // 顶层浅合并补丁：值为 undefined 时删除该键。
  ipcMain.handle('config:set', (_e, patch: Record<string, unknown>) => {
    setConfig(patch)
    return { ok: true as const }
  })
}
