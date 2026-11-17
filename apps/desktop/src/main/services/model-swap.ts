import { activeMembers } from './members'
import { markMemberSetting } from './chat-members'
import { getSession, save as saveProject } from './chat-store'
import { syncTaskModel } from './tasks'
import { resolveAvailability, isUsableRef } from './model-availability'
import type {
  AvailabilityKind,
  BrokenRef,
  ModelSwapResult
} from '../../shared/chat-protocol'
import { isEn } from '../locale'
/**
 * 模型引用的批量替换（主进程）。
 *
 * 痛点：会话的模型是**各自快照**的一个引用字符串（见 chat-store StoredSession.model），成员会话在建时、派任务时
 * 还会各同步一份。于是一个模型被删 / 服务商被禁用 / 密钥丢了，用户得逐个进成员会话换一遍，没有批量手段。
 *
 * 核心规则：**只换引用恰好相等的会话**（`session.model === fromRef`）。模型引用是每会话一个字符串，按字符串
 * 相等比对就能精确命中，不存在歧义——用户单独给某成员指定过的模型其引用是别的值，天然被排除，既不需要额外的
 * 「范围选择器」，也不需要记「谁跟随谁」。
 *
 * 候选范围 = 主对话 + 它名下未移除的成员会话。子智能体不在范围内：它们恒继承父轮模型、没有独立记录，也就没有
 * 可替换的引用（见 agent-loop 的子智能体参数）。
 */

/** 候选会话：id、界面上叫它什么、当前的模型引用。 */
interface Candidate {
  id: string
  name: string
  ref: string
}

/**
 * 本对话可被替换的会话（主对话 + 未移除成员）。name 在这里就填好——成员名与对话标题都在主进程的会话里，
 * 让渲染层再查一遍只会多出一条两边可能不一致的取名字规则。
 * 成员会话文件已丢失（成员名单残留）的跳过：没有会话就没有可写的地方。
 */
function candidatesOf(mainId: string): Candidate[] {
  // 入参来自渲染层：不是字符串就当「没有这个对话」，别让 safeId(undefined) 之类在深处抛出来。
  if (typeof mainId !== 'string' || !mainId) return []
  const main = getSession(mainId)
  if (!main) return []
  const list: Candidate[] = [
    { id: main.id, name: main.title || (isEn() ? 'New chat' : '新对话'), ref: main.model ?? '' }
  ]
  for (const m of activeMembers(main.members)) {
    const sub = getSession(m.sessionId)
    if (sub) list.push({ id: sub.id, name: m.name, ref: sub.model ?? '' })
  }
  return list
}

/**
 * skipped 里的 kind 语义：该会话**自身**引用确实失效就用它自己的（信息更准，界面可提示「它自己也坏了，但引用
 * 不同，没一起换」）；自身可用则填本次要换掉的那一类——一条 skipped 记录总要带个 kind（BrokenRef 的形状），
 * 这时它表示的是「这次换的是哪类坏引用，这一项不在其中」，**不代表该会话不可用**，界面别据此给它打红标。
 */
function kindOf(own: AvailabilityKind | undefined, fallback: AvailabilityKind): AvailabilityKind {
  return own ?? fallback
}

/**
 * 列出本对话里模型引用已失效的会话（主对话 + 未移除成员）。只读，供界面挂载时标红与列出受影响清单。
 * 空引用的会话不会出现：空 = 尚未定格模型（跟随全局默认），交给 runTurn 兜底，不算引用了失效模型。
 */
export async function scanSessionsByModel(mainId: string): Promise<BrokenRef[]> {
  const out: BrokenRef[] = []
  for (const c of candidatesOf(mainId)) {
    const a = await resolveAvailability(c.ref)
    if (!a.ok && a.kind) out.push({ sessionId: c.id, name: c.name, ref: c.ref, kind: a.kind })
  }
  return out
}

/**
 * 把本对话里所有引用 `fromRef` 的会话改成 `toRef`。引用不同的原样跳过（含空串的「跟随」状态——那不是引用了
 * 失效模型，不该被顺手钉死）。
 *
 * 先验目标引用：目标不可用就整批拒绝、一个都不改（不做半截替换——那会让用户以为换完了，实际只换了一部分）。
 * 改动的每个会话各自落盘（一对话一文件的写法，见 chat-store.save），**并检查落盘结果**：写不进去的会话
 * 回滚内存态、记进 `failed`，绝不混进 `changed`（否则界面报「已替换 N 个」，重启后全部变回）。
 */
