/**
 * 输入框工具条上的模型面板（对比稿 design/model-panel.html：模型菜单方案 C、贴片写法 ②）。
 *
 * 贴片：上下文占用圆环（服务商色，顶替原来的色点）+ 模型名；选了思考等级（非「默认」）再加「灯泡 + 档位」。
 * 圆环不配数字，百分比在悬停提示与面板里。没有读数（新对话、模型已删）时仍是服务商色点。
 * 面板：上半部分是本对话的上下文占用（百分比最多 100%、进度条与自动压缩竖线、已用 / 窗口、再用多少会压缩）；
 * 下半部分两行「模型」「思考等级」，悬停或点击向左弹出二级菜单（模型菜单见 ModelMenu.tsx）。
 * 接近压缩也不变色、不提醒：压缩是自动的，不需要用户处理。
 *
 * 切换语义同原来的两个独立选择器：只改本对话并立即落库（setSessionModel / setSessionEffort），同时记为
 * 「最近使用」（setActiveModel / setActiveEffort），新对话未选时沿用最近使用。显示的是本对话生效模型：
 * 本对话已选 → 否则回落最近使用（与主进程 resolveModelRef 的兜底一致）。档位按该模型支持的档收敛显示
 * （clampEffort，与主进程实际发送的一致）；只能开、不能调档的模型唯一一档显示为「开启」。
 *
 * **失效标红**（从合并前的 ModelPicker 迁来）：解析不到（模型被删 / 服务商被停用 / 缺密钥 / 引用本身坏了）
 * 不再静默回落——贴片标红、文案换成「模型不可用」、右侧挂受影响会话数，点它直接打开批量替换对话框
 * （用户此刻唯一要处理的就是它，再弹常规面板只会多一层）。是否失效一处都不在这里算：结论来自主进程的
 * scan（store 的 brokenModels），渲染层自己按 providers 推一遍必然与主进程漂移。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Cpu, Lightbulb } from 'lucide-react'
import type { ContextUsage, EffortLevel } from '../../../preload'
import type { BrokenRef } from '../store/modelSwap'
import { loadBlockedProviders } from '../store/modelSwap'
import { useChatActions, useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { clampEffort, isToggleEffort, supportedEffortLevels, type EffortAdapter } from '../../../shared/effort'
import { formatTokens } from '../../../shared/context'
import { useI18n } from '../i18n/i18n'
import { ModelMenu, type ModelGroup } from './ModelMenu'
import { ModelSwapDialog } from './ModelSwapDialog'
import { approxTokens, usagePercent, usageRatio, useContextUsage } from './context-usage'
import './model-panel.css'

type Open = null | 'panel' | 'model' | 'effort'

/** 二级菜单向左弹出所需的宽度；面板左侧放不下时改为盖在面板上。 */
const SUB_ROOM = 290

