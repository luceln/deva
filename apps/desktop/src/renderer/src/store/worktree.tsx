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
import type { WorktreeListItem, WorktreeSnapshot } from '../../../shared/worktree-protocol'

/**
 * worktree 快照的渲染层侧（spec §7.5 / §7.6）。
 *
 * ## 为什么是「一份快照 + 一个事件」，不是渲染层自己拼
 *
 * `state`（四态）、`deps`（五态）、`sessionCount`、`sizeBytes`、`lockHolder` 全部由主进程算好。
 * 渲染层**一处也不复算**：两套规则迟早漂移，而漂移的后果是静默的——界面说能合并、主进程拒绝（A48/R13）。
 * 这里只负责「拉一次、订阅事件、把结果给出去」。
 *
 * ## 事件里不带快照
 *
 * `worktree:changed` 只是一句通知，收到后**重拉全量**。理由：事件顺序与 invoke 响应顺序无保证，
 * 若把事件里的快照当状态用，界面会闪一下旧状态。worktree 数量是个位数，重拉一次很便宜。
 *
 * ## sizeBytes 的「统计中…」
 *
 * 列表首次返回时 `sizeBytes` 可能是 `null`（后台还在异步统计目录大小）。这不是错误态，UI 显示「统计中…」；
 * 算完主进程发 `worktree:changed`，本 store 重拉后自然刷新。故 store 不需要任何轮询。
 *
 * **别在这里加「没有 onChanged 就只拉一次」的降级分支**：事件曾经断在
 * `publishWorktreeChanged()` 只发进程内总线、没有 `webContents.send` 上，现在已由 `4b07711` 接好。
 * 再加一层降级探测，只会把「事件真的断了」伪装成「只是慢」，让体积永远停在「统计中…」而不是暴露问题。
 */

/** 一次拉取的结果。失败时保留上一次的数据，避免一次抖动让列表闪空。 */
export interface WorktreeListState {
  snapshot: WorktreeSnapshot | null
  loading: boolean
  error: string | null
}

interface WorktreeValue extends WorktreeListState {
  /** 手动重拉（用户点「刷新」，或某个操作完成后主动确认）。 */
  refresh: () => Promise<void>
  /** 按路径（或 compareKey）查一条记录。查不到返回 null —— 调用方据此回落显示 basename。 */
  viewOf: (path: string | null) => WorktreeListItem | null
}

const WorktreeContext = createContext<WorktreeValue | null>(null)

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
      const snapshot = await window.deva.worktree.list()
      if (!liveRef.current || seq !== reqRef.current) return
      setState({ snapshot, loading: false, error: null })
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
     * 收到的是一句**通知**而不是快照，故一律重拉。
     */
    const off = window.deva.worktree.onChanged(() => {
      void refresh()
    })
    return () => {
      liveRef.current = false
      off()
    }
  }, [refresh])

  const viewOf = useCallback(
    (path: string | null): WorktreeListItem | null => {
      if (!path || !state.snapshot) return null
      // 比较要用归一化后的形态：同一个目录可能带尾斜杠 / 不同大小写（主进程按 compareKey 归一）。
      const norm = path.replace(/[\\/]+$/, '').toLowerCase()
      const hit = state.snapshot.items.find((w) => {
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
 * 为了它让整棵子树崩掉不值得。这与上面说的「不写降级探测」是两件事：那条说的是
 * **不要把事件断线伪装成正常**，这条说的是**别让一个可有可无的显示信息拖垮整棵子树**。
 */
export function useWorktreeViewSafe(path: string | null): WorktreeListItem | null {
  const ctx = useContext(WorktreeContext)
  if (!ctx) return null
  return ctx.viewOf(path)
}

/**
 * 同 `useWorktreeViewSafe`，但返回的是「查找器」而不是一次性结果：
 * 给需要在一个 `map` 里查多条路径的调用方（hook 不能进 map 回调）。
 */
export function useWorktreeViewOfSafe(): (path: string | null) => WorktreeListItem | null {
  const ctx = useContext(WorktreeContext)
  return (path: string | null): WorktreeListItem | null => (ctx ? ctx.viewOf(path) : null)
}
