import {
  applyHeldPatches,
  beginConfigHold,
  endConfigHold,
  getConfig,
  getDevaHome,
  isConfigHeld,
  publishConfigChanged
} from './services/config'
import { invalidateIndexOnly } from './services/chat-store'
import { publishSessionsChanged } from './services/chat-bus'
import { canImport, upstreamHome } from './importer-gate'
import { copySecrets, mergeProviders, providersOf } from './importer-config'
import { importMcp } from './importer-mcp'
import { enableImportedPersonas, importPersonas } from './importer-personas'
import { importMemories } from './importer-memory'
import { importSkills } from './importer-skills'
import { importSessions } from './importer-sessions'
import { copyAssoc } from './importer-assoc'
import { acquireLock, isRunningInProcess, markRunning, releaseLock } from './importer-lock'
import { writeFailureReason } from './importer-source-dir'
import type { Failure, ImportProgress, ImportReport } from '../shared/import-protocol'

/**
 * 「从原版 Deva 导入数据」总控（主进程）。
 *
 * 定位：**一次性导入**，不是持续同步。只补 DevaPlus 没有的，已存在的一律跳过，判断依据只有 id / 文件名
 * （不看 mtime、不比较内容）→ 天然幂等，点多少次结果一致。原版 `~/.deva` 全程只读。
 *
 * **手动触发**，绝不塞进启动路径：导入是重操作（上百 MB、要动用户数据），不该在用户不知情时发生。
 *
 * 九步顺序固定，其中 ⑦ 会话必须早于 ⑧ 附件（否则启动清扫会把「还没有会话引用」的附件当垃圾删掉，见 importer-assoc）：
 *   ① 服务商 ② MCP 服务 ③ 密钥补缺 ④ 角色 ⑤ 角色启用态 ⑥ 记忆 ⑦ 技能 ⑧ 会话 ⑨ 附件 …（收尾含清缓存）
 *
 * ② 必须早于 ③：`copySecrets` 判 `mcp:<id>:<field>` 是否有主，靠的是目标 mcp.json 里已写入的 id。
 * 密钥在 ③ 一次搬完（服务商 + MCP 各自的密文），所以 `secrets` 不是独立的进度步骤，只在结果里占一行。
 *
 * 不吞错：单条失败不中断整轮（记进 failures 继续），但整轮 ok = failures 为空，界面必须把 failures 逐条显示出来。
 */

type ProgressFn = (p: ImportProgress) => void

/** 空报告的骨架（每步都先给空数组，缺字段的界面渲染会炸）。 */
function emptyReport(): ImportReport {
  return {
    ok: true,
    providers: { copied: [], skipped: [], failed: [] },
    mcp: { copied: [], skipped: [], failed: [] },
    secrets: { copied: [], skipped: [], ignored: [], noEncryption: [], invalid: [], failed: [] },
    personas: { copied: [], skipped: [], failed: [] },
    personaEnabled: [],
    memories: { added: [], skipped: [], failed: [] },
    skills: { copied: [], skipped: [], failed: [] },
    sessions: { copied: [], skipped: [], failed: [] },
    assoc: { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 },
    failures: []
  }
}

/**
 * 收尾：释放渲染层的写入暂存，把用户这一轮的补丁**合并**应用回去，并按需补回被覆盖的服务商。
 *
 * **抽出成函数是为了让正常路径与异常路径走同一份逻辑**（正常路径、catch、finally 三处都调它）。以前只在正常
 * 路径写了这段，`finally` 里另写了一份「只 endConfigHold + setConfig」的简化版——于是走兜底 catch 时
 * （例如某条记忆写盘抛异常），用户的旧快照照常覆盖 models，导入的服务商被抹掉，而报告只写一条 `unknown`。
 *
 * 合并语义（`applyHeldPatches` → `mergeModelsPatch`）是 2-B 的根治手段：渲染层的陈旧快照不再能抹掉主进程里
 * 它没见过的 provider。`mergeProviders` 那次补回仍然保留，因为它是**另一件事**：把 activeModelId 这类
 * 被快照写成 null 的单值字段恢复回来（合并语义下 provider 列表已经不会丢，但 `activeModelId` 是 incoming 胜）。
 *
 * 返回：
 *  - `failures`：用户补丁落盘失败（一条一份）。内存里是用户的改动、磁盘上是导入成果，重启后用户的改动凭空消失
 *    ——这符合「写盘失败必须上报」的原则，不能因为发生在收尾就例外；
 *  - `removedIds`：用户本轮主动删除的 provider id。导入器要拿它做两件事：给补回的 `mergeProviders` 排除，
 *    以及读回断言时不算「丢了」。
 */
