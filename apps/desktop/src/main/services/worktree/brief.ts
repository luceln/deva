import { statSync } from 'fs'
import { runGitRaw } from '../git'
import { getRecord } from './store'
import { normalizeWorktreePath } from './paths'

/**
 * 会话侧的 worktree 关联：给系统提示词生成边界说明（spec §1.5 / A36）。
 *
 * ## 为什么按 `focusRoot` 反查，而不是在会话上存 worktreeId
 *
 * spec §1.6 已拍板：关联**只按「focusRoot 是否等于 worktree 路径」判定**，不在记录上反向记 sessionId 列表
 * （列表会漂、要维护）。会话被改挂到别处后关联自然变 0，这是正确且可推理解的行为。
 */

/** 系统提示词要用的边界信息（spec §1.5 的 WorktreeBrief）。 */
export interface WorktreeBrief {
  /** 工作区绝对路径（= 会话的 focusRoot）。 */
  path: string
  branch: string
  /** null = 创建时主目录 detached，尚未指定（§3.1）。 */
  targetBranch: string | null
  baseLabel: string
  repoRoot: string
  /** 主目录未提交改动数；0 时整行省略。与创建弹窗里显示的是同一个数字（A17/A36 要求同源）。 */
  primaryDirtyCount: number
}

/**
 * 取某个 focusRoot 对应的 worktree 边界信息。不是工作区（或没登记）时返回 null。
 *
 * ## 为什么这里**不做**「路径里有没有 worktrees 段」这类前置判断
 *
 * 我一开始写过一次，删了：`WorktreePrecheckReq.path` 允许用户指定任意位置（§7.2 的「回显用户输入」、
 * 0.8 的自定义路径），那种工作区不在 `<DEVA_HOME>/worktrees/` 下。按形状拦下会让那种会话拿不到边界说明，
 * 而这是**静默**的（提示词少一段，没有任何报错）。省下的那点开销（一次内存 Map 查表 + 一次路径归一化）
 * 换不来这个风险——它只在每轮建提示词时跑一次。
 *
 * **`primaryDirtyCount` 在这里现算**：spec 要求它与创建弹窗里的数字同源（同一次 status 语义），
 * 而不是记在记录里——记录里的数字会过时，提示词里说「主目录还有 3 个未提交改动」而实际已变成 7 个，
 * 比不说更糟（模型会据此判断「我看到的和主目录差 3 个」）。
 */
export async function briefForFocusRoot(focusRoot: string | null | undefined): Promise<WorktreeBrief | null> {
  if (!focusRoot || typeof focusRoot !== 'string') return null
  let rec
  try {
    rec = getRecord(focusRoot)
  } catch {
    // 归一化失败的畸形路径：当作不是工作区，不抛给提示词构建
    return null
  }
  if (!rec || rec.phase !== 'active') return null

  // 主目录未提交改动数：与 precheck 的 0.9 用同一条命令、同一种计数
  let primaryDirtyCount = 0
  try {
    const st = await runGitRaw(rec.repoRoot, ['status', '--porcelain'])
    if (st.code === 0) primaryDirtyCount = st.stdout.split('\n').filter((l) => l.trim() !== '').length
  } catch {
    // 数不出来就按 0（那一行会省略），不编一个数字
    primaryDirtyCount = 0
  }

  return {
    path: normalizeWorktreePath(rec.path).path,
    branch: rec.branch,
    targetBranch: rec.targetBranch,
    baseLabel: rec.baseLabel,
    repoRoot: normalizeWorktreePath(rec.repoRoot).path,
    primaryDirtyCount
  }
}

