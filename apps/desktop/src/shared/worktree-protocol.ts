/**
 * worktree 的 IPC 协议类型（主进程 model-availability 式的「判定只在主进程」）。
 *
 * 渲染层只消费这些结果，不复算：两套规则迟早漂移，而漂移的后果是静默的
 * （界面说能建、主进程拒绝，或反过来）。
 */

/** 创建前探测的请求。 */
export interface WorktreePrecheckReq {
  repoRoot: string
  /** 起点。缺省 = 主目录此刻的 HEAD（**不是** `--abbrev-ref`，detached 下那是字面量 HEAD）。 */
  baseRef?: string
  branch?: string
  /** 省略 = 按 §6.1 自动生成（spec 空缺的补法，见 precheck.ts 的注释）。 */
  path?: string
  /** 用户在弹窗里确认了「主目录有未提交改动」也继续。 */
  confirmedDirty?: boolean
}

/** 创建请求（比探测多一个确认位）。 */
export interface WorktreeCreateReq extends WorktreePrecheckReq {
  /**
   * 用户勾了「不安装依赖」（spec §3.6）。
   *
   * 为 true 时 deps 直接落 `skipped`（`depsDetail: 'user-skipped'`），**不探测命令是否存在**——
   * 用户已经明确表示不要，再去 `pnpm --version` 是多余动作，而失败还要编个理由。
   */
  skipDeps?: boolean
}

/**
 * 探测成功的结果。
 *
 * 字段与 `precheck.ts` 的 `PrecheckOk` 一一对应；这里重新声明一份而不是 import：
 * `shared/` 不能依赖 `main/`（打包边界），两边的形状由测试锁住。
 */
export interface WorktreePrecheckOk {
  ok: true
  repoRoot: string
  defaultBase: string
  defaultBaseLabel: string
  baseSha: string
  baseLabel: string
  /** null = 主目录 detached，尚未指定合回目标（§3.1 的 0.3）。 */
  targetBranch: string | null
  primaryDetached: boolean
  mergeTargetWarning?: string
  path: string
  branch: string
  slug: string
  dirtyCount: number
  needsConfirm: boolean
  softWarn?: 'many-worktrees'
  existingCount: number
}

export type WorktreePrecheckReason =
  | 'not-a-repo'
  | 'bad-base'
  | 'bad-branch'
  | 'branch-exists'
  | 'path-exists'
  | 'path-too-long'
  | 'path-inside-repo'
  | 'path-outside-root'
  | 'slug-collision'
  | 'no-git'
  | 'error'

export interface WorktreePrecheckFail {
  ok: false
  reason: WorktreePrecheckReason
  /** 给人看的原因（主进程按界面语言出）。 */
  message: string
  /** 可执行的替代（如 branch-exists 时给自动后缀）。 */
  suggestion?: string
}

export interface WorktreeCreateOk {
  ok: true
  record: unknown
}

export interface WorktreeCreateFail {
  ok: false
  reason: string
  message: string
  /** 清理结果：创建为什么失败看 reason/message，这里只说明有没有收拾干净。 */
  cleanup?: {
    worktreeRemoved: boolean
    dirRemoved: boolean
    branchRemoved: boolean
    recordRemoved: boolean
    warnings: string[]
  }
}

/** 会话挂在独立工作区里时，给界面显示标签用。 */
export interface WorktreeBriefView {
  path: string
  branch: string
  targetBranch: string | null
  baseLabel: string
  repoRoot: string
  /** 主目录未提交改动数；与创建弹窗里显示的是同一个数字（A17/A36 要求同源）。 */
  primaryDirtyCount: number
}
/**
 * `worktree:list` 的返回值（快照）。
 *
 * `state` 由主进程算好，渲染层**只消费不复算**（A48）：两套规则迟早漂移，而漂移的表现是静默的——
 * 界面显示「可合并」，点下去必失败。
 */
export type WorktreeState = 'ok' | 'branch-mismatch' | 'dir-missing' | 'prunable'

/**
 * 合并可用性的阻塞原因（spec §7.5）。
 *
 * 前三个对应 §4.2 的检查，`'installing'` **不是** C1~C6 里的一项：它是 UI 层的
 * 「依赖没装完不能合并」——安装期间文件系统不稳定，git 会看到半装的文件。
 * 所以它由主进程在 `mergeGate` 里给，不走检查表。
 */
export type MergeBlocker =
  | 'target-not-set'
  | 'source-missing'
  | 'source-branch-changed'
  | 'installing'

