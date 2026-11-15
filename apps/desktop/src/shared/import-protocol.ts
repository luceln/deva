/**
 * 「从原版 Deva 导入数据」的共享类型（主进程 / preload / 渲染层三方共用）。
 *
 * 定位：这是**一次性导入**，不是持续同步——只补 DevaPlus 没有的，已存在的一律跳过，判断依据只有 id / 文件名
 * （不看 mtime、不比较内容），所以天然幂等。原版 `~/.deva` 全程只读，一个字节都不改。
 *
 * 为什么类型放 shared：导入结果要逐条显示给用户（成功 / 跳过 / 失败三栏），失败条目还要带原因；这些结构的形状
 * 若在三个地方各写一份，改一处就会漂。实施细节见 main/services/importer*.ts，界面见 renderer 的 ImportPane。
 */

/** 一步的结果：本次新建了哪些、跳过了哪些（id 或文件名）。 */
export interface StepStat {
  copied: string[]
  skipped: string[]
}

/** 一条失败：哪一步、哪个 id、为什么。界面必须逐条显示——否则用户会以为导入成功了。 */
export interface Failure {
  step: string
  id: string
  reason: string
}

/**
 * 记忆合并的结果。added / skipped 仍是条目（不只 id），因为界面上要能看清「这条记忆没能导入」的正文，
 * 而记忆 id 是随机短码、单独看不出内容。
 */
export interface MergeStat {
  added: string[]
  skipped: string[]
  failed: Failure[]
}

/** 四类附件的复制计数。 */
export interface AssocReport {
  media: number
  checkpoints: number
  subagents: number
  toolResults: number
}

/**
 * 一轮导入的完整报告。ok 只在 failures 为空时为真——任何一条失败都要让界面亮红，不能因为「大部分成功」就报绿。
 */
export interface ImportReport {
  ok: boolean
  providers: StepStat
  /**
   * 密钥补缺（与原版 provider 配套的那些密文）。**与 providers 分开计**：密钥不是独立可见的资产，
   * 混进 providers.copied 会让界面「服务商」那行的数字比实际服务商数大一截。
   */
  secrets: StepStat
  personas: StepStat
  /** 角色启用态（补 config.personas.enabled）：不补的话导入的角色虽然出现在列表里，却是停用态。 */
  personaEnabled: string[]
  memories: MergeStat
  skills: StepStat
  sessions: StepStat
  assoc: AssocReport
  failures: Failure[]
}

/** 原版数据的概况，供界面在按钮旁展示「将导入什么」，也为空态判断（no-source）提供数字。 */
export interface SourceSummary {
  sessions: number
  compacted: number
  memberSessions: number
  providers: number
  personas: number
  memories: number
  skills: number
  media: number
  checkpoints: number
  subagents: number
  toolResults: number
}

/**
 * 闸门结果。失败两种：
 *  - `no-source`：找不到原版数据目录（用户没装原版，或装在别处）；
 *  - `source-running`：原版正在运行——它可能正在全量重写会话 JSON，此刻读到的可能是半截文件，导进来就是坏数据。
 *
 * `importing` 是**独立于 ok 的状态位**：本应用这一侧已经有一轮导入在跑（含另一个窗口在跑）。它与闸门无关——
 * 闸门管的是「能不能导」，它管的是「现在是不是正在导」。界面据此置灰按钮，而不是靠 ok 推断
 * （否则要么把「原版在跑」和「自己正在导」混成一件事，要么残留锁让按钮永久灰掉）。
 * 定为可选：渲染层若有构造 GateResult 的降级路径（探测失败时折算成 no-source），不该被一个新状态位卡住编译。
 */
export type GateResult =
  | { ok: true; sourceHome: string; summary: SourceSummary; importing?: boolean }
  | { ok: false; code: 'no-source' | 'source-running'; message: string; importing?: boolean }

/** 进度事件：长任务（附件上百 MB）要能让界面看到「正在做哪一步」，而不是干等。 */
export interface ImportProgress {
  step:
    | 'providers'
    | 'personas'
    | 'personaEnabled'
    | 'memories'
    | 'skills'
    | 'sessions'
    | 'assoc'
    | 'cache'
    | 'done'
  /** 当前步骤内已处理 / 总数（无总数时为 0，界面显示不确定进度）。 */
  done: number
  total: number
}
