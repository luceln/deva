import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { seedProviders, type Provider, type ModelDef, type ProviderPurpose } from '../mock/models'
import type { EffortLevel } from '../../../preload'
import type { ConfigSetResult } from '../../../shared/config-protocol'

/**
 * 模型配置（全局，与项目无关）。
 * 服务商清单/模型/默认模型为内存状态（种子来自 mock/models）；
 * **API 密钥不进渲染层**——只经 window.deva.secrets 交主进程加密保存，这里仅持有「是否已配置」的布尔态。
 */
interface ModelsContextValue {
  providers: Provider[]
  selectedProviderId: string
  selectedProvider: Provider | undefined
  selectProvider: (id: string) => void
  /**
   * 最近使用的模型 "providerId:modelId"——本应用不设显式「默认模型」，
   * 用户最后一次在对话输入框切换的模型即充当**新对话未选时的默认**（兜底回落）。
   */
  activeModelId: string | null
  activeModel: { provider: Provider; model: ModelDef } | null
  /** 记录一次模型选择为「最近使用」（由对话输入框的模型选择器调用）。 */
  setActiveModel: (providerId: string, modelId: string) => void
  /** 最近使用的思考等级（同 activeModelId：充当尚未定格思考等级的对话的默认）。 */
  activeEffort: EffortLevel
  /** 记录一次思考等级选择为「最近使用」（由对话输入框的思考等级选择器调用）。 */
  setActiveEffort: (level: EffortLevel) => void
  updateProvider: (
    id: string,
    patch: Partial<Pick<Provider, 'name' | 'apiHost' | 'enabled' | 'adapter' | 'threshold'>>
  ) => void
  toggleModel: (providerId: string, modelId: string) => void
  /** 改单个模型的显示名 / 上下文窗口 / 输出上限（模型详情页）；值为 undefined 即恢复自动。 */
  updateModel: (
    providerId: string,
    modelId: string,
    patch: Partial<Pick<ModelDef, 'name' | 'contextWindow' | 'maxOutput'>>
  ) => void
  addModel: (providerId: string, id: string) => void
  /** 批量添加模型：去重并跳过已存在，一次落盘。用于从服务端清单多选添加。 */
  addModels: (providerId: string, ids: string[]) => void
  removeModel: (providerId: string, modelId: string) => void
  /**
   * 新建自定义服务商。purpose 决定其能力轴：
   * 'llm'（默认）= 对话模型（adapter openai，可切协议）；
   * 'decision' = 决策模型（adapter 固定 jev，带默认触发阈值，不生成文本、不入对话选择器）。
   * 返回新服务商 id（对话区「接入模型」引导据此写入地址/密钥/模型）。
   */
  addCustomProvider: (name: string, purpose?: ProviderPurpose) => string
  /**
   * 用官方预置一键套用到某个（自定义）服务商：覆盖名称/协议/地址/文档/品牌色，并替换模型清单。
   * 不改 kind（保持自定义）与 enabled（是否启用交由用户），也不动密钥。
   */
  applyPreset: (providerId: string, preset: Provider) => void
  /** 删除服务商（含其密钥、悬空默认模型的清理）；官方预置恢复为初始状态而不移出清单。 */
  removeProvider: (id: string) => void
  // 密钥（安全存储，不回显明文）
  hasKey: (providerId: string) => boolean
  setApiKey: (providerId: string, key: string) => Promise<{ ok: boolean; available: boolean }>
  /** 当前环境是否支持加密存储（否则拒绝保存密钥，UI 需降级提示） */
  secretsAvailable: boolean
  /** 持久化配置是否已载入：之前 providers 只是种子（无模型），据此判「无可用模型」会在启动瞬间误判。 */
  ready: boolean
}

const ModelsContext = createContext<ModelsContextValue | null>(null)

export function findActive(providers: Provider[], activeId: string | null) {
  if (!activeId) return null
  // 按首个冒号切分：providerId 由本应用生成、无冒号，而模型 id 可以带冒号（Ollama 的 `qwen3:8b`），
  // 不能 split(':') 解构——那样 mid 只剩 `qwen3`，解析失败即误报「尚未选择模型」。
  const idx = activeId.indexOf(':')
  if (idx <= 0) return null
  const pid = activeId.slice(0, idx)
  const mid = activeId.slice(idx + 1)
  const provider = providers.find((p) => p.id === pid)
  const model = provider?.models.find((mm) => mm.id === mid)
  return provider && model ? { provider, model } : null
}