/**
 * 轻量合并可用性门（`worktree:list` 一并返回，spec §7.5）。
 *
 * **只看 `state` / `deps` / `targetBranch`，不跑 `status --porcelain`**：列表要对每个工作区算一次，
 * 跑重活就是 5 个工作区 5 次 git 调用。真正的四项检查在用户点开合并面板时由
 * `worktree:merge-dryrun` 做（那时才跑 C1~C6）。
 *
 * 渲染层**不得**自己从 `state` 推禁用：状态只由主进程算（A48）。
 */
export interface MergeGate {
  mayMerge: boolean
  blocker?: MergeBlocker
}

export interface WorktreeListItem {
  path: string
  compareKey: string
  repoRoot: string
  branch: string
  baseSha: string
  baseLabel: string
  targetBranch: string | null
  createdAt: number
  state: WorktreeState
  /** `branch-mismatch` 时的实际 HEAD 分支名（detached 时为 'HEAD'）。 */
  actualBranch?: string
  deps: 'pending' | 'installing' | 'ready' | 'failed' | 'skipped'
  depsDetail?: string
  /** 关联会话数（`focusRoot` 指向本路径的会话数）。 */
  sessionCount: number
  /** 目录体积；null = 还在统计（界面显示「统计中…」）。 */
  sizeBytes: number | null
  /** 当前持锁者（另一个会话正在这个目录上跑 git 操作）。 */
  lockHolder: { label: string; since: number } | null
  /**
   * 该工作区未提交改动数；目录不存在时为 null（无法统计）。列表显示「N 个未提交改动」用（§7.7）。
   *
   * 与 `mergeGate` 的区别：这个数字要**显示给用户**，只能真跑 `status --porcelain`；
   * `mergeGate` 只判「能不能点」，不跑 status（§7.5）。
   */
  dirtyCount: number | null
  /**
   * target 检出里是否有未收尾的合并（§13.10）。**每次从 git 现算，不落盘。**
   *
   * 非空时卡片显示「合并进行中」，并可打开冲突处理窗口。
   * 不能落盘的理由：用户在终端手跑 `git merge --abort` 后，落盘状态立刻过期，
   * 界面会一直显示「合并中」，用户以为卡死。
   */
  mergeInProgress: { targetPath: string; unmergedCount: number } | null
  /** 合并可用性：主进程算好的门（不看 dirty，只做轻量判定）。见 §7.5 与 A48。 */
  mergeGate: MergeGate
  /*
   * ── 「创建时根」相关（worktree 根可配置需求 §11.2 / A11 / A14）──
   *
   * 这两个字段只用于**界面标注**，不参与任何可用性判定：根外老记录照样能删除、合并、重建、
   * 装依赖（需求 §10.1 / §11.2「标注不得影响其他按钮的可用性」）。
   *
   * 为什么由主进程算、不给渲染层拼：根的读取要归一化（大小写 / 尾斜杠 / `\\?\`），
   * 渲染层再算一遍必然与主进程漂移，而漂移的表现是「标了根外、实际删得掉」这种静默矛盾。
   */
  /**
   * 这条记录是否在当前 `worktreeRoot` 内。
   *
   * **`undefined` 表示「老记录、无法判断」**（缺 `createdUnderRoot`）：这不是「在根外」，
   * 界面不该给它打标注。把它折成 `false` 会让所有历史记录一上线就被标成根外 —— 那是假信息。
   */
  insideRoot?: boolean
  /** 创建时生效的根（compareKey，老记录无此值）。界面「恢复默认后按新根重算」时不必，
   *  但用户在核对「这个目录当初建在哪」时需要它。 */
  createdUnderRoot?: string
}

/** 不受本功能管理的 git 登记项：只读展示，不参与任何操作。 */
export interface UnmanagedWorktree {
  path: string
  branch?: string
  head?: string
  prunable?: boolean
}

export interface WorktreeSnapshot {
  items: WorktreeListItem[]
  unmanaged: UnmanagedWorktree[]
  /** 记录文件本身读坏了：`items` 为空**不代表没有工作区**，界面要提示「记录读不出」。 */
  storeUnreadable: boolean
}

/** 依赖安装的结果（`worktree:install-deps`）。 */
export interface WorktreeInstallResult {
  ok: boolean
  /** 失败原因：`not-found` / `already-installing` / `no-lockfile` / `unsupported-language` / `write-failed`。 */
  reason?: string
  deps?: WorktreeListItem['deps']
}

