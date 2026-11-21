/**
 * 输入框工具条右侧的模型区：上下文圆环、模型、思考等级三个贴片，各自弹出一个只做一件事的菜单，同一时间只开一个。
 *
 * - 上下文圆环（ContextRing.tsx）：灰色、不带数字，点开看已用/窗口与进度条；没有读数（新对话、模型已删）时不出现。
 * - 模型：只写模型名（不放服务商色点）；点开是全部模型按服务商分组平铺（ModelMenu.tsx），点一下即切换并收起。
 *   已启用服务商的密钥用不了时，菜单里把其名下的模型标成不可选（blocked）。
 * - 思考等级（EffortPicker.tsx）：灯泡 + 档位；模型不支持思考等级时不出现。
 *
 * 切换语义：只改本对话并立即落库（setSessionModel / setSessionEffort），同时记为「最近使用」
 * （setActiveModel / setActiveEffort），新对话未选时沿用最近使用。显示的是本对话生效模型：
 * 本对话已选 → 否则回落最近使用（与主进程 resolveModelRef 的兜底一致）。
 *
 * ## 失效标红 + 批量替换（二开专有，上游这条线没有这块功能）
 *
 * 解析不到（模型被删 / 服务商或模型被停用 / 缺密钥 / 引用本身坏了）**不再静默回落**：模型贴片标红、
 * 文案换成「模型不可用」/「缺少密钥」、右侧挂受影响会话数，点它直接打开批量替换对话框——用户此刻
 * 唯一要处理的就是它，再弹常规模型菜单只会多一层。是否失效一处都不在这里算：结论来自主进程的 scan
 * （store 的 brokenModels），渲染层自己按 providers 推一遍必然与主进程漂移。
 *
 * ⚠️ **批量替换的范围固定在打开那一刻**（`swapTarget = { mainId, fromRef }`，见 `03bbff0`）：替换动作
 * 返回结果前会清空并重扫失效缓存、列表刷新期间 `broken` 会瞬间变成 `false`。若弹窗的开关直接绑在
 * `broken` 上，它会在用户看到结果之前自己消失——所以打开时把引用固定成一份快照，弹窗只看这份快照。
 * `indexStale` / `superseded` / `failed` 的逐项结果由 ModelSwapDialog 渲染，与这份快照无关，因此
 * 缓存清空、列表刷新、重扫期间结果的可见性不受影响。
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { BrokenRef } from '../store/modelSwap'
import { loadBlockedProviders } from '../store/modelSwap'
import { useChatActions, useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { useI18n } from '../i18n/i18n'
import { ContextRing } from './ContextRing'
import { EffortPicker } from './EffortPicker'
import { ModelMenu, type ModelGroup } from './ModelMenu'
import { ModelSwapDialog } from './ModelSwapDialog'
import { useContextUsage } from './context-usage'
import './model-panel.css'

type Menu = 'context' | 'model' | 'effort'

export function ModelPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel, providers, setActiveModel, activeEffort, setActiveEffort } = useModels()
  const { currentBinding, currentSessionId, sessions, brokenModels } = useChatState()
  const { setSessionModel, setSessionEffort } = useChatActions()
  const [open, setOpen] = useState<Menu | null>(null)
  /** 批量替换对话框打开时的引用快照；null = 未打开。**不随 broken 变化**（见文件头说明）。 */
  const [swapTarget, setSwapTarget] = useState<{ mainId: string; fromRef: string } | null>(null)
  const toggle = (m: Menu): void => setOpen((o) => (o === m ? null : m))

  // 只列对话模型（purpose==='llm'）：决策模型（如 Jev）不生成文本，绝不可被选为对话模型。
  const groups: ModelGroup[] = providers
    .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0)
  const active = findActive(providers, currentBinding.model ?? null) ?? activeModel
  const modelRef = active ? `${active.provider.id}:${active.model.id}` : null
  const usage = useContextUsage(
    currentSessionId,
    modelRef,
    `${active?.model.contextWindow ?? ''}|${active?.model.maxOutput ?? ''}`,
    sessions.find((s) => s.id === currentSessionId)?.updatedAt
  )
  const hasUsage = !!active && !!usage && usage.used != null
  const broken = brokenInfoOf(
    mainIdOf(sessions, currentSessionId),
    currentSessionId,
    currentBinding.model,
    brokenModels
  )
  const blocked = useBlockedProviders(open === 'model')

  // 「密钥用不了」的服务商最后还要与 broken 里的 nokey / keyunreadable 取并集（见模型菜单）：
  // 全量那份是 IPC 回来的，与「刚改完配置」之间有短暂时差，并上 scan 结论才不漏。
  const blockedIds = useMemo(() => {
    const cur = new Set(blocked)
    for (const b of brokenModels[mainIdOf(sessions, currentSessionId)] ?? []) {
      if (b.kind !== 'nokey' && b.kind !== 'keyunreadable') continue
      const pid = b.ref.slice(0, Math.max(0, b.ref.indexOf(':')))
      if (pid) cur.add(pid)
    }
    return cur
  }, [blocked, brokenModels, sessions, currentSessionId])

  // 换了对话就收起；读数没了（如删轮后）时，开着的卡片也跟着收起。
  useEffect(() => setOpen(null), [currentSessionId])
  useEffect(() => {
    if (!hasUsage) setOpen((o) => (o === 'context' ? null : o))
  }, [hasUsage])

  // Esc 收起。失效态下开着的是替换对话框，Esc 由它自己的 Modal 处理。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const modelName = active ? active.model.name : t('chat.selectModel')
  return (
    <div className="cf-mp">
      {open && <div className="model-pick__backdrop" onClick={() => setOpen(null)} />}
      {hasUsage && usage && (
        <ContextRing usage={usage} open={open === 'context'} onToggle={() => toggle('context')} />
      )}
      <div className="model-pick">
        {broken.broken ? (
          // 失效：贴片换成红色 / 警示色，点击直接开批量替换（不弹常规模型菜单）。
          // 沿用上游的 chip 样式类（cf-mp__chip），不引入旧面板视觉。
          <BrokenChip
            broken={broken}
            onToggle={() => {
              setOpen(null)
              setSwapTarget({ mainId: broken.mainId, fromRef: broken.swapFromRef })
            }}
          />
        ) : (
          <button
            className={`chip cf-mp__chip${open === 'model' ? ' is-open' : ''}`}
            type="button"
            title={open === 'model' ? undefined : modelName}
            aria-label={modelName}
            aria-haspopup="menu"
            aria-expanded={open === 'model'}
            onClick={() => toggle('model')}
          >
            <span className="chip__label">{modelName}</span>
            <ChevronDown size={13} className="chip__caret" />
          </button>
        )}
        {/* 替换 action 在返回结果前会清空并重扫失效缓存；弹窗范围固定为打开时的引用。 */}
        {swapTarget && <ModelSwapDialog {...swapTarget} onClose={() => setSwapTarget(null)} />}
        {!broken.broken && open === 'model' && (
          <ModelMenu
            groups={groups}
            activePid={active?.provider.id ?? null}
            activeMid={active?.model.id ?? null}
            blocked={blockedIds}
            onPick={(pid, mid) => {
              // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话未选时的默认。
              setSessionModel(`${pid}:${mid}`)
              setActiveModel(pid, mid)
              setOpen(null)
            }}
          />
        )}
      </div>
      <EffortPicker
        active={active}
        stored={currentBinding.effort ?? activeEffort}
        open={open === 'effort'}
        onToggle={() => toggle('effort')}
        onPick={(lv) => {
          setSessionEffort(lv)
          setActiveEffort(lv)
          setOpen(null)
        }}
      />
    </div>
  )
}

