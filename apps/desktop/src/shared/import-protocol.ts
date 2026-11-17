/**
 * 「从原版 Deva 导入数据」的共享类型（主进程 / preload / 渲染层三方共用）。
 *
 * 定位：这是**一次性导入**，不是持续同步——只补 DevaPlus 没有的，已存在的一律跳过，判断依据只有 id / 文件名
 * （不看 mtime、不比较内容），所以天然幂等。原版 `~/.deva` 全程只读，一个字节都不改。
 *
 * 为什么类型放 shared：导入结果要逐条显示给用户（成功 / 跳过 / 失败三栏），失败条目还要带原因；这些结构的形状
 * 若在三个地方各写一份，改一处就会漂。实施细节见 main/services/importer*.ts，界面见 renderer 的 ImportPane。
 */

/**
 * 一步的结果：本次新建了哪些、跳过了哪些（id 或文件名）。
 *
 * 三个可选桶，都是为了不让用户看到莫名其妙的数字：
 *  - `builtin`：应用自带的项（预置服务商、默认角色、内置元技能）。原版里的 11 个预置服务商在二开版启动时就被
 *    种进 config，算进 skipped 会让用户看到「跳过 11 个」而以为自己有 11 个东西被忽略（实测用户就 5 个自定义的）。
 *  - `ignored`：**不适用**于目标的项。典型例子是原版 secrets.json 里的 `remote:…:appSecret`——本方案刻意不导
 *    remote 段，搬过去也没有对应配置可用，是无主密文。它既不是导入成功，也不是「因为已存在而跳过」，
 *    算进 skipped 会在首轮导入就冒出「跳过 1」，同样是无意义的噪声。
 *  - `failed`：真失败（复制出错 / 磁盘满 / 无权限）。与 skipped 严格区分——把失败说成「跳过」会让界面
 *    显示「导入完成」而用户永远不知道有东西没进来。调用方负责汇总进 ImportReport.failures。
 */
export interface StepStat {
  copied: string[]
  skipped: string[]
  builtin?: string[]
  ignored?: string[]
  failed?: Failure[]
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

/**
 * 密钥补缺结果。**与 providers 分开计**（密钥不是独立可见的资产，混进 providers.copied 会让「服务商」那行
 * 的数字比实际服务商数大一截）。
 *
 * 为什么不复用 `StepStat`：密钥的「没进来」有四种彼此不同的原因，界面要说四句不同的话。压进一个 `skipped`
 * 等于把「这台机器存不了密钥，请手动重填」说成「本来就有，不用管」——那是「密钥不用重输」这条唯一
 * 会无声失效的通道。所以这里把桶拆开：
 *  - `copied`       ：写进目标 secrets.json 了；
 *  - `skipped`      ：目标**已有**同名密钥，保留本地那份（正常的「不用导」）；
 *  - `ignored`      ：**不适用**（原版里有、但目标没有对应配置的无主密文，如 `remote:` / `mcp:` 命名空间）；
 *  - `noEncryption` ：这台机器**没有可用加密**（Linux 无 libsecret / 换了 OS 账户），一个都没存进去；
 *  - `invalid`      ：源里那条本身是空值 / 坏值；
 *  - `failed`       ：内存里有、盘上没有（真失败，重启后密钥就没了）。
 */
export interface SecretsStat {
  copied: string[]
  skipped: string[]
  ignored: string[]
  noEncryption: string[]
  invalid: string[]
  failed?: Failure[]
}

/** 四类附件的复制计数。 */
export interface AssocReport {
  media: number
  checkpoints: number
  subagents: number
  toolResults: number
  /**
   * 附件这一类的失败。界面按「步骤」逐行显示时（媒体 / 回滚面板 / 子智能体记录 / 工具结果）需要它，
   * 否则这一步是唯一一个「只有数字、没有失败位」的步骤，看上去像「永远不出错」。
   * 与 `ImportReport.failures` 里的同内容条目对应（后者是总清单，供一次性展示）。
   */
  failed?: Failure[]
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
   *
   * 形状是 `SecretsStat`（不是 `StepStat`）：密钥的每种「没进来」都要单独提示，见该类型的注释。
   */
  secrets: SecretsStat
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
  /**
   * 项目记忆目录下有多少个有效项目（24 位 hex 目录）。
   * 它不进「将导入什么」的数字展示，但**必须进概览探测**：这个目录读不出来时，
   * 所有项目记忆一条都导不进来，闸门要能看见它才能拦住。
   */
  projects: number
}

/**
 * 闸门结果。
 *
 * 失败四种（**界面不要自己按 code 挑文案**，`message` 已经是给人看的完整句子）：
 *  - `no-source`：找不到原版数据目录（用户没装原版，或装在别处）；
 *  - `source-running`：原版正在运行——它可能正在全量重写会话 JSON，此刻读到的可能是半截文件，导进来就是坏数据；
 *  - `source-unreadable`：**查不出**原版状态（它的 lockfile 权限不足 / 只读）。判据仍 fail-closed（不放行），
 *    但这不是「在运行」的证据；若照 `source-running` 的文案提示「请先退出原版」，用户会发现怎么退出都没用；
 *  - `same-home`：目标目录与原版目录重合（`DEVA_HOME` 设错）。此时提示「没有找到原版数据目录」是**反的**——
 *    原版目录明明在，问题是导入会去改它；
 *  - `source-partially-unreadable`：源目录能进去，但**其中某些部分**读不出来（某个子目录被同名文件占住 / ACL
 *    改坏 / 被杀毒锁住）。这时概况里的 0 是假的（「读不到」而非「没有」），必须拦下：
 *    概览显示「0 个会话」+ 按钮可点，用户会以为原版本来就没有会话，照常导入一份残缺数据，而这是一次性导入。
 *    与 `source-unreadable` 区分：那条是源目录本身打不开（连 stat 都失败），这条是进得去、某些项读不出。
 *
 * ⚠️ `message` 是**给人看的完整文案**（已按界面语言本地化），界面应优先直接用它；`code` 只用于需要额外动作的
 * 分支（例如 `no-source` 可以引导「先安装原版」）。早期界面只判了 `code === 'source-running'`、其余一律当
 * `no-source`，于是上面两种新码都显示成「没有找到原版数据目录」——主进程写了精确文案，界面却从头到尾没用过它。
 *
 * `importing` 是**独立于 ok 的状态位**：本应用这一侧已经有一轮导入在跑（含另一个窗口在跑）。它与闸门无关——
 * 闸门管的是「能不能导」，它管的是「现在是不是正在导」。界面据此置灰按钮，而不是靠 ok 推断
 * （否则要么把「原版在跑」和「自己正在导」混成一件事，要么残留锁让按钮永久灰掉）。
 * 定为可选：渲染层若有构造 GateResult 的降级路径（探测失败时折算成 no-source），不该被一个新状态位卡住编译。
 */
export type GateResult =
  | { ok: true; sourceHome: string; summary: SourceSummary; importing?: boolean }
  | {
      ok: false
      code: 'no-source' | 'source-running' | 'source-unreadable' | 'source-partially-unreadable' | 'same-home'
      message: string
      importing?: boolean
    }

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