/**
 * 某个工作区的体积统计完成（`worktree:size` 推送，**增量**）。
 *
 * 一次 `worktree:list` 会为每条有效工作区返回 `sizeBytes: null`，随后后台各自算完。
 * 这个事件只带变的那一条：界面按 `compareKey` 就地补字段，**不重拉列表**。
 *
 * 为什么不复用 `worktree:changed`：那个会让界面整表重拉，而一轮重拉是 `4N+1` 次 git
 * （实测 5 个工作区约 1.8 秒）。后台逐步回填 N 个体积就会重拉 N 次，把打开列表的真实开销翻倍。
 */
export interface WorktreeSizeUpdate {
  compareKey: string
  sizeBytes: number
}

/**
 * worktree 长操作的进度（`worktree:progress` 推送）。
 *
 * - `waiting-lock`：等 Git 锁超过 5 秒（spec §5.1 第 7 条 / B6）。
 * - `install-deps`：依赖安装进行中（spec §3.6 / B4）。
 * - `merging`：合并已开始（检查阶段通过、正在执行 merge）。
 *
 * 必须照抄 `importer-ipc.ts` 的 `throttledSend`：100ms 节流 + 换 `phase` 立即发 + 收尾
 * `phase === 'done'` 必发 + `timer.unref()`。不节流会淹没渲染层，丢最后一次会让进度条永远差一截。
 */
export type WorktreeProgress =
  | {
      phase: 'waiting-lock'
      holder: { label: string; since: number } | null
    }
  | {
      phase: 'install-deps'
      path: string
      step: string
      elapsedMs: number
    }
  | {
      phase: 'merging'
      /** 工作区路径（不是 targetPath：进度按用户点的那个工作区归属）。 */
      path: string
    }
  | {
      phase: 'done'
      path: string
    }

/**
 * 删除一个 worktree（`worktree:remove`）。
 *
 * 与创建不同，这是**破坏性操作**，所以两件事必须显式：
 *  - `force`：有未提交改动时也删（会丢改动），默认 false
 *  - `deleteBranch`：连分支一起删，默认 true（留着会让同名分支建不出来）
 */
export interface WorktreeRemoveReq {
  /** worktree 的绝对路径（`WorktreeSnapshot.items[].path`）。 */
  path: string
  force?: boolean
  deleteBranch?: boolean
}

/**
 * 删除的结果。
 *
 * ⚠️ `ok: true` **不等于「什么都没留」**：分支可能因为还被别处检出而保留、目录可能因为
 * 「不像我们的 worktree 目录」而没删。这些都在 `warnings` 里，界面**必须展示**，
 * 否则用户以为删干净了，实际还占着几百 MB。
 */
export interface WorktreeRemoveResult {
  ok: boolean
  /** 没删成的原因（`ok:false` 时有值）。`dirty` 时 `dirtyCount` 一并给出。 */
  reason?: 'not-found' | 'dirty' | 'installing' | 'unreadable' | 'remove-failed'
  message?: string
  dirtyCount?: number
  worktreeRemoved: boolean
  dirRemoved: boolean
  recordRemoved: boolean
  branchRemoved: boolean
  warnings: string[]
}

/**
 * 重建一个「目录已经不在了」的 worktree（spec T3.3 / A34）。
 *
 * 只重建目录，**不动分支**：分支里已提交的内容本来就在，重建只是把工作目录检出回来。
 * 目录还在时拒绝（要重置请先删除），分支已被删时拒绝（不替用户凭空造一个同名分支）。
 */
export interface WorktreeRebuildResult {
  ok: boolean
  reason?: 'not-found' | 'dir-exists' | 'branch-missing' | 'installing' | 'add-failed' | 'verify-failed'
  message?: string
  path?: string
  branch?: string
  /**
   * 重建后**回读**核对的结果：目录在、HEAD 在该分支、git 登记里有这条。
   *
   * A34 的判据就是这一项：`git worktree add` 退出码 0 不代表目录现在能用，
   * 所以 `ok:true` 必须伴随 `verified:true`。界面不该自己判断「建成了没」。
   */
  verified?: boolean
  /** 没能做到的部分，界面必须展示。 */
  warnings: string[]
}

/* ─────────────────────────── 合并（spec §4 / §7.2） ─────────────────────────── */

/** 四项检查的 id。顺序固定为 `C1, C2, C4, C5`（与界面四个圆点一一对应）。 */
export type MergeCheckId = 'C1' | 'C2' | 'C4' | 'C5'

