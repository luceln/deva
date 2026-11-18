import { useWorktreeViewOfSafe, useWorktreeViewSafe } from '../store/worktree'

/**
 * worktree 的显示标签（spec §1.7）。
 *
 * ## 问题
 *
 * worktree 的目录名形如 `deva-my-dev-a1b2c3`（仓库名 + 分支 slug + 短哈希）。左栏副标题、
 * 会话行、任务选择器、输入框上的挂载 chip 都直接显示 `basename(path)`，于是用户看到一串
 * 认不出的目录名——而他真正关心的是「这个会话在哪个分支上」。
 *
 * ## 规则
 *
 * 能拿到 `worktree:list` 快照 → 用 `record.branch`；拿不到 → 回落 `basename(path)`。
 *
 * 「拿不到」的几种情形都回落，且都不算错误：
 * 1. 路径是普通目录（根本不是 worktree，绝大多数会话都是这种）；
 * 2. 快照还没拉回来（首帧）；
 * 3. 还没挂 `WorktreeProvider`（单测、或某个子系统单独渲染）。
 *
 * ## 为什么收敛到一个函数
 *
 * 四处调用点（Rail 副标题 / ProfileView 会话行 / TaskPickers 第二行 / Composer 挂载 chip）
 * 原本各写一遍 `basename()`。分支名的取法一旦分叉，同一个会话在不同位置会显示成两个名字——
 * 这种不一致很难被发现，用户只会觉得「这软件有点乱」。故只留一个出口。
 *
 * ## 与 `Rail.tsx:185 / :390 / :438` 的关系
 *
 * 那三处（`folderKeyOf` 分组键、搜索过滤、分组标题）**必须用原值路径**，不能换成标签：
 * 分组键要稳定（标签会随分支切换变化），搜索要能命中真实路径。故本文件只服务「给人看的文字」，
 * 不碰任何「用于比较的键」。
 */

/** 取路径最后一段（Windows / POSIX 分隔符都认，尾斜杠不影响）。 */
export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * 纯函数版：给「已经查到快照记录」的调用方用（或在 map 里用，见 `useWorktreeLabelOf`）。
 *
 * @param path    会话的 focusRoot
 * @param branch  快照里该 worktree 的分支名；`null` / 空串表示没查到
 */
export function labelOf(path: string | null, branch: string | null | undefined): string {
  if (!path) return ''
  const b = typeof branch === 'string' ? branch.trim() : ''
  return b || baseNameOf(path)
}

/**
 * 组件里用的版本：自己从 worktree store 取快照。适合「一个组件只显示一处路径」的场景
 * （Rail 的会话行、ProfileView 的会话行）。
 *
 * 拿不到 Provider 或查不到记录时回落 basename，见文件头「拿不到的几种情形」。
 */
export function useWorktreeLabel(path: string | null): string {
  const view = useWorktreeViewSafe(path)
  return labelOf(path, view?.branch)
}

/**
 * 「给路径 → 显示名」的取值器，适合在 `map` 里逐个求值的场景（TaskPickers 的会话下拉）。
 *
 * `useWorktreeLabel` 是 hook，不能在 map 回调里调；这里在组件顶层取一次 store，
 * 返回的闭包在渲染过程中同步查表。没有 Provider 时恒回落 basename。
 */
export function useWorktreeLabelOf(): (path: string | null | undefined) => string {
  const viewOf = useWorktreeViewOfSafe()
  return (path: string | null | undefined): string => labelOf(path ?? null, viewOf(path ?? null)?.branch)
}
