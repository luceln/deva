/**
 * 模型贴片点开的菜单：全部「已启用服务商 × 已启用模型」按服务商分组平铺，点一下即切换。
 *
 * 每行只写模型名（悬停提示写完整 ID）。服务商名是灰色小字、滚动时吸顶；组间不画线、不放色点。
 * 列表自己滚动；打开时把当前模型滚到可见范围中间。
 */
import { useLayoutEffect, useRef } from 'react'
import { Check } from 'lucide-react'

import type { ModelDef, Provider } from '../mock/models'
import { useI18n } from '../i18n/i18n'

export interface ModelGroup {
  p: Provider
  models: ModelDef[]
}

export function ModelMenu({
  groups,
  activePid,
  activeMid,
  blocked,
  onPick
}: {
  groups: ModelGroup[]
  activePid: string | null
  activeMid: string | null
  /**
   * 「密钥用不了」的服务商 id（无密钥 / 解不开）：名下模型列出来但标成不可选，并写明原因。
   * 不直接不列：删掉用户只会觉得「我的服务商怎么不见了」，不知道该先去填密钥。
   */
  blocked: Set<string>
  onPick: (pid: string, mid: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // 只在打开时定位一次：直接改列表的 scrollTop（scrollIntoView 可能连带滚动外层）。
  useLayoutEffect(() => {
    const list = listRef.current
    const item = activeRef.current
    if (!list || !item) return
    list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2
  }, [])


  return (
    <div className="model-pick__menu cf-mp__menu" role="menu" aria-label={t('chat.selectModel')}>
      {groups.length === 0 ? (
        <div className="model-pick__empty">{t('chat.noModel')}</div>
      ) : (
        <div ref={listRef} className="cf-mp__list">
          {groups.map(({ p, models }) => {
            /*
             * 该服务商的密钥用不了（无密钥 / 解不开）：名下模型照常列出但标成不可选，并在组头上写明原因。
             * **不直接不列**：删掉用户只会觉得「我的服务商怎么不见了」，不知道该先去填密钥。
             * 判据由主进程给（blocked 来自 loadBlockedProviders，与 resolveAvailability 同源）。
             */
            const keyBlocked = blocked.has(p.id)
            return (
            <div key={p.id} className="cf-mp__group">
              <div className="cf-mp__ghead">{p.name}</div>
              {keyBlocked && <div className="cf-mp__blockednote">{t('cf.modelSwap.providerNoKey')}</div>}
              {models.map((m) => {
                const on = p.id === activePid && m.id === activeMid
                return (
                  <button
                    key={m.id}
                    ref={on ? activeRef : undefined}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    aria-disabled={keyBlocked || undefined}
                    disabled={keyBlocked}
                    className={`model-pick__item${on ? ' is-active' : ''}${keyBlocked ? ' is-unusable' : ''}`}
                    title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
                    onClick={() => onPick(p.id, m.id)}
                  >
                    <span className="model-pick__name">{m.name}</span>
                    <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
                  </button>
                )
              })}
            </div>
            )
          })}
        </div>
      )}

    </div>
  )
}