/**
 * 单项检查（spec §7.2）。
 *
 * `status` 的颜色语义：`ok`=绿、`warn`=黄、`bad`=红、`skipped`=灰。
 *
 * ⚠️ `warn` 是本次新增：`C1`（source 有未提交改动）用它——**不阻断合并，但必须在界面上可见**。
 * 早先规格把 C1 写成硬拦，等于对用户说「你必须先提交」，在长期带改动开发的仓库里这一步会让用户
 * 绕过工具直奔终端（那就更没保护了）。定稿是「明确告知」而不是「静默放行」。
 */
export interface MergeCheck {
  id: MergeCheckId
  status: 'ok' | 'bad' | 'warn' | 'skipped'
  /**
   * 稳定键，渲染层据此取 i18n。取值：
   * `'dirty'` | `'branch-changed'` | `'busy'` | `'source-missing'` | `'not-checked-out'`
   * | `'overlap'` | `'unknown'`。
   *
   * `C3`/`C6`（进行中操作）**不占独立圆点**，并入 `C1`/`C2`（source 侧）或 `C5`（target 侧）的
   * `'busy'`，且 `busy` **优先于** `dirty` 展示——「上次合并没收尾」比「有 3 个改动」更根本。
   */
  reason?: string
  /**
   * 判据用到的数字 / 名称。键名固定：
   * `dirtyCount` | `dirtyPaths` | `overlapPaths` | `actualBranch` | `busyOp` | `targetPath`
   * | `primaryBranch`。
   */
  detail?: Record<string, string | number | string[]>
}

/**
 * 合并的入参。
 *
 * ⚠️ **`stashFirst` 是界面要接的参数**：C5 报 `target-overlap` 时，界面的二选一里
 * 「先存起来再合并」就传 `{ path, stashFirst: true }` 重调 `worktree:merge`。
 * 它是**用户显式选择**的载体——不传就绝不 stash（自动 stash 是明确禁止项）。
 */
export interface MergeOptions {
  /**
   * 用户在 C5 的提示上选了「先存起来再合并」：走显式 stash 三步
   * （`stash push --include-untracked` → `merge` → `stash pop`，spec §4.9.5）。
   *
   * 它改变的是 C5 的判定：交集非空时 C5 仍**通过**（用户的显式选择化解了它），
   * 而不是拦下来。
   */
  stashFirst?: boolean
}

/** 合并请求（`worktree:merge` / `worktree:merge-dryrun`）。 */
export interface WorktreeMergeReq extends MergeOptions {
  /** worktree 的绝对路径（`WorktreeListItem.path`）。 */
  path: string
}

/**
 * 显式 stash 流程的结果（只有 `stashFirst` 走过才有）。
 *
 * 这三项是**必须告知用户**的：`popConflict` 为真时工作区是冲突态、stash 条目**保留**（不会自动
 * drop）；`unstagedLost` 是因为 `stash pop` 默认不带 `--index`，原本 `git add` 过的文件会变回
 * 未暂存 —— 界面要把清单列出来，让用户自己决定是否重新 `git add`。
 */
export interface MergeStashInfo {
  /** stash 提交的 SHA（`refs/stash`）。用户想手工恢复时要用。 */
  sha: string | null
  /** pop 时有冲突：改动**都在文件里**，同时 stash 条目也还在（可再次 pop）。 */
  popConflict: boolean
  /** pop 后从「已暂存」变成「未暂存」的文件清单。 */
  unstagedLost: string[]
}

/**
 * 合并结果（spec §7.2）。
 *
 * ⚠️ 成功分支多了 `checks`：执行了 merge 时也要把检查结果给界面，否则成功面板无法显示
 * 「当时有 2 个未提交改动没被合并」这类告知。
 */