/** 是否至少有一个可在对话里选用的模型（已启用的对话服务商 × 已启用模型；与输入框模型选择器同口径）。 */
export function hasUsableModel(providers: Provider[]): boolean {
  return providers.some(
    (p) => p.enabled && (p.purpose ?? 'llm') === 'llm' && p.models.some((mm) => mm.enabled)
  )
}

// config.json 允许手改，也有外部工具写入，载入时逐条整理：格式不对的只丢这一条。
// 若任由某条抛错，载入会落到兜底，随后默认种子回写，用户全部服务商与模型都被清掉。
function normalizeModel(raw: unknown): ModelDef | null {
  const mm = raw as Partial<ModelDef> | null
  if (!mm || typeof mm !== 'object' || typeof mm.id !== 'string' || !mm.id) return null
  return {
    ...mm,
    id: mm.id,
    name: typeof mm.name === 'string' ? mm.name : mm.id,
    enabled: mm.enabled === true
  }
}

function normalizeProvider(raw: unknown): Provider | null {
  const p = raw as Partial<Provider> | null
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return null
  const models = Array.isArray(p.models) ? (p.models as unknown[]) : []
  return {
    ...p,
    id: p.id,
    name: typeof p.name === 'string' ? p.name : p.id,
    apiHost: typeof p.apiHost === 'string' ? p.apiHost : '',
    enabled: p.enabled === true,
    models: models.map(normalizeModel).filter((mm): mm is ModelDef => mm !== null)
  } as Provider
}

/**
 * 写盘成功后，把「本次已声明的删除」从待删清单里减掉，返回剩下的。
 *
 * 抽成纯函数是为了让规则可测（`npm test` 之外用一次性脚本也能验）。规则本身很关键：
 * 只能减掉**本次真正写盘的那些 id**，不能整体清空——见回写 effect 处的注释（并发写盘互踩）。
 */
export function settleRemovedProviders(pending: string[], written: string[]): string[] {
  const done = new Set(written)
  return pending.filter((x) => !done.has(x))
}

/** 种子服务商的独立副本（模型深拷贝、purpose 落定）：初始清单与删除官方服务商时的复位共用。 */
function freshSeed(p: Provider): Provider {
  return { ...p, purpose: p.purpose ?? 'llm', models: p.models.map((mm) => ({ ...mm })) }
}