/**
 * 失效态的模型贴片：危险色（真坏）或警示色（只是密钥的事）+ 一句话 + 受影响会话数徽标。
 *
 * 为什么分两色：`nokey` / `keyunreadable` 是「去设置里填一下密钥就好」，读成「这对话坏了」会让人以为
 * 得换模型；而真坏（模型被删 / 服务商停用 / 引用非法）就该被读成「现在不能用」。徽标恒显示——一个会话
 * 都不受影响时根本走不到这里，有红标就说明至少一处。
 */
function BrokenChip({ broken, onToggle }: { broken: BrokenInfo; onToggle: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const hint = t('cf.modelSwap.brokenHint').replace('{n}', String(broken.count))
  return (
    <button
      className={`chip cf-mp__chip is-broken${broken.onlyNoKey ? ' is-nokey' : ''}`}
      type="button"
      title={hint}
      aria-label={hint}
      onClick={onToggle}
    >
      <span className="chip__label">{broken.onlyNoKey ? t('cf.modelSwap.noKey') : t('cf.modelSwap.broken')}</span>
      <span className="chip__badge">{broken.count}</span>
    </button>
  )
}

interface BrokenInfo {
  /** 本会话的模型是否已失效。 */
  broken: boolean
  /** 批量替换的范围：本对话（看成员会话时是它所属的主对话）。 */
  mainId: string
  /** 本对话 + 名下成员里受影响的会话数。 */
  count: number
  /** 本次要换掉的引用：优先本会话自己指向的那个，对不上再退回扫描结果第一条。 */
  swapFromRef: string
  /** 失效原因**全部**只是「密钥的事」：用警示色而非危险色。 */
  onlyNoKey: boolean
}

/**
 * 当前会话所属的主对话 id：成员会话不进 sessions 列表（名单挂在主对话上），得反查。
 * 与 ChatFirstShell 的 memberOf 同法；批量替换的范围也是「主对话 + 名下成员」，与主进程 scan 的口径一致。
 */
export function mainIdOf(sessions: { id: string; members?: { sessionId: string }[] }[], currentSessionId: string): string {
  return sessions.find((s) => s.members?.some((m) => m.sessionId === currentSessionId))?.id ?? currentSessionId
}

/**
 * 本会话的模型是否已失效。
 *
 * 只认主进程 scan 的结论（store 的 brokenModels），不在渲染层按 providers 复算。悬空的引用可能没人登记在
 * 本会话上（缓存里没有本会话的 sessionId 时也不标红），此时宁可保持原样——拿不到结论就标红，会把用户
 * 赶去换一个本来好好的模型。
 *
 * 纯函数（无 hook），导出是为了让 QA 脚本能直接跑真逻辑做断言，而不是只在浏览器里验一遍。
 */
export function brokenInfoOf(
  mainId: string,
  currentSessionId: string,
  boundModelRef: string | undefined,
  brokenModels: Record<string, BrokenRef[]>
): BrokenInfo {
  const all = brokenModels[mainId] ?? []
  const brokenHere = all.filter((b) => b.sessionId === currentSessionId)
  // 本对话的失效原因全都只是「密钥的事」时用警示色而非危险色：填上密钥就好，不该被读成「得换模型」。
  // keyunreadable（密文在但解不开）同属「密钥的事」：换模型解决不了，仍要引导去重填。
  const onlyNoKey = brokenHere.length > 0 && all.every((b) => b.kind === 'nokey' || b.kind === 'keyunreadable')
  // 本次要换掉的引用：优先本会话自己指向的那个（覆盖层 / 已落库值），对不上再退回扫描结果里的第一条。
  // 比较前 trim：主进程 apply 的匹配规则是归一后相等（见 model-swap.ts 的 normalizeRef），界面得跟它一致，
  // 否则带空格的会话会「界面认为不匹配、主进程却换了」（A24 的界面侧同形）。
  const boundNorm = boundModelRef ? boundModelRef.trim() : ''
  const swapFromRef =
    boundModelRef && brokenHere.some((b) => b.ref.trim() === boundNorm) ? boundModelRef : (brokenHere[0]?.ref ?? '')
  return { broken: brokenHere.length > 0, mainId, count: all.length, onlyNoKey, swapFromRef }
}

/**
 * 「密钥用不了」（无密钥 / 解不开）的服务商 id 集合，供模型菜单把它们名下的模型标成不可选。
 *
 * 判据由主进程给（loadBlockedProviders，与 resolveAvailability 同源），渲染层不自己推一遍。
 * 拉取失败时回空集：宁可让菜单看起来正常，也不要把一堆模型误标成不可选。
 *
 * 重拉时机：打开模型菜单时（open 变 'model'）。必须在**打开那一刻**重拉——用户可能刚在设置页填完密钥
 * 又回来选模型，缓存旧结论会把刚填好的服务商误标成不可选。故依赖只有 open。
 */
function useBlockedProviders(menuOpen: boolean): Set<string> {
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!menuOpen) return
    let live = true
    void loadBlockedProviders().then((list) => {
      if (live) setBlocked(new Set(list.map((b) => b.id)))
    })
    return () => {
      live = false
    }
  }, [menuOpen])
  return blocked
}