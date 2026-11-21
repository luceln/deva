import { activeMembers } from './members'
import { markMemberSetting } from './chat-members'
import { getSession, saveOutcome, type StoredSession } from './chat-store'
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
 * 核心规则：**只换「归一后相等」的会话**（见 `normalizeRef`：`" p:m "` 与 `"p:m"` 视为同一个模型）。
 * 模型引用是每会话一个字符串，按归一后的字符串比对就能精确命中，不存在歧义——用户单独给某成员指定过的模型
 * 其引用归一后也是别的值，天然被排除，既不需要额外的「范围选择器」，也不需要记「谁跟随谁」。
 *
 * 为什么要归一而不是直接 `===`：会话里存的值可能是导入来的 / 手改配置留下的带首尾空格，而界面传来的 `fromRef`
 * 是规范值。直接比原始字符串会让这种会话被判成「用的是别的模型」——标红了却永远换不掉（A24/A25）。
 * 归一**只用于比较**，不改会话里的原始值。
 *
 * 候选范围 = 主对话 + 它名下未移除的成员会话。子智能体不在范围内：它们恒继承父轮模型、没有独立记录，也就没有
 * 可替换的引用（见 agent-loop 的子智能体参数）。
 */

/** 候选会话：id、界面上叫它什么、当前的模型引用。 */
interface Candidate {
  id: string
  name: string
  ref: string
  /** 成员会话所属的主对话 id；主对话本身为 undefined。提交前据此复核成员是否仍未移除。 */
  memberOf?: string
  /**
   * 拍快照时**那个会话对象本身**（P2-9）。提交前用它验「还是同一个会话」，而不只是「有个会话叫这个名字」。
   *
   * 为什么必须有它：`sessionId` 不是身份。任务对话的 id 由任务决定（`task-<id>`），删掉后任务再触发会
   * **用同一个 id 重建**，新会话的 model 引用也可能与旧的一模一样。此时只比 id 与 model 字符串，旧替换就会
   * 恢复并作用到这个刚建出来的对话上——用户看到的是「我删了它，它却带着新模型又回来了」。
   */
  session: StoredSession
}

/**
 * 本对话可被替换的会话（主对话 + 未移除成员）。name 在这里就填好——成员名与对话标题都在主进程的会话里，
 * 让渲染层再查一遍只会多出一条两边可能不一致的取名字规则。
 * 成员会话文件已丢失（成员名单残留）的跳过：没有会话就没有可写的地方。
 */

/**
 * 测试专用：在逐条提交**之前**插一个可控的 await 间隙，用来复现「检查通过后、落盘前用户改了模型」的竞态。
 * 生产代码不设置它（`grep -rn setModelSwapCommitHookForTest src/main` 只应命中本处与定义）。
 */