function releaseHoldAndRestoreModels(
  src: string,
  held: Array<Record<string, unknown>>
): { failures: Failure[]; removedIds: Set<string> } {
  const applied = applyHeldPatches(held)
  const failures: Failure[] = applied.failures.map((f) => ({
    step: 'config',
    id: `user-patch#${f.index + 1}`,
    reason: 'config-write-failed'
  }))
  /**
   * 安全网：若用户这一轮的补丁里**动过 models 段**，就再跑一次「只增不改」的服务商合并把成果补回来
   * （本方案只增不改，重跑天然幂等）。
   *
   * ⚠️ 触发条件是「补丁自身带 models 键」（`applyHeldPatches` 的 `touchedModels`，判 `hasOwnProperty`），
   * 不是 `copied.length`、不是 `providers.wrote`、也**不是**「合并后内容有没有变化」：
   *  - `copied.length`：第二轮导入必然为 0（幂等），补回从不触发 → 上一轮成果被陈旧快照抹掉；
   *  - `providers.wrote`：「本轮首次合并是否写过盘」，第二轮同样 false；
   *  - 「合并后内容有变化」：陈旧快照把 `activeModelId` 写成 null、provider 列表零变化时判 false → 不补回 →
   *    `activeModelId` 悄悄保持 null。而 `mergeProviders` 恰恰负责把它从 null 恢复。
   * 判「键存在」才与旧行为等价，不会悄悄改变语义。
   *
   * ⚠️ **返回值必须收**。这次补回同样是一次 `setConfig` 写盘：它失败时内存态已改、磁盘上仍缺服务商，而紧接着的
   * 读回断言读的是内存（见 importer.ts 里那段解释），断言会通过、`ok` 会是 true、磁盘上却没有。这与 P0-A
   * （第 ③ 步丢返回值）是同一个病，只是发生在收尾。所以照第一次调用那样把 `stat.failed` 汇总进 failures。
   *
   * reason **不改写**：渲染层是按完整码精确查文案表的（`FAILURE_REASON_KEY`），给个 `restore-xxx` 新码
   * 只会让用户看到裸的 `restore-config-write-failed`。同一轮里出现两条「配置写盘失败」是如实反映
   * 「两次写盘都失败了」，不是重复噪声。
   */
  if (applied.touchedModels) {
    const restore = mergeProviders(src, { excludeIds: [...applied.removedIds] })
    failures.push(...(restore.failed ?? []))
  }
  return { failures, removedIds: applied.removedIds }
}

/**
 * 跑一轮导入。失败返回 `{ error }`（闸门不过 / 已在跑 / 找不到源），成功返回完整报告。
 *
 * 为什么在开头**再查一次闸门**：`import:probe` 与用户真点下按钮之间可能隔了很久，用户完全可能在这期间把原版打开了。
 * 那一刻原版可能正在全量重写会话 JSON，读进来就是半截文件。
 */
