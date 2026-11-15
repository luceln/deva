import { getDevaHome } from './services/config'
import { invalidateIndex } from './services/chat-store'
import { canImport, upstreamHome } from './importer-gate'
import { copySecrets, mergeProviders } from './importer-config'
import { enableImportedPersonas, importPersonas } from './importer-personas'
import { importMemories } from './importer-memory'
import { importSkills } from './importer-skills'
import { importSessions } from './importer-sessions'
import { copyAssoc } from './importer-assoc'
import { acquireLock, isRunningInProcess, markRunning, releaseLock } from './importer-lock'
import type { ImportProgress, ImportReport } from '../shared/import-protocol'

/**
 * 「从原版 Deva 导入数据」总控（主进程）。
 *
 * 定位：**一次性导入**，不是持续同步。只补 DevaPlus 没有的，已存在的一律跳过，判断依据只有 id / 文件名
 * （不看 mtime、不比较内容）→ 天然幂等，点多少次结果一致。原版 `~/.deva` 全程只读。
 *
 * **手动触发**，绝不塞进启动路径：导入是重操作（上百 MB、要动用户数据），不该在用户不知情时发生。
 *
 * 八步顺序固定，其中 ⑥ 会话必须早于 ⑦ 附件（否则启动清扫会把「还没有会话引用」的附件当垃圾删掉，见 importer-assoc）：
 *   ① 服务商 ② 角色 ③ 角色启用态 ④ 记忆 ⑤ 技能 ⑥ 会话 ⑦ 附件 ⑧ 清缓存
 *
 * 不吞错：单条失败不中断整轮（记进 failures 继续），但整轮 ok = failures 为空，界面必须把 failures 逐条显示出来。
 */

type ProgressFn = (p: ImportProgress) => void

/** 空报告的骨架（每步都先给空数组，缺字段的界面渲染会炸）。 */
function emptyReport(): ImportReport {
  return {
    ok: true,
    providers: { copied: [], skipped: [] },
    secrets: { copied: [], skipped: [] },
    personas: { copied: [], skipped: [] },
    personaEnabled: [],
    memories: { added: [], skipped: [], failed: [] },
    skills: { copied: [], skipped: [] },
    sessions: { copied: [], skipped: [] },
    assoc: { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 },
    failures: []
  }
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
  try {
    const gate = await canImport()
    if (!gate.ok) {
      // 闸门不过：零写入（连锁都不留，已在上面的 finally 里删）
      return { error: gate.message }
    }
    const src = gate.sourceHome || upstreamHome()

    // ① 服务商（含 models.activeModelId 跟随）
    onProgress?.({ step: 'providers', done: 0, total: 0 })
    const providers = mergeProviders(src)
    report.providers = { copied: providers.copied, skipped: [...providers.skipped, ...providers.kept] }
    // 密钥补缺：与原版服务商配套的密文（没有密钥的服务商等于不能用）。单独计，不混进 providers 的数字。
    const secrets = await copySecrets(src)
    report.secrets = { copied: secrets.copied, skipped: secrets.skipped }

    // ② 角色（md + 头像）
    onProgress?.({ step: 'personas', done: 0, total: 0 })
    const personas = importPersonas(src)
    report.personas = { copied: personas.copied, skipped: personas.skipped }

    // ③ 角色启用态：只对本次新导入的置 true，本地既有开关不动
    onProgress?.({ step: 'personaEnabled', done: 0, total: personas.copied.length })
    report.personaEnabled = enableImportedPersonas(personas.copied)

    // ④ 记忆（全局 + 项目私有，逐条走 writeMemory 受配额约束）
    onProgress?.({ step: 'memories', done: 0, total: 0 })
    const mem = importMemories(src)
    report.memories = {
      added: [...mem.global.added, ...mem.projects.added],
      skipped: [...mem.global.skipped, ...mem.projects.skipped],
      failed: [...mem.global.failed, ...mem.projects.failed]
    }
    report.failures.push(...report.memories.failed)

    // ⑤ 技能（链接按链接重建）
    onProgress?.({ step: 'skills', done: 0, total: 0 })
    const skills = importSkills(src)
    report.skills = { copied: [...skills.linked, ...skills.copied], skipped: skills.skipped }

    // ⑥ 会话（必须早于 ⑦）
    onProgress?.({ step: 'sessions', done: 0, total: 0 })
    const sessions = importSessions(src)
    report.sessions = { copied: sessions.copied, skipped: sessions.skipped }

    // ⑦ 附件（media 量大，逐个报进度；IPC 侧有节流，见 importer-ipc）
    onProgress?.({ step: 'assoc', done: 0, total: 0 })
    report.assoc = copyAssoc(src, (done, total) => onProgress?.({ step: 'assoc', done, total }))

    // ⑧ 清缓存：不重启也能看见新会话（两个内存缓存 + 索引文件）
    onProgress?.({ step: 'cache', done: 0, total: 0 })
    invalidateIndex()

    report.ok = report.failures.length === 0
    onProgress?.({ step: 'done', done: 1, total: 1 })
    return report
  } catch (e) {
    // 兜底：任何未预料的异常都转成报告里的一条失败，而不是让界面卡在「导入中」
    report.failures.push({ step: 'unknown', id: '', reason: (e as Error)?.message ?? String(e) })
    report.ok = false
    return report
  } finally {
    releaseLock(home, fd)
    markRunning(false)
  }
}