export async function applyModelSwap(p: {
  mainId: string
  fromRef: string
  toRef: string
}): Promise<ModelSwapResult | { error: string }> {
  const from = typeof p.fromRef === 'string' ? p.fromRef.trim() : ''
  const to = typeof p.toRef === 'string' ? p.toRef.trim() : ''
  // 候选为空 = 主对话不存在（主对话在，候选至少有一项）。入参来自渲染层，mainId 非字符串也走这一条，
  // 免得 getSession(undefined) 在深处抛出来。
  const cands = candidatesOf(p.mainId)
  if (!cands.length) return { error: isEn() ? 'This chat no longer exists.' : '对话不存在。' }
  // 没有「坏引用」可换：空串是跟随状态，用户要换的是「哪个模型坏了」，不是把这个状态清掉。
  if (!from) return { error: isEn() ? 'No broken model to replace.' : '没有要替换的失效模型。' }
  // 目标必须是个具体模型：isUsableRef('') 为真（空 = 跟随默认，见 model-availability），若照它放行就会把一批会话
  // 改成空串——那是本次不做引入的「跟随默认」状态，用户点的也不是这个意思。
  if (!to) return { error: isEn() ? 'Pick a model to switch to.' : '请选择要换成哪个模型。' }
  if (!(await isUsableRef(to)))
    return {
      error: isEn()
        ? 'The target model is not available. Pick another one.'
        : '目标模型不可用，请换一个。'
    }
  const fromKind = (await resolveAvailability(from)).kind
  const changed: BrokenRef[] = []
  const skipped: BrokenRef[] = []
  // 写盘失败的那些：进这里而不是 changed——界面据此说「这几个没换成」，别混进成功数
  const failed: BrokenRef[] = []
  for (const c of cands) {
    // 空引用 = 尚未定格模型（跟随全局默认）：它根本没引用任何具体模型，替换它只会凭空钉死一个模型，
    // 故既不替换也不计进 skipped（那会让界面上的「跳过 M 个」混进一堆本来就没坏、也没让用户单独指定过的会话）。
    if (!c.ref) continue
    const session = getSession(c.id)
    if (!session) continue
    if (c.ref !== from) {
      // 引用不同（用户单独给它指定过别的模型）：原样保留，只回报。
      skipped.push({
        sessionId: c.id,
        name: c.name,
        ref: c.ref,
        kind: kindOf((await resolveAvailability(c.ref)).kind, fromKind ?? 'missing')
      })
      continue
    }
    session.model = to
    /*
     * 写盘结果必须检查：以前无条件 `changed.push()`，磁盘满 / 被占 / 权限错时内存改了、磁盘没改，
     * 界面报「已替换 N 个」，重启后全部变回，零提示（P1-2，与 setEnabled 那批同形）。
     *
     * 失败的会话要**回滚内存**：`getSession` 走 `loadSessionFile`，返回的是缓存里的同一个对象，
     * 不回滚的话界面刷新一次又会从内存读到新模型，用户以为换成了，实际磁盘还是旧值。
     */
    const wrote = saveProject(c.id)
    if (!wrote) {
      session.model = from
      failed.push({ sessionId: c.id, name: c.name, ref: from, kind: fromKind ?? 'missing' })
      continue
    }
    // 与用户在输入框里换模型（chat:set-model）走同一套后果，否则这次替换会被下一次活动静默改回去：
    //  · 任务对话：任务也跟着换（否则下一次定时运行又用旧模型，且任务与对话两边不一致）；
    //  · 成员会话：记为「用户亲自定过模型」（modelSet），此后派任务不再按主对话覆盖——否则主智能体下一次派任务就
    //    把这里刚换好的值覆盖回主对话的引用，用户以为批量换成功了，实际只在下次派任务前有效。用户点批量替换
    //    就是在为这些会话定模型，语义与亲手逐个换一致。
    syncTaskModel(c.id, to)
    markMemberSetting(session, 'modelSet')
    changed.push({ sessionId: c.id, name: c.name, ref: from, kind: fromKind ?? 'missing' })
  }
  return { changed, skipped, failed }
}