export async function runImport(
  onProgress?: ProgressFn
): Promise<ImportReport | { error: string }> {
  // 同进程重入：快速拒绝。跨进程（另一个窗口）必须走下面的 acquireLock——那里才能给出锁文件完整路径。
  if (isRunningInProcess()) return { error: '已有导入正在进行，请等它结束。' }
  markRunning(true)
  const home = getDevaHome()
  const lock = acquireLock(home)
  if ('busy' in lock) {
    markRunning(false)
    // 报出完整路径：普通用户不会自己想到去 ~/.deva-plus 找这个文件。
    // 走到这里说明锁里的 pid 指向一个**还活着**的进程（陈旧锁已被 acquireLock 自动清理，不会走到这里）。
    return {
      error: `已有导入正在进行（另一个 DevaPlus 窗口？）。若确认没有在跑，可删除锁文件后重试：${lock.busy}`
    }
  }
  const fd = lock.fd
  const report = emptyReport()
  // 导入期间冻结渲染层的 config:set 回写：它手里是旧快照，整段回写会把刚并入的服务商覆盖掉（P0-2）。
  // 主进程自己的 setConfig 不受影响——它才是这次导入的权威写入方。
  beginConfigHold()
  /**
   * 已从队列里取出、但还没应用的那批补丁。（这里是**唯一**一份存队列的变量：`endConfigHold()` 一取出就存进来，
   * 应用成功后再清空。以前还额外留过一个 `held`，`draining` 取代它之后已无用处。）
   *
   * 为什么要单独留一份：`endConfigHold()` 会 `splice` 出队列并把 holdDepth 归零。若紧接着的
   * `releaseHoldAndRestoreModels(...)` 在应用过程中抛异常，catch 里 `isConfigHeld()` 已经是 false，
   * 这批用户补丁就**直接消失**（既没应用、也没记录）。概率极低，但没有记录比失败更糟。
   */
  let draining: Array<Record<string, unknown>> = []
  // 提升到 try 之外：异常路径也要用它（补回被旧快照覆盖的服务商）。闸门不过时保持空串，那条路径会直接 return。
  let src = ''
  // 用户本轮主动删除的 provider id：补回时排除，读回断言时也不算丢。异常路径下同样要带上。
  let removedIds = new Set<string>()
  // 暂存是否已经收过尾（正常路径或 catch 里各收一次）。finally 据此判断还要不要兜底。
  let settled = false
  try {
    const gate = await canImport()
    if (!gate.ok) {
      // 闸门不过：零写入（连锁都不留，已在上面的 finally 里删）
      return { error: gate.message }
    }
    src = gate.sourceHome || upstreamHome()

    // ① 服务商（含 models.activeModelId 跟随）
    onProgress?.({ step: 'providers', done: 0, total: 0 })
    const providers = mergeProviders(src)
    report.providers = {
      copied: providers.copied,
      skipped: [...providers.skipped, ...providers.kept],
      builtin: providers.builtin,
      failed: providers.failed
    }

    /*
     * ② MCP 服务配置（原版 mcp.json + config.json 的 mcp.enabled）。
     *
     * 为什么排在 copySecrets **之前**：`copySecrets` 判 `mcp:<id>:<field>` 是否「有主」时，
     * 读的是**目标 mcp.json 里真实存在的 id**。若密钥先搬，此刻目标里还没有这些服务，全部会被
     * 判成无主密文丢掉（改前就是这个 bug：MCP 密钥一律 ignored）。把 mcp 步骤放在这里，
     * 顺序依赖就由代码结构本身保证，不需要在 copySecrets 外面传一份可能已过期的 id 列表。
     */
    onProgress?.({ step: 'mcp', done: 0, total: 0 })
    const mcp = importMcp(src)
    report.mcp = { copied: mcp.copied, skipped: mcp.skipped, failed: mcp.failed }

    // 密钥补缺：与原版服务商 / MCP 服务配套的密文（没有密钥的服务等于不能用）。单独计，不混进各自步骤的数字。
    const secrets = await copySecrets(src)
    report.secrets = {
      copied: secrets.copied,
      skipped: secrets.skipped,
      ignored: secrets.ignored,
      noEncryption: secrets.noEncryption,
      invalid: secrets.invalid,
      failed: secrets.failed
    }

    // ③ 角色（md + 头像）
    onProgress?.({ step: 'personas', done: 0, total: 0 })
    const personas = importPersonas(src)
    report.personas = {
      copied: personas.copied,
      skipped: personas.skipped,
      builtin: personas.builtin,
      failed: personas.failed
    }

    // ④ 角色启用态：只对本次新导入的置 true，本地既有开关不动。
    // 自带默认角色若恰好被补了文件，也一并置启用（正常为空——它们首启已由种子写好并启用）。
    const toEnable = [...personas.copied, ...personas.builtinCopied]
    onProgress?.({ step: 'personaEnabled', done: 0, total: toEnable.length })
    const personaEnabled = enableImportedPersonas(toEnable)
    report.personaEnabled = personaEnabled.done
    // 写盘失败率：这一步以前完全没有失败通道（见 enableImportedPersonas 的注释），必须单独汇总
    report.failures.push(...personaEnabled.failures)

    // ⑤ 记忆（全局 + 项目私有，逐条走 writeMemory 受配额约束）
    onProgress?.({ step: 'memories', done: 0, total: 0 })
    const mem = importMemories(src)
    report.memories = {
      added: [...mem.global.added, ...mem.projects.added],
      skipped: [...mem.global.skipped, ...mem.projects.skipped],
      failed: [...mem.global.failed, ...mem.projects.failed]
    }
    report.failures.push(...report.memories.failed)

    // ⑥ 技能（链接按链接重建）
    onProgress?.({ step: 'skills', done: 0, total: 0 })
    const skills = importSkills(src)
    report.skills = {
      copied: [...skills.linked, ...skills.copied],
      skipped: skills.skipped,
      builtin: skills.builtin,
      failed: skills.failed
    }

    // ⑦ 会话（必须早于 ⑧）
    onProgress?.({ step: 'sessions', done: 0, total: 0 })
    const sessions = importSessions(src)
    report.sessions = { copied: sessions.copied, skipped: sessions.skipped, failed: sessions.failed }

    // ⑧ 附件（media 量大，逐个报进度；IPC 侧有节流，见 importer-ipc）
    onProgress?.({ step: 'assoc', done: 0, total: 0 })
    const assoc = copyAssoc(src, (done, total) => onProgress?.({ step: 'assoc', done, total }))
    report.assoc = { ...assoc.assoc, failed: assoc.failures }

    // ⑨ 释放暂存 → 补回被覆盖的成果 → 清缓存 → 通知渲染层。
    onProgress?.({ step: 'cache', done: 0, total: 0 })
    draining = endConfigHold()
    const restored = releaseHoldAndRestoreModels(src, draining)
    report.failures.push(...restored.failures)
    removedIds = restored.removedIds
    // 这段已经跑完，清空队列，确保 catch/finally 不会再跑第二遍（否则用户补丁会被应用两次、补回也跑两次）
    draining = []
    settled = true
    // 刷新会话索引（让导入进来的会话出现在列表里），但**不动 sessionCache**：
    // 清掉它会让「导入期间正在跑的那一轮对话」此后所有 save() 静默 return（聊天记录直接丢）。
    // 详见 invalidateIndexOnly 的注释——这是 P0 级数据丢失，不是性能问题。
    invalidateIndexOnly()
    // 再通知渲染层。三个事件缺一不可：
    //  - sessions-changed：会话列表刷新（渲染层 chat store 早已在监听，但主进程此前从没发过）；
    //  - config:changed：模型/角色列表刷新（它们挂在 config.json 的 models / personas 段上）；
    //  - 放在最后发，让渲染层重载时读到的已经是「暂存已应用 + 成果已补回」的最终态。
    publishSessionsChanged()
    publishConfigChanged({ keys: ['models', 'personas'], source: 'import' })

    /**
     * 读回断言：本轮号称导入的服务商，收尾后是否仍真的在配置里。
     *
     * 这是 2-B 的**不变量检查**，也是唯一能不依赖「窗口有多窄」的判据：不管谁在什么时候用多旧的快照回写，
     * 这里都能发现成果没了。只报不补——补一次会制造「成功」的假象，让这条永远测不出来；该有的失败可见性
     * 比自动补救更重要。
     *
     * 读**内存**（`getConfig()`）而非磁盘：`setConfig` 内部的 `persist()` 是同步的，落盘失败已由
     * `importer-config.ts` 那条报成 `config-write-failed`；读磁盘要新开一条读取路径，还会和
     * `writeFileAtomic` 的 tmp/rename 产生竞态。
     */
    const have = new Set(providersOf(getConfig()).map((p) => p?.id).filter((id): id is string => typeof id === 'string'))
    const expect = [...report.providers.copied, ...(report.providers.builtin ?? [])].filter(
      (id) => !removedIds.has(id) // 用户本轮主动删掉的不算丢
    )
    for (const id of expect) {
      if (!have.has(id)) report.failures.push({ step: 'providers', id, reason: 'imported-provider-missing' })
    }

    // 汇总各步的失败：服务商 / MCP / 密钥 / 角色 / 技能 / 会话 / 附件。记忆、角色启用态在上面各自已推入。
    // 以前只有记忆有失败通道，其余步骤的失败被伪装成 skipped 或直接消失——用户按「导入完成」为准，
    // 丢的会话/图片/服务商永远不会被追查。
    for (const step of [
      report.providers,
      report.mcp,
      report.secrets,
      report.personas,
      report.skills,
      report.sessions,
      report.assoc
    ]) {
      if (step.failed?.length) report.failures.push(...step.failed)
    }

    report.ok = report.failures.length === 0
    onProgress?.({ step: 'done', done: 1, total: 1 })
    return report
  } catch (e) {
    /**
     * 兜底：任何未预料的异常都转成报告里的一条失败，而不是让界面卡在「导入中」。
     *
     * id 用 `<whole-run>` 而不是空串：`Failure.id` 的契约是「能定位到出事的对象」，空串会让界面显示成「—」
     * 且日志里无法检索。整轮级别的异常没有具体对象，用这个占位符明确表达「不是某一条数据的问题」；
     * step 保留 `unknown`（失败发生在哪一步已经无法确定，硬写成某一步会误导排障）。
     */
    report.failures.push({ step: 'unknown', id: '<whole-run>', reason: writeFailureReason(e) })
    report.ok = false
    /**
     * ⚠️ 这里的收尾必须在 finally 之前跑完，否则退出时队列已被 finally 清掉、补回不再发生。
     * 见 releaseHoldAndRestoreModels 的注释：正常路径与异常路径必须走同一份逻辑。
     *
     * 覆盖两种「还没收尾」的形态：
     *  ① 暂存还持有（`isConfigHeld()`）→ 取出队列再应用；
     *  ② 队列已取出但应用前抛了（`draining` 非空、hold 已释放）→ 拿 `draining` 补应用。
     * 漏掉 ② 就是「这批用户补丁直接消失」。
     */
    if (!settled && (isConfigHeld() || draining.length)) {
      if (isConfigHeld()) draining = endConfigHold()
      const restored = releaseHoldAndRestoreModels(src, draining)
      report.failures.push(...restored.failures)
      removedIds = restored.removedIds
      draining = []
      settled = true
    }
    return report
  } finally {
    /**
     * 兜底保险：正常路径与上面的 catch 都已收过尾（settled），走到这里只在一种情况下命中——
     * 收尾本身又抛了异常。此时用 `releaseHoldAndRestoreModels` 而非裸 `applyHeldPatches`：
     * 后者不补 `mergeProviders`、不通知渲染层，等于给「成果被覆盖」留了最后一条窄缝。
     * 代价一样（一次读源 config.json），行为与主路径一致。
     *
     * 这里**不能 return / 不能影响已算好的报告**：report 已经返回给调用方了（正常路径 return 在前面），
     * 这条路径只负责把状态收拾干净。
     */
    if (!settled && (isConfigHeld() || draining.length)) {
      if (isConfigHeld()) draining = endConfigHold()
      const drained = draining
      try {
        const restored = releaseHoldAndRestoreModels(src, draining)
        // 补回可能改了 models（并入了服务商），渲染层该重载。主路径在收尾后发过一次，这条路径也要发
        // ——否则用户补丁已被应用、界面还显示旧列表。
        // 前提是「真的取到了补丁」：闸门不过时队列本来就是空的，广播一次空事件只会让渲染层白重载。
        if (drained.length) publishConfigChanged({ keys: ['models', 'personas'], source: 'import' })
        if (restored.failures.length) {
          console.warn('[import] 兜底收尾有失败（报告已返回，无法再追加）：', JSON.stringify(restored.failures))
        }
      } catch (e) {
        // 报告已经返回给调用方了，没有通道能追加失败。至少留痕：这条路径只会在「收尾本身抛异常」时命中。
        console.warn('[import] 兜底收尾失败：', (e as Error)?.message ?? e)
      }
      draining = []
      settled = true
    }
    releaseLock(home, fd)
    markRunning(false)
  }
}