export type MergeResult =
  | {
      ok: true
      /** 目标分支已包含该工作区的全部提交：**没有**产生合并提交，界面不显示 SHA 与原文。 */
      upToDate: boolean
      targetPath: string
      targetBranch: string
      sourceBranch: string
      /** 冻结的 SHA（执行 merge 用的就是它）。 */
      sourceSha: string
      mergeCommit: string | null
      /** git merge 的 stdout+stderr 原样（`Merge made by the 'ort' strategy.` 与文件统计）；upToDate 时为空串。 */
      gitOutput: string
      /**
       * 窗口的另一半：合并成功后 source 又有了新提交。
       * 界面追加「期间该工作区又有 N 个新提交尚未合并，可再次合并」。**不自动重试**。
       */
      behindNote?: { pendingSha: string; pendingCount: number }
      /** 本次的检查结论（含 C1 的 dirtyCount）。 */
      checks?: MergeCheck[]
      /** 走过 stash 流程时给出。 */
      stash?: MergeStashInfo
    }
  | {
      ok: false
      /** 合并是否执行过。false = 卡在检查阶段（含 target-not-set），target **未被触碰**。 */
      mergeAttempted: boolean
      /**
       * **零或四项**：`target-not-set` 时为 `[]`，进入检查阶段后恒为 4 项。
       * 不得短路、不得按 status 过滤（界面按数组顺序画四个圆点）。
       */
      checks: MergeCheck[]
      reason:
        | 'target-not-set'
        | 'source-missing'
        | 'source-branch-changed'
        | 'source-busy'
        | 'target-not-checked-out'
        | 'target-overlap'
        | 'target-busy'
        | 'conflict'
        | 'merge-failed'
      /**
       * `conflict` / `merge-failed` 时是 git 的 `${stdout}\n${stderr}` **原样**
       * （本需求里**唯一不能本地化**的字符串：用户要的是 `CONFLICT (content): Merge conflict in x.ts`）。
       * 检查阶段失败时为**空串** —— 文案由渲染层按 `checks[].reason` + `detail` 从 i18n 取。
       */
      message: string
      /** `conflict` / `merge-failed` 时与 `message` 同值，便于界面统一展开。 */
      gitOutput?: string
      targetBranch: string | null
      sourceBranch: string
      /** C4 之后才有；界面用它做「中止合并 / 打开终端 / 打开目录」的目标。 */
      targetPath?: string
      /** 已冻结时给出，供「复制 git 命令」与手工执行。 */
      sourceSha?: string
      /** 走过 stash 流程时给出（`mergeAttempted` 为真才有意义）。 */
      stash?: MergeStashInfo
      /**
       * 兜底解析出的「被拦下的文件」（spec §4.9.7 的稳健提取）。
       *
       * ⚠️ 可能为空：git 的提示被 `advice.*` 配置改掉时提取不出路径。**提取为空不等于没有路径**
       * ——界面此时必须退回「原始 gitOutput + 三个出口」，不能显示「没有被拦的文件」。
       */
      blockedPaths?: string[]
    }

/** `worktree:set-target` 的入参（spec §7.1）：把 `record.targetBranch` 写回。 */
export interface WorktreeSetTargetReq {
  path: string
  /** 本地分支名（远端分支没被检出，不能作为 merge 的 cwd）。 */
  targetBranch: string
}

/** `worktree:set-target` 的结果。 */
export type WorktreeSetTargetResult =
  | { ok: true; targetBranch: string }
  | { ok: false; reason: 'not-found' | 'bad-branch' | 'write-failed'; message: string }

/* ───────────── worktree 根目录设置（根可配置需求 §9） ───────────── */

/**
 * `worktree:root` 的返回：当前生效的根 + 它是不是默认。
 *
 * 为什么要 `isDefault`：界面上「默认的 `<DEVA_HOME>/worktrees`」与「用户自己设的同一个路径」
 * 必须能区分 —— 前者应显示「默认」，后者显示为用户设定值。混在一起，用户会以为自己设过
 * 一个和默认一样的根，改 `DEVA_HOME` 时却发现没跟着走。
 */
export interface WorktreeRootView {
  /** 当前生效的根（已归一化）。 */
  root: string
  /** `config.json` 里没有该键 → 跟随 `DEVA_HOME`。 */
  isDefault: boolean
}

/**
 * `worktree:root-set` 的结果。
 *
 * 失败时 `message` 必须可直接展示，且**含具体路径**（需求 §9.4 / A27）：
 * 被哪个仓库挡住、试算出的超限路径是什么 —— 只说「不允许」用户没法修。
 */
export type WorktreeRootSetResult =
  | { ok: true; root: string; isDefault: boolean }
  | {
      ok: false
      /**
       * - `outside-repo-required`：根落在某个已登记仓库内（Q2：拒绝，不放行）
       * - `path-too-long`：根太深，`<root>/<repoKey>/<slug>-<shortid>` 会超过 180
       * - `bad-path`：路径无法归一化
       * - `write-failed`：校验过了但配置没写进去
       */
      reason: 'outside-repo-required' | 'path-too-long' | 'bad-path' | 'write-failed'
      message: string
    }