export function ModelsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>(() => seedProviders.map(freshSeed))
  const [selectedProviderId, setSelectedProviderId] = useState<string>(seedProviders[0].id)
  // 不内置默认模型，也不设显式「默认」入口：新用户首次在对话输入框选择模型后即记为「最近使用」，
  // 之后新对话默认沿用它（在此之前对话顶部显示「选择模型」）。
  const [activeModelId, setActiveModelId] = useState<string | null>(null)
  const [activeEffort, setActiveEffort] = useState<EffortLevel>('default')

  // providerId -> 是否已配置密钥；以及加密是否可用
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [secretsAvailable, setSecretsAvailable] = useState(true)

  // 配置载入完成前不回写，避免用默认种子覆盖已存 ~/.deva-plus/config.json
  const [hydrated, setHydrated] = useState(false)

  /**
   * 已删除、但**尚未确认写盘成功**的服务商 id。
   *
   * 为什么不直接用 `providers` 的差集：主进程的 models 写入是「整段替换 + 保留它认识、而本次补丁里没有的
   * provider」，因为导入可能在这一瞬间并入了新 provider。所以删除必须**显式声明**，主进程才知道「这些是
   * 用户主动删的，不是它不知道的」。
   *
   * 为什么是 ref 而不是 state：只求「回写那一刻的值」，进 state 会让回写 effect 多一次渲染、
   * 多一轮写盘。它**绝不能进 effect 的 deps**——写成功后清空会再触发一次回写，形成自激循环，
   * 正好破坏 config.ts 那句「刻意不广播，避免刷新循环」的保护。
   *
   * 生命周期：`removeProvider` 里追加 → 回写成功后清掉**本次已声明的那批** → 回写失败/抛错则原样保留，
   * 下次回写继续声明。清了就等于「这次删除永久放弃」：主进程没删，后续别的路径的合并写会把 provider 带回来。
   *
   * ⚠️ 目前只有 `removeProvider`（下方 :282 附近）会产生删除。将来若加「批量清空」「重置为预置」这类入口，
   * 必须同样往这里记，否则删除不生效（主进程会把它当成「它不知道的 provider」保留下来）。
   */
  const removedProvidersRef = useRef<string[]>([])

  // 外部批量改动（导入）后递增，用来重跑下面的载入 effect。
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [ids, available] = await Promise.all([
          window.deva.secrets.list(),
          window.deva.secrets.available()
        ])
        if (!alive) return
        setKeyStatus(Object.fromEntries(ids.map((id) => [id, true])))
        setSecretsAvailable(available)
      } catch {
        /* 首次运行或不可用：保持空态 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 载入持久化的模型配置（~/.deva-plus/config.json 的 models 段），与默认种子合并。
  // reloadNonce 变化时重跑：主进程「从原版导入」这类外部批量改动会经 config:changed 递增它，
  // 否则本 store 只在挂载时读一次，用户会看到「导完了模型列表还是空的」。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await window.deva.config.get()
        const saved = cfg?.models as
          | { providers?: unknown; activeModelId?: unknown; activeEffort?: EffortLevel }
          | undefined
        if (!alive) return
        const savedProviders = Array.isArray(saved?.providers)
          ? saved.providers.map(normalizeProvider).filter((p): p is Provider => p !== null)
          : []
        if (savedProviders.length > 0) {
          // 已保存的为准，并追加用户尚未见过的新内置服务商（保留用户编辑 + 呈现新预置，
          // 含新引入的决策模型 typesafe——老配置无该项时自动补齐）。
          const savedIds = new Set(savedProviders.map((p) => p.id))
          const merged = [...savedProviders, ...seedProviders.filter((p) => !savedIds.has(p.id))]
          // 向后兼容：既有配置里未带 purpose 的服务商一律视为对话模型（'llm'），显式落定以便持久化。
          setProviders(
            merged.map((p) => ({
              ...p,
              purpose: p.purpose ?? 'llm',
              models: p.models.map((mm) => ({ ...mm }))
            }))
          )
        }
        if (saved && 'activeModelId' in saved)
          setActiveModelId(typeof saved.activeModelId === 'string' ? saved.activeModelId : null)
        if (saved?.activeEffort) setActiveEffort(saved.activeEffort)
      } catch {
        /* 无配置 / 读取失败：沿用默认种子 */
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [reloadNonce])

  // 主进程外部批量改动（导入）后重载。只认 models 段：别的键（layout 等）与本 store 无关，
  // 跟着重载会让下面的回写 effect 白跑一次。
  // 防御：preload 未及时更新时 onChanged 可能不存在，此时退化为「只在挂载时读一次」（旧行为），不让面板崩。
  useEffect(() => {
    const onChanged = window.deva.config.onChanged
    if (typeof onChanged !== 'function') return
    return onChanged((p) => {
      if (!p.keys.includes('models')) return
      setReloadNonce((n) => n + 1)
    })
  }, [])

  // 变更后回写（仅在 hydrate 之后）。密钥不在此列——始终只在主进程加密存储。
  //
  // 补丁里带 `removedProviders`：主进程对 models 段做「整段替换 + 保留它不认识的 provider + 按这里声明删除」，
  // 不声明删除的话，被删的 provider 会被当成「导入刚并进来的」保留回来。
  //
  // 写成 async 并检查返回值：旧契约是 `Promise<{ ok: true }>`，没有失败态，于是写盘失败被默默吞掉——
  // 用户删了服务商，重启后又回来，界面还提示删成功了。现在主进程回 ConfigSetResult，失败要能看见。
  //
  // 回收 ref 的规则（三条都不能动）：
  //  1. 成功清空，**queued:true 也清**：主进程在导入期间把整个 patch（含 removedProviders）推进队列，
  //     drain 时照样会用它；不清的话同一次删除会在后续每次回写里重复声明，让「ref 何时清空」变得不可推理。
  //  2. 失败（ok:false）必须保留：清了等于这次删除永久放弃，而主进程那边没删。
  //  3. 抛异常/通道不可用同样保留，并留 console 出口。
  useEffect(() => {
    if (!hydrated) return
    void (async () => {
      const removed = removedProvidersRef.current
      // models 段整块替换（config:set 只做顶层浅合并），新增的兄弟字段必须一并写，漏写即被清掉。
      let r: ConfigSetResult
      try {
        r = await window.deva.config.set({
          models: { providers, activeModelId, activeEffort },
          // 没有待删项时不写这个键：让补丁形态与从前一致，避免给主进程传一个空数组。
          ...(removed.length ? { removedProviders: removed } : {})
        })
      } catch (e) {
        // 通道异常：保住 ref，下次回写继续声明这批删除。
        console.warn('[models] config write threw', e)
        return
      }
      // 这里**不加 unmounted 守卫**：ref 的回收不依赖组件还在不在，写成功就该收 ——
      // 若因为 effect 被新一轮渲染顶掉（用户连点两次）而跳过清空，那批删除会一直被重复声明。
      //
      // 清空时**只移除本次真正写盘的那些 id**（不是整个清空）：删 A 的写盘还在路上时用户又删了 B，
      // 会并发发起第二次写盘（ref 已是 [A,B]）。若 A 先回来就整体清空，B 那次写盘失败时 B 已经丢了——
      // 而主进程没删成 B。按「从当前 ref 里减去本次已声明的」处理，两个并发写盘互不踩踏。
      if (r?.ok) {
        removedProvidersRef.current = settleRemovedProviders(removedProvidersRef.current, removed)
      } else {
        console.warn('[models] config write failed', r?.error)
      }
    })()
  }, [hydrated, providers, activeModelId, activeEffort])

  const patchProvider = (id: string, fn: (p: Provider) => Provider): void =>
    setProviders((list) => list.map((p) => (p.id === id ? fn(p) : p)))

  const value = useMemo<ModelsContextValue>(
    () => ({
      providers,
      selectedProviderId,
      selectedProvider: providers.find((p) => p.id === selectedProviderId),
      selectProvider: setSelectedProviderId,
      activeModelId,
      activeModel: findActive(providers, activeModelId),
      setActiveModel: (pid, mid) => setActiveModelId(`${pid}:${mid}`),
      activeEffort,
      setActiveEffort,
      updateProvider: (id, patch) => {
        patchProvider(id, (p) => ({ ...p, ...patch }))
        // 禁用服务商时，若默认模型属于它则清空，避免对话页指向不可用模型
        if (patch.enabled === false) {
          setActiveModelId((cur) => (cur && cur.split(':')[0] === id ? null : cur))
        }
      },
      toggleModel: (pid, mid) =>
        patchProvider(pid, (p) => ({
          ...p,
          models: p.models.map((mm) => (mm.id === mid ? { ...mm, enabled: !mm.enabled } : mm))
        })),
      updateModel: (pid, mid, patch) =>
        patchProvider(pid, (p) => ({
          ...p,
          models: p.models.map((mm) => {
            if (mm.id !== mid) return mm
            const next = { ...mm, ...patch }
            // 恢复自动：删键而不是留 undefined，落盘的配置里不残留空字段。
            if (next.contextWindow === undefined) delete next.contextWindow
            if (next.maxOutput === undefined) delete next.maxOutput
            return next
          })
        })),
      // 新增模型即启用：模型本身 enabled:true，并顺带启用所属服务商
      //（服务商被禁用则模型不可用），使刚添加的模型立即可选。
      addModel: (pid, id) =>
        patchProvider(pid, (p) =>
          p.models.some((mm) => mm.id === id)
            ? p
            : { ...p, enabled: true, models: [...p.models, { id, name: id, enabled: true }] }
        ),
      addModels: (pid, ids) =>
        patchProvider(pid, (p) => {
          const have = new Set(p.models.map((mm) => mm.id))
          const fresh: ModelDef[] = []
          for (const raw of ids) {
            const id = raw.trim()
            if (!id || have.has(id)) continue // 跳过空串、已存在、以及本批次内重复
            have.add(id)
            fresh.push({ id, name: id, enabled: true })
          }
          return fresh.length ? { ...p, enabled: true, models: [...p.models, ...fresh] } : p
        }),
      removeModel: (pid, mid) => {
        patchProvider(pid, (p) => ({ ...p, models: p.models.filter((mm) => mm.id !== mid) }))
        // 删掉的正是默认模型 → 清空默认，避免悬空
        setActiveModelId((cur) => (cur === `${pid}:${mid}` ? null : cur))
      },
      removeProvider: (id) => {
        // 先记账：models 段是「整段替换 + 保留主进程不认识的 provider」，不显式声明，主进程会把它当成
        // 「导入刚并进来的那个」保留下来，用户的删除重启后又回来了。
        // 记的是 ref，不触发渲染——回写由下面的 setProviders 引起的那一轮负责带上。
        removedProvidersRef.current = [...new Set([...removedProvidersRef.current, id])]
        // 一并清理密钥、选中项与悬空默认模型；密钥删除交主进程（明文不经渲染层）
        void window.deva.secrets.delete(id)
        // 官方预置不移出清单，而是恢复为初始状态（未启用、预置模型）：没了密钥又未启用，设置页列表即不再显示，
        // 对话区的接入引导仍能再选它。移出清单的话，引导卡里要到重启、载入时从种子补回才有它。
        const seed = seedProviders.find((p) => p.id === id)
        if (seed) {
          setProviders((list) => list.map((p) => (p.id === id ? freshSeed(seed) : p)))
        } else {
          setProviders((list) => list.filter((p) => p.id !== id))
          setSelectedProviderId((cur) => {
            if (cur !== id) return cur
            const remaining = providers.filter((p) => p.id !== id)
            return remaining[0]?.id ?? ''
          })
        }
        setActiveModelId((cur) => (cur && cur.split(':')[0] === id ? null : cur))
        setKeyStatus((s) => {
          const next = { ...s }
          delete next[id]
          return next
        })
      },
      applyPreset: (pid, preset) =>
        patchProvider(pid, (p) => ({
          ...p,
          name: preset.name,
          apiHost: preset.apiHost,
          adapter: preset.adapter,
          accent: preset.accent,
          docUrl: preset.docUrl,
          // 深拷贝预置模型，避免与预置目录共享引用
          models: preset.models.map((mm) => ({ ...mm }))
        })),
      addCustomProvider: (name, purpose = 'llm') => {
        const id = `custom-${Date.now()}`
        const isDecision = purpose === 'decision'
        setProviders((list) => [
          ...list,
          {
            id,
            name: name || (isDecision ? '自定义决策模型' : '自定义服务商'),
            kind: 'custom',
            purpose,
            accent: isDecision ? '#6d5efc' : '#8a8a94',
            // 决策模型仅有 jev 一种协议（不生成文本，走独立决策运行时）；对话模型默认 OpenAI 兼容。
            adapter: isDecision ? 'jev' : 'openai',
            apiHost: 'https://',
            enabled: false,
            ...(isDecision ? { threshold: 0.6 } : {}),
            models: []
          }
        ])
        setSelectedProviderId(id)
        return id
      },
      hasKey: (providerId) => Boolean(keyStatus[providerId]),
      setApiKey: async (providerId, key) => {
        const res = await window.deva.secrets.set(providerId, key)
        if (res.ok) {
          setKeyStatus((s) => ({ ...s, [providerId]: Boolean(key) }))
          // 填入密钥即自动启用该服务商，省去手动开关（清空密钥不动启用态）
          if (key) patchProvider(providerId, (p) => (p.enabled ? p : { ...p, enabled: true }))
        }
        return res
      },
      secretsAvailable,
      ready: hydrated
    }),
    [providers, selectedProviderId, activeModelId, activeEffort, keyStatus, secretsAvailable, hydrated]
  )

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
}

export function useModels(): ModelsContextValue {
  const ctx = useContext(ModelsContext)
  if (!ctx) throw new Error('useModels 必须在 ModelsProvider 内使用')
  return ctx
}
