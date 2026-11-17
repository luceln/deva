/**
 * 配置变更广播（主进程 → 渲染层）的共享类型。
 *
 * 为什么需要它：渲染层有多个 store 只在挂载时读一次 `config.get()`（`store/models.tsx` 就是），主进程内的改动
 * （如「从原版导入」一次性并入服务商）改的是磁盘与主进程内存态，渲染层完全不知道——用户看到的是「导完了，
 * 模型列表还是空的，得重启或切页」。角色之所以看起来会刷新，纯属设置页进入时重拉一次的巧合，不是通知。
 *
 * ⚠️ 广播**只在「外部批量改动」时显式发**（导入这类），不在 `setConfig` 内部无条件发：渲染层的 models store
 * 有回写 effect（providers 一变就 `config:set`），无条件广播会形成「广播 → 重载 → 回写 → 广播」的刷新循环。
 */
export interface ConfigChangedEvent {
  /** 变了哪些顶层键（'models' / 'personas' …）。渲染层据此只重载自己关心的部分，避免无谓刷新。 */
  keys: string[]
  /** 变更来源。'import' = 从原版 Deva 导入这种外部批量改动；'external' = 其它主进程内部改动。 */
  source: 'import' | 'external'
}

/**
 * `config:set` 的返回。
 *
 * ⚠️ **`queued: true` 时 `ok` 是 true，但东西还在队列里、没落盘**——不能拿 `ok` 当「已经在磁盘上」。
 * 导入期间渲染层的回写全部走这条路（写入被暂存到收尾时统一合并应用），所以这个区分是必须的：
 * 界面在 `queued` 时也不该认为「已持久化」，只是「主进程收下了」。
 */
export interface ConfigSetResult {
  ok: boolean
  /** 落盘失败的原因码；`ok: true` 时没有。目前只有 'config-write-failed'。 */
  error?: string
  /** 导入期间被暂存：写入尚未落盘，收尾时与导入成果合并后一起写。此时 `ok` 恒 true。 */
  queued?: boolean
}