/**
 * 生成追加到【环境】段后面的边界说明（spec §1.5 的完整文本）。
 *
 * ## 三条硬要求（spec 写明，改这段前必读）
 *
 * 1. **负面约束必须保留**（最后那句「不要假设你看到的就是主目录的当前状态…读文件而不是凭记忆」）。
 *    这是整段里唯一防止「agent 凭记忆断定某改动存在/不存在」的句子——而那正是本需求立项的根本动机。
 *    删掉它，其余内容就只是描述性的，模型仍可能按主目录的心智模型行事。
 * 2. **「不在本区」那一行必须有数字**，且与创建弹窗里的 dirtyCount 同源（见上）。
 * 3. **「项目记忆」那一行必须写**：用户若不知道共享，在 worktree 里记一条、切回主目录看到它，会怀疑串了数据；
 *    agent 知道共享后，才不会为了「不影响主仓库」而回避写项目记忆。
 *
 * 与 `chat-prompts.ts` 既有那句的衔接：既有的「历史消息里出现过的其它目录一律作废，恒以本行为准」保留在前，
 * 本段追加在后。**最后那句与既有的是同一句，不要重复写两遍**——所以本函数不输出它，由调用处那句承担。
 */
export function worktreeBoundaryText(b: WorktreeBrief, en = false): string {
  /*
   * 默认中文：`chat-prompts.ts` 的整套系统提示词**本来就是中文**（不跟界面语言走），
   * 夹一段英文会让模型在两种语言间切换描述，反而更容易读错。`en` 参数留给将来的英文提示词。
   */
  const targetLine = b.targetBranch
    ? en
      ? `- Merging back: once you commit on this branch, the changes must be **merged back into \`${b.targetBranch}\` manually**. This app never merges automatically, and it never resolves conflicts for you`
      : `- 改动合回：提交在本分支后，需要**手动合回 \`${b.targetBranch}\`**。本应用不自动合并，冲突也不会自动解决`
    : en
      ? '- Merging back: no merge target has been chosen for this workspace yet — pick one in the merge panel. This app never merges automatically'
      : '- 改动合回：这个工作区还没指定合回目标，需要在合并面板里选一次。本应用不自动合并'

  if (en) {
    const lines = [
      'You are working in a **separate workspace** (a git worktree).',
      '',
      `- Working directory: \`${b.path}\``,
      `- This directory is a worktree of the repository \`${b.repoRoot}\`, checked out on branch \`${b.branch}\``,
      `- Starting point: cut from \`${b.baseLabel}\`; later commits on the main checkout do not affect this directory`,
      targetLine
    ]
    if (b.primaryDirtyCount > 0)
      lines.push(
        `- Not in this workspace: the main checkout has \`${b.primaryDirtyCount}\` uncommitted change(s); none of them are here`
      )
    lines.push(
      '- Project memory: this workspace shares the same project-private memory as the main checkout (notes written here are visible to sessions in the main checkout too)'
    )
    lines.push('')
    lines.push(
      'So: **do not assume what you see is the current state of the main checkout**. When you need to confirm whether a change exists, read the file rather than relying on memory.'
    )
    return lines.join('\n')
  }

  const lines = [
    '你在**独立工作区**（git worktree）里工作。',
    '',
    `- 工作目录：\`${b.path}\``,
    `- 本目录是仓库 \`${b.repoRoot}\` 的一个 worktree，检出分支 \`${b.branch}\``,
    `- 起点：从 \`${b.baseLabel}\` 切出，之后主目录的分支前进不影响本目录`,
    targetLine
  ]
  if (b.primaryDirtyCount > 0)
    lines.push(`- 不在本区：主目录还有 \`${b.primaryDirtyCount}\` 个未提交改动，它们都不在这个工作区里`)
  lines.push('- 项目记忆：与主仓库共享同一份项目私有记忆（在本目录记下的内容，主仓库会话也看得到）')
  lines.push('')
  lines.push(
    '因此：**不要假设你看到的就是主目录的当前状态**。需要确认某处改动是否存在时，读文件而不是凭记忆。'
  )
  return lines.join('\n')
}

/** 判断某个目录是否存在（供 UI 侧灰显，不参与判定）。 */
export function worktreePathExists(p: string): boolean {
  try {
    return Boolean(statSync(p, { throwIfNoEntry: false }))
  } catch {
    return false
  }
}