export function ModelPanel(): React.JSX.Element {
  const { activeModel, providers, setActiveModel, activeEffort, setActiveEffort } = useModels()
  const { currentBinding, currentSessionId, sessions, brokenModels } = useChatState()
  const { setSessionModel, setSessionEffort } = useChatActions()
  const [open, setOpen] = useState<Open>(null)
  const [narrow, setNarrow] = useState(false)
  const [swapTarget, setSwapTarget] = useState<{ mainId: string; fromRef: string } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

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
  const effort = useEffort(active, currentBinding.effort ?? activeEffort)
  const broken = brokenInfoOf(
    mainIdOf(sessions, currentSessionId),
    currentSessionId,
    currentBinding.model,
    brokenModels
  )
  const blocked = useBlockedProviders(open)

  // 「密钥用不了」的服务商最后还要与 broken 里的 nokey / keyunreadable 取并集（见模型菜单）：
  // 全量那份是 IPC 回来的，与「刚改完配置」之间有短暂时差，并上 scan 结论才不漏。
  const blockedIds = useMemo(() => {
    const s = new Set(blocked)
    for (const b of brokenModels[mainIdOf(sessions, currentSessionId)] ?? []) {
      if (b.kind !== 'nokey' && b.kind !== 'keyunreadable') continue
      const pid = b.ref.slice(0, Math.max(0, b.ref.indexOf(':')))
      if (pid) s.add(pid)
    }
    return s
  }, [blocked, brokenModels, sessions, currentSessionId])

  // 二级菜单打开时量一下左侧余量：窗口太窄放不下就盖在面板上。
  useLayoutEffect(() => {
    if (open !== 'model' && open !== 'effort') return
    const left = popRef.current?.getBoundingClientRect().left ?? SUB_ROOM
    setNarrow(left < SUB_ROOM)
  }, [open])

  // Esc：二级菜单 → 回到面板；面板 → 收起。失效态下直接开着的替换对话框由 Modal 自己处理 Esc。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen((o) => (o === 'model' || o === 'effort' ? 'panel' : null))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const accent = active?.provider.accent ?? 'var(--fg-subtle)'

  return (
    <div className="model-pick cf-mp">
      <PanelChip
        active={active}
        accent={accent}
        usage={active && usage && usage.used != null ? usage : null}
        effort={effort}
        open={!broken.broken && !!open}
        broken={broken}
        onToggle={() => {
          if (broken.broken) {
            setOpen(null)
            setSwapTarget({ mainId: broken.mainId, fromRef: broken.swapFromRef })
          } else {
            setOpen((o) => (o ? null : 'panel'))
          }
        }}
      />
      {/* 替换 action 在返回结果前会清空并重扫失效缓存；弹窗范围固定为打开时的引用。 */}
      {swapTarget && <ModelSwapDialog {...swapTarget} onClose={() => setSwapTarget(null)} />}
      {!broken.broken && open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(null)} />
          <div ref={popRef} className={`cf-mp__pop${narrow ? ' is-narrow' : ''}`}>
            <div className="cf-mp__panel">
              <UsageSection usage={active ? usage : null} accent={accent} />
              <PanelRows open={open} setOpen={setOpen} active={active} accent={accent} effort={effort} />
            </div>
            {open === 'model' && (
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
            {open === 'effort' && effort.levels.length > 0 && (
              <EffortMenu
                effort={effort}
                onPick={(lv) => {
                  setSessionEffort(lv)
                  setActiveEffort(lv)
                  setOpen(null)
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

type Active = ReturnType<typeof findActive>

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
 * 本会话的模型是否已失效（从合并前的 ModelPicker 迁来）。
 *
 * 只认主进程 scan 的结论（store 的 brokenModels），不在渲染层按 providers 复算。悬空的引用可能没人登记在
 * 本会话上（缓存里没有本会话的 sessionId 时也不标红），此时宁可保持原样——拿不到结论就标红，会把用户
 * 赶去换一个本来好好的模型。
 *
 * 纯函数（无 hook），导出是为了让 .deva/qa/check-model-swap.cjs 能直接跑真逻辑做断言，
 * 而不是只在浏览器里验一遍。
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
  // 只要有一处是真坏（被删 / 服务商或模型被停用 / 引用非法），就按严重处理（危险色）——停用虽说也是
  // 「去设置里点一下就好」，但用户点头像框上面的胶囊时最想知道的仍是「这对话现在坏了」。
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
 * 贴片：占用圆环（顶替服务商色点）+ 模型名 + 思考档；没有读数时仍是色点。圆环不配数字，
 * 百分比与已用 / 窗口写在悬停提示里，点开面板看详情。
 * 失效时（broken）：换成危险 / 警示色 + 「模型不可用」/「缺少密钥」+ 受影响会话数徽标，点击打开批量替换。
 */
function PanelChip({
  active,
  accent,
  usage,
  effort,
  open,
  onToggle,
  broken
}: {
  active: Active
  accent: string
  usage: ContextUsage | null
  effort: EffortInfo
  open: boolean
  onToggle: () => void
  broken?: BrokenInfo
}): React.JSX.Element {
  const { t } = useI18n()
  const levelName = effort.current !== 'default' ? effort.nameOf(effort.current) : ''
  if (broken?.broken) {
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
        {/* 徽标恒显示：一个会话也不受影响时不会走到这里，有红标就说明至少一处，数字让用户知道范围。 */}
        <span className="chip__badge">{broken.count}</span>
      </button>
    )
  }
  const title = [
    active ? active.model.name : t('chat.selectModel'),
    levelName && `${t('chat.effort.title')}：${levelName}`,
    usage && `${t('chat.panel.context')} ${percentText(t, usage)}（${usedText(t, usage)}）`
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      className={`chip cf-mp__chip${open ? ' is-open' : ''}`}
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
    >
      {usage ? (
        <ContextRing ratio={usageRatio(usage)} color={accent} />
      ) : (
        active && <span className="chip__dot" style={{ background: accent }} />
      )}
      <span className="chip__label">{active ? active.model.name : t('chat.selectModel')}</span>
      {levelName && (
        <span className="cf-mp__eff">
          <Lightbulb size={13} />
          {levelName}
        </span>
      )}
      <ChevronDown size={13} className="chip__caret" />
    </button>
  )
}

/** 面板下半部分：「模型」「思考等级」两行，悬停或点击打开对应的二级菜单。模型不支持思考等级时灰显。 */
function PanelRows({
  open,
  setOpen,
  active,
  accent,
  effort
}: {
  open: Open
  setOpen: React.Dispatch<React.SetStateAction<Open>>
  active: Active
  accent: string
  effort: EffortInfo
}): React.JSX.Element {
  const { t } = useI18n()
  const toggle = (sub: 'model' | 'effort'): void => setOpen((o) => (o === sub ? 'panel' : sub))
  return (
    <div className="cf-mp__rows">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open === 'model'}
        className={`model-pick__item cf-mp__row${open === 'model' ? ' is-on' : ''}`}
        onMouseEnter={() => setOpen('model')}
        onClick={() => toggle('model')}
      >
        <Cpu size={14} className="cf-mp__icon" />
        <span className="cf-mp__key">{t('chat.model')}</span>
        <span className="cf-mp__val">
          {active && <span className="chip__dot" style={{ background: accent }} />}
          <span className="cf-mp__valtext">{active ? active.model.name : t('chat.selectModel')}</span>
          <ChevronRight size={13} />
        </span>
      </button>
      {effort.levels.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === 'effort'}
          className={`model-pick__item cf-mp__row${open === 'effort' ? ' is-on' : ''}`}
          onMouseEnter={() => setOpen('effort')}
          onClick={() => toggle('effort')}
        >
          <Lightbulb size={14} className="cf-mp__icon" />
          <span className="cf-mp__key">{t('chat.effort.title')}</span>
          <span className="cf-mp__val">
            <span className="cf-mp__valtext">{effort.nameOf(effort.current)}</span>
            <ChevronRight size={13} />
          </span>
        </button>
      ) : (
        active && (
          <div
            className="model-pick__item cf-mp__row is-disabled"
            aria-disabled="true"
            onMouseEnter={() => setOpen('panel')}
          >
            <Lightbulb size={14} className="cf-mp__icon" />
            <span className="cf-mp__key">{t('chat.effort.title')}</span>
            <span className="cf-mp__val">
              <span className="cf-mp__valtext">{t('chat.effort.unsupported')}</span>
            </span>
          </div>
        )
      )}
    </div>
  )
}

type T = (key: string) => string

/** 「50%」（最多 100%）；估算值写「约 50%」。 */
function percentText(t: T, u: ContextUsage): string {
  const p = usagePercent(u)
  return u.estimated ? t('chat.panel.approx').replace('{n}', p) : p
}

/** 「已用 128K / 窗口 256K」：已用照实写（可能超过窗口），估算值加「约」。 */
function usedText(t: T, u: ContextUsage): string {
  const used = approxTokens(u.used ?? 0)
  return t('chat.panel.used')
    .replace('{used}', u.estimated ? t('chat.panel.approx').replace('{n}', used) : used)
    .replace('{window}', formatTokens(u.window))
}

/** 占用圆环：灰色底圈 + 服务商色弧（从 12 点顺时针）。 */
function ContextRing({ ratio, color }: { ratio: number; color: string }): React.JSX.Element {
  const r = 5.25
  const c = 2 * Math.PI * r
  const len = ratio * c
  return (
    <svg className="cf-mp__ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="cf-mp__ring-track" cx="7" cy="7" r={r} fill="none" strokeWidth="1.75" />
      {len > 0.01 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${len.toFixed(2)} ${c.toFixed(2)}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  )
}

/** 面板上半部分：上下文占用。没有读数时只写一句提示。 */
function UsageSection({ usage, accent }: { usage: ContextUsage | null; accent: string }): React.JSX.Element {
  const { t } = useI18n()
  if (!usage || usage.used == null) return <div className="cf-mp__empty">{t('chat.panel.empty')}</div>
  const tick = usage.trigger != null && usage.window > 0 ? Math.min(1, usage.trigger / usage.window) : null
  const left = usage.trigger != null ? usage.trigger - usage.used : null
  // 超出窗口（多见于换到窗口小的模型）：百分比封顶 100%，这里说明下次发送会先压缩。
  const note =
    usage.used >= usage.window && usage.trigger != null
      ? t('chat.panel.over')
      : usage.estimated
        ? t('chat.panel.estimated')
        : left == null
          ? ''
          : left < 1000
            ? t('chat.panel.soon')
            : t('chat.panel.left').replace('{n}', approxTokens(left))
  return (
    <div className="cf-mp__usage">
      <div className="cf-mp__top">
        <span className="cf-mp__title">{t('chat.panel.context')}</span>
        <span className="cf-mp__big">{percentText(t, usage)}</span>
      </div>
      <div className="cf-mp__bar">
        <div className="cf-mp__fill" style={{ width: `${(usageRatio(usage) * 100).toFixed(1)}%`, background: accent }} />
        {tick != null && <span className="cf-mp__tick" style={{ left: `${(tick * 100).toFixed(1)}%` }} />}
      </div>
      {tick != null && (
        <div className="cf-mp__ticklabel">
          <span style={{ left: `${(tick * 100).toFixed(1)}%` }}>{t('chat.panel.autoCompact')}</span>
        </div>
      )}
      <div className="cf-mp__line">{usedText(t, usage)}</div>
      {note && <div className="cf-mp__note">{note}</div>}
    </div>
  )
}

interface EffortInfo {
  levels: EffortLevel[]
  current: EffortLevel
  nameOf: (lv: EffortLevel) => string
  hintOf: (lv: EffortLevel) => string
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
function useBlockedProviders(open: Open): Set<string> {
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (open !== 'model') return
    let live = true
    void loadBlockedProviders().then((list) => {
      if (live) setBlocked(new Set(list.map((b) => b.id)))
    })
    return () => {
      live = false
    }
  }, [open])
  return blocked
}

/** 本对话生效模型支持的思考档与当前档（不支持时 levels 为空、current 为 default）。 */
function useEffort(active: Active, stored: EffortLevel): EffortInfo {
  const { t } = useI18n()
  // 对话模型的 adapter 必属三协议之一。
  const adapter = active?.provider.adapter as EffortAdapter | undefined
  const modelId = active?.model.id
  const levels = adapter && modelId ? supportedEffortLevels(adapter, modelId) : []
  const toggle = !!adapter && !!modelId && isToggleEffort(adapter, modelId)
  const current: EffortLevel =
    adapter && modelId && levels.length > 0 ? clampEffort(adapter, modelId, stored) : 'default'
  return {
    levels,
    current,
    nameOf: (lv) => (toggle && lv !== 'default' ? t('chat.effort.on') : t(`chat.effort.levels.${lv}`)),
    hintOf: (lv) => (toggle && lv !== 'default' ? t('chat.effort.onHint') : t(`chat.effort.hints.${lv}`))
  }
}

/** 思考等级二级菜单：各档与一行说明。 */
function EffortMenu({
  effort,
  onPick
}: {
  effort: EffortInfo
  onPick: (lv: EffortLevel) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const options: EffortLevel[] = ['default', ...effort.levels]
  return (
    <div className="cf-mp__sub" role="menu">
      <div className="model-pick__group-head">
        <span className="cf-mp__subtitle">{t('chat.effort.title')}</span>
      </div>
      <div className="cf-mp__list">
        {options.map((lv) => {
          const on = lv === effort.current
          return (
            <button
              key={lv}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              className={`model-pick__item${on ? ' is-active' : ''}`}
              onClick={() => onPick(lv)}
            >
              <span className="model-pick__name cf-mp__lv">
                <span>{effort.nameOf(lv)}</span>
                <span className="cf-mp__hint">{effort.hintOf(lv)}</span>
              </span>
              <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
