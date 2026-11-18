import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { WorktreeSnapshot, WorktreeView } from './worktree-view'

/**
 * worktree 快照的渲染层侧（spec §7.5 / §7.6）。
 *
 * ## 为什么是「一份快照 + 一个事件」，不是渲染层自己拼
 *
 * `state`（四态）、`deps`（五态）、`sessionCount`、`dirtyCount`、`mergeGate` 全部由主进程算好。
 * 渲染层**一处也不复算**：两套规则迟早漂移，而漂移的后果是静默的——界面说能合并、主进程拒绝（A48/R13）。
 * 这里只负责「拉一次、订阅事件、把结果给出去」。
 *
 * ## 事件里不带快照（spec §7.5）
 *
 * `worktree:changed` 的 payload 只有 `{ repoRoot }`，收到后**重拉全量**。理由：事件顺序与 invoke 响应顺序
 * 无保证，若把事件里的快照当状态用，界面会闪一下旧状态。worktree 数量是个位数，重拉一次很便宜。
 *
 * ## sizeBytes 的「统计中…」
 *
 * 列表首次返回时 `sizeBytes` 可能是 `null`（后台还在异步统计目录大小）。这不是错误态，UI 显示「统计中…」；
 * 算完主进程发 `worktree:changed`，本 store 重拉后自然刷新。故 store 不需要任何轮询。
 */

/** 一次拉取的结果。`ok: false` 时保留上一次的数据，避免网络/进程抖动让列表闪空。 */
export interface WorktreeListState {
  snapshot: WorktreeSnapshot | null
  loading: boolean
  error: string | null
}

interface WorktreeValue extends WorktreeListState {
  /** 手动重拉（用户点「刷新」，或某个操作完成后主动确认）。 */
  refresh: () => Promise<void>
  /** 按路径（或 compareKey）查一条记录。查不到返回 null —— 调用方据此回落显示 basename。 */
  viewOf: (path: string | null) => WorktreeView | null
}

const WorktreeContext = createContext<WorktreeValue | null>(null)

/**
 * 主进程 `worktree:list` 的返回可能是「快照对象」也可能是「记录数组」（早期实现是后者）。
 * 两种都收：早期实现没有 state/sessionCount 等字段，此时 `viewOf` 查到的记录缺字段，
 * 由 UI 逐字段做兜底，而不是让整个列表崩掉。
 */
function normalize(raw: unknown): WorktreeSnapshot | null {
  if (Array.isArray(raw)) {
    return {
      repoRoot: '',
      primaryBranch: null,
      worktrees: raw as WorktreeView[],
      unmanaged: [],
      memoryRoot: ''
    }
  }
  if (raw && typeof raw === 'object') return raw as WorktreeSnapshot
  return null
}

/**
 * 订阅 `worktree:changed`，返回取消订阅函数。
 *
 * preload 侧的 `worktree.onChanged` 与本 store 同时落地（主进程成员在 T1.2 的 main 半边补）。
 * 它还没到位时不能抛错——那会让整个 Provider 崩掉、连带聊天界面白屏。故这里逐层探测：
 * 没有这个函数就当作「不会收到变更事件」，列表只在挂载时拉一次（手动 refresh 仍可用）。
 * 这是**降级**而不是「假装成功」：控制台留一条警告，便于发现「事件没接上」这类静默问题。
 */
function subscribeChanged(cb: () => void): () => void {
  const wt = window.deva?.worktree as { onChanged?: (fn: () => void) => () => void } | undefined
  if (!wt || typeof wt.onChanged !== 'function') {
    console.warn('[worktree] preload 未提供 worktree.onChanged，列表不会随变更自动刷新')
    return () => undefined
  }
  try {
    return wt.onChanged(cb)
  } catch (e) {
    console.warn('[worktree] 订阅 worktree:changed 失败', e)
    return () => undefined
  }
}

export function WorktreeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<WorktreeListState>({ snapshot: null, loading: false, error: null })
  // 防竞态：连点刷新 / 事件连续到达时，只认最后一次请求的结果。
  const reqRef = useRef(0)
  // 组件是否还活着：IPC 回来时若已卸载，不再 setState。
  const liveRef = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqRef.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const raw = await window.deva.worktree.list()
      if (!liveRef.current || seq !== reqRef.current) return
      setState({ snapshot: normalize(raw), loading: false, error: null })
    } catch (e) {
      if (!liveRef.current || seq !== reqRef.current) return
      // 失败时**保留上一次的快照**：宁可显示稍旧的状态，也不要让列表突然空掉。
      setState((s) => ({ ...s, loading: false, error: (e as Error)?.message ?? String(e) }))
    }
  }, [])

  useEffect(() => {
    liveRef.current = true
    void refresh()
    /*
     * 订阅 `worktree:changed`：创建 / 删除 / 重建 / 依赖状态转移 / 合并成功 / sizeBytes 算完都会发。
     * 收到的是一份**通知**而不是快照，故一律重拉（spec §7.5 明确要求）。
     */
    const off = subscribeChanged(() => {
      void refresh()
    })
    return () => {
      liveRef.current = false
      off()
    }
  }, [refresh])

  const viewOf = useCallback(
    (path: string | null): WorktreeView | null => {
      if (!path || !state.snapshot) return null
      // 比较要用归一化后的形态：同一个目录可能带尾斜杠 / 不同大小写（主进程按 compareKey 归一）。
      const norm = path.replace(/[\\/]+$/, '').toLowerCase()
      const hit = state.snapshot.worktrees.find((w) => {
        const p = w.path.replace(/[\\/]+$/, '').toLowerCase()
        const k = w.compareKey ? w.compareKey.replace(/[\\/]+$/, '').toLowerCase() : p
        return p === norm || k === norm
      })
      return hit ?? null
    },
    [state.snapshot]
  )

  const value = useMemo<WorktreeValue>(
    () => ({ ...state, refresh, viewOf }),
    [state, refresh, viewOf]
  )
  return <WorktreeContext.Provider value={value}>{children}</WorktreeContext.Provider>
}

export function useWorktree(): WorktreeValue {
  const ctx = useContext(WorktreeContext)
  if (!ctx) throw new Error('useWorktree 必须在 WorktreeProvider 内使用')
  return ctx
}

/**
 * 显示标签用的轻量查询：拿不到 Provider（如单测、或还没挂 Provider 的子系统）时返回 null，
 * 调用方回落 `basename(path)` 即可，**不抛错**。
 *
 * 为什么不复用 `useWorktree()`：它没有 Provider 时会 throw。显示标签是「有则更好」的信息，
 * 为了它让整棵子树崩掉不值得。
 */
export function useWorktreeViewSafe(path: string | null): WorktreeView | null {
  const ctx = useContext(WorktreeContext)
  if (!ctx) return null
  return ctx.viewOf(path)
}

/**
 * 同 `useWorktreeViewSafe`，但返回的是「查找器」而不是一次性结果：
 * 给需要在一个 `map` 里查多条路径的调用方（hook 不能进 map 回调）。
 */
export function useWorktreeViewOfSafe(): (path: string | null) => WorktreeView | null {
  const ctx = useContext(WorktreeContext)
  return (path: string | null): WorktreeView | null => (ctx ? ctx.viewOf(path) : null)
}
