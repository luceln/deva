import { getRecord } from './store'
import { normalizeWorktreePath } from './paths'

/**
 * 工作区路径 → **项目记忆根**（spec §1.4 的唯一解析函数）。
 *
 * ## 为什么需要它（G5 这条 P1）
 *
 * `memory.ts` 的项目记忆路径是 `projects/<sha1(realpath(root))>/memory.json`。worktree 是不同路径，
 * 于是每个 worktree 会是**一份全新的空记忆**：用户在 `E:\deva` 记下的「pnpm 前要先 install」
 * 在 worktree 会话里 agent 一条都读不到，**界面无任何提示**——用户只会觉得「它在独立工作区里变笨了」。
 *
 * 所以要把两个概念分开，名字不得混用：
 * - `workspaceRoot` / `effectiveRoot` = **工作目录**（工具、命令、终端、相对路径的基准）→ 永远是 worktree 路径；
 * - `memoryScopeRoot` = **项目记忆根** → worktree 会话下等于 `record.repoRoot`，其余情况**恒等于** workspaceRoot。
 *
 * ## 约束
 *
 * - **只依赖 `store.ts` 与 `paths.ts`，不得 import `git.ts`**（spec 明确要求，避免环形依赖：
 *   git 侧将来可能反过来要用 worktree 的判定）。
 * - **必须同步**：提示词构建是同步的。记录是内存态 Map，同步查表即可，**不读盘**。
 */
export function projectMemoryRootOf(root: string | null): string | null {
  if (!root) return null
  let rec
  try {
    // 归一化后查表：同一个工作区的不同写法要命中同一条记录
    rec = getRecord(normalizeWorktreePath(root).path)
  } catch {
    // 归一化失败的畸形路径：当作不是工作区
    return root
  }
  if (!rec || rec.phase !== 'active') {
    /*
     * 未命中 → 返回 `root` **原值**，不做归一化后返回。
     * spec 明确要求：否则非 worktree 会话的记忆键会随归一化（大小写 / 尾斜杠 / 真实路径）而漂移，
     * 用户会看到「同一个项目忽然多出一份空记忆」。
     */
    return root
  }
  try {
    return normalizeWorktreePath(rec.repoRoot).path
  } catch {
    return rec.repoRoot
  }
}