let commitHookForTest: (() => Promise<void>) | null = null
export function setModelSwapCommitHookForTest(hook: (() => Promise<void>) | null): void {
  commitHookForTest = hook
}
function candidatesOf(mainId: string): Candidate[] {
  // 入参来自渲染层：不是字符串就当「没有这个对话」，别让 safeId(undefined) 之类在深处抛出来。
  if (typeof mainId !== 'string' || !mainId) return []
  const main = getSession(mainId)
  if (!main) return []
  const list: Candidate[] = [
    {
      id: main.id,
      name: main.title || (isEn() ? 'New chat' : '新对话'),
      ref: main.model ?? '',
      session: main
    }
  ]
  for (const m of activeMembers(main.members)) {
    const sub = getSession(m.sessionId)
    if (sub) list.push({ id: sub.id, name: m.name, ref: sub.model ?? '', memberOf: main.id, session: sub })
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
 * 引用归一：**只用于比较**，绝不写回会话。
 *
 * 会话里存的 `model` 是快照字符串，导入来的 / 手改过配置的值可能带首尾空格（`" ollama:qwen3 "`）。
 * `resolveAvailability` 内部 `splitRef` 会把两段各自 trim，所以这种值**能正常解析**、也会被正确标红；
 * 但 `applyModelSwap` 以前拿 trim 过的 `from` 去跟**没 trim 的** `c.ref` 做 `!==`，于是同一个模型被判成
 * 「用的是别的模型」，落进 skipped 永远换不掉（A24/A25）。
 *
 * 语义：`normalizeRef(x) === normalizeRef(y)` ⇔ 这两个值引用的是同一个模型。
 * 值本身不改——那是用户数据，替换时只重写被替换的那一条。
 */
function normalizeRef(ref: string): string {
  return ref.trim()
}

/**
 * 列出本对话里模型引用已失效的会话（主对话 + 未移除成员）。只读，供界面挂载时标红与列出受影响清单。
 * 空引用（含只有空白）的会话不会出现：空 = 尚未定格模型（跟随全局默认），交给 runTurn 兜底，不算引用了失效模型。
 */
export async function scanSessionsByModel(mainId: string): Promise<BrokenRef[]> {
  const out: BrokenRef[] = []
  for (const c of candidatesOf(mainId)) {
    // 只有空白的引用与空串同义（跟随默认），别把它当「引用了坏模型」
    if (!normalizeRef(c.ref)) continue
    const a = await resolveAvailability(c.ref)
    if (!a.ok && a.kind)
      // ref 原样上报（界面要显示用户实际存的值），判定用的是归一后的等价性
      out.push({ sessionId: c.id, name: c.name, ref: c.ref, kind: a.kind })
  }
  return out
}

/**
 * 把本对话里所有引用 `fromRef` 的会话改成 `toRef`。**按归一后的引用比对**（见 normalizeRef）：
 * 会话里存的 `" ollama:qwen3 "` 与界面传来的 `"ollama:qwen3"` 是同一个模型，必须能一起换掉——
 * 以前直接 `!==` 比原始字符串，这种值永远换不掉，还被解释成「它用的是别的模型」（A24）。
 *
 * 引用确实不同的原样跳过（含空串的「跟随」状态——那不是引用了失效模型，不该被顺手钉死），
 * 但 skipped 的**解释必须对**：它真的是另一个模型才算「本来就不同」（A25）。
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
  const fromRaw = typeof p.fromRef === 'string' ? p.fromRef : ''
  const from = normalizeRef(fromRaw)
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
  // 主文件已落盘、只有索引待重建：不是失败，但要能看出来
  const indexStale: BrokenRef[] = []
  // 逐条提交前的复核发现状态已变（用户在上一项写盘期间换了模型 / 移除了成员）：放弃这次提交，
  // 保留用户的新选择。它不是「写盘失败」，所以单列，界面上可以按「跳过」讲，但原因不同。
  const superseded: BrokenRef[] = []
  /*
   * 主文件已写成新模型，但**关联绑定没落实**（任务记录 / 成员名单没存下去）。
   *
   * 不清成 failed（主文件的模型确实换了、磁盘也不回滚），也不进 changed（否则用户以为完全成功，
   * 而重启后派任务会用主对话的模型把它改回去）。单列出来，界面据实说「已换，但绑定没存下去」。
   */
  const unbound: BrokenRef[] = []
  for (const c of cands) {
    // 空引用（含只有空白）= 尚未定格模型（跟随全局默认）：它根本没引用任何具体模型，替换它只会凭空钉死一个模型，
    // 故既不替换也不计进 skipped（那会让界面上的「跳过 M 个」混进一堆本来就没坏、也没让用户单独指定过的会话）。
    if (!normalizeRef(c.ref)) continue
    /*
     * ⚠️ 复核放在**每一项的 await 之后、写盘之前**（P2-⑥）。
     *
     * `c` 是进入循环前拍的快照。上一项里的 `await resolveAvailability(...)` / `isUsableRef` 有真实异步间隙；
     * 用户很可能在这期间切了模型、或把某个成员移除。旧实现直接拿快照 `c.ref` 与 `from` 比、然后把 `to`
     * 写进 `session.model`——既盖掉用户刚选的新模型，也给已移除的成员写值（之后主对话派任务又会把它改回来，
     * 用户看到的就是「批量替换部分失效」）。
     *
     * 现在每次提交前重新读：会话还在吗、是不是同一份（缓存对象）、当前模型引用是否仍等于快照、成员是否仍未移除。
     * 任一不成立就放弃**这一项**（不影响其它项），并把当前真实引用如实报出来。
     */
    await commitHookForTest?.()
    const session = getSession(c.id)
    if (!session) {
      // 会话文件在提交前消失：没有可写的地方，也不算「用户换了模型」
      continue
    }
    /*
     * ⚠️ 必须是**同一个会话对象**（P2-9）。`getSession` 走 `loadSessionFile`，会话被删掉后重建会得到
     * 一个新对象，即使 id 与 model 引用都与快照一模一样。那种情况下不能把 `to` 写进去——那等于让这次替换
     * 作用到用户刚新建的对话上（典型：任务对话 `task-<id>` 删掉后任务再触发、以同 id 重建）。
     */
    if (session !== c.session) {
      superseded.push({
        sessionId: c.id,
        name: c.name,
        ref: session.model ?? '',
        kind: fromKind ?? 'missing'
      })
      continue
    }
    const currentRef = session.model ?? ''
    if (normalizeRef(currentRef) !== normalizeRef(c.ref)) {
      // 用户已改过这个会话的模型：保留他的新选择，本次不再覆盖
      superseded.push({
        sessionId: c.id,
        name: c.name,
        ref: currentRef,
        kind: fromKind ?? 'missing'
      })
      continue
    }
    if (c.memberOf) {
      /*
       * 成员会话：提交前必须确认它仍在主对话的成员名单里且未被移除。名单在异步间隙里可能已经变了，
       * 拿旧快照写进去等于给「已经不存在的成员」改模型。
       */
      const main = getSession(c.memberOf)
      const stillMember = !!main && activeMembers(main.members).some((m) => m.sessionId === c.id)
      if (!stillMember) {
        superseded.push({
          sessionId: c.id,
          name: c.name,
          ref: currentRef,
          kind: fromKind ?? 'missing'
        })
        continue
      }
    }
    // 归一后比：`" p:m "` 与 `"p:m"` 是同一个模型，必须一起换（A24）
    if (normalizeRef(c.ref) !== from) {
      /*
       * 真的引用了别的模型：原样保留、只回报（A25）。
       * kind 优先取它自己的判定结果——若它自己也坏了，界面上那一条要说清是它自己的原因，别沿用本次的 fromKind。
       */
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
    const wrote = saveOutcome(c.id)
    if (wrote === 'not-saved') {
      // 主文件确实没写：回滚成**原始值**（c.ref），不是 trim 后的 from（归一化只用于比较，不许改用户数据）
      session.model = c.ref
      failed.push({ sessionId: c.id, name: c.name, ref: c.ref, kind: fromKind ?? 'missing' })
      continue
    }
    /*
     * `saved-index-stale`：主 JSON 已原子写入，只有派生索引没落盘（`ensureIndex()` 下次读会扫目录重建）。
     *
     * 这里**绝不能回滚内存、也不能计进 failed**（P2-⑦ 的正是这个反向错误）：磁盘上已经是新模型，
     * 回滚只会让界面显示旧值而磁盘是新值；报失败则会让用户以为没换成。但要如实让上层知道索引待重建，
     * 所以记进 `indexStale`——它不是失败，只是「列表刷新一次才稳」。
     */
    if (wrote === 'saved-index-stale') indexStale.push({ sessionId: c.id, name: c.name, ref: c.ref, kind: fromKind ?? 'missing' })
    // 与用户在输入框里换模型（chat:set-model）走同一套后果，否则这次替换会被下一次活动静默改回去：
    //  · 任务对话：任务也跟着换（否则下一次定时运行又用旧模型，且任务与对话两边不一致）；
    //  · 成员会话：记为「用户亲自定过模型」（modelSet），此后派任务不再按主对话覆盖——否则主智能体下一次派任务就
    //    把这里刚换好的值覆盖回主对话的引用，用户以为批量换成功了，实际只在下次派任务前有效。用户点批量替换
    //    就是在为这些会话定模型，语义与亲手逐个换一致。
    //
    // ⚠️ 两处结果都必须看（P2-10）：主文件写成功了，但**绑定没落实**时，重启后派任务会把它改回去。
    // 这不是「写盘失败」（主文件的模型确实已经是新值），也不能算完整成功，故单列 `unbound`。
    const taskBound = syncTaskModel(c.id, to)
    const memberBound = markMemberSetting(session, 'modelSet')
    const entry = { sessionId: c.id, name: c.name, ref: c.ref, kind: fromKind ?? 'missing' }
    if (!taskBound || !memberBound) {
      unbound.push(entry)
      continue
    }
    changed.push(entry)
  }
  return { changed, skipped, failed, indexStale, superseded, ...(unbound.length ? { unbound } : {}) }
}
