/**
 * 流式滚动跳变 —— 排查用测试台（只读诊断，不改产品代码）。
 *
 * 挂**真实的 `Conversation`**（含分区渲染、贴底跟随、ResizeObserver、轮次索引），
 * 把「流式追加」演成受控的 messages 更新，并记录每一拍的 scrollTop 轨迹。
 *
 * 目的不是「断言通过」，而是把用户描述的「自己上滚后莫名跳到很上面」变成可读的数字：
 * 看 scrollTop 何时、往哪个方向、跳了多少。
 */
import { createRoot } from 'react-dom/client'
import { useReducer, useEffect } from 'react'
import { Conversation } from 'E:/deva/apps/desktop/src/renderer/src/redesign/Conversation'
import { I18nProvider } from 'E:/deva/apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from 'E:/deva/apps/desktop/src/renderer/src/components/ToastProvider'
import { ProfileProvider } from 'E:/deva/apps/desktop/src/renderer/src/store/profile'

let root = null
let host = null
const noop = () => undefined

/** 受控的对话状态：外部用 `window.__setChat({messages, streaming})` 改，这里订阅后重渲染。 */
const store = {
  messages: [],
  streaming: false,
  listeners: new Set(),
  set(patch) {
    Object.assign(store, patch)
    for (const l of store.listeners) l()
  }
}
window.__setChat = (patch) => store.set(patch)

function Harness() {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    store.listeners.add(force)
    return () => {
      store.listeners.delete(force)
    }
  }, [force])
  return (
    <Conversation
      currentSessionId="s1"
      messages={store.messages}
      streaming={store.streaming}
      streamStatus={{ elapsedSec: 1, reconnecting: null, compacting: false }}
      focusRoot={null}
      onOpenProfile={noop}
      onSend={() => Promise.resolve(true)}
      onStop={noop}
      onMount={noop}
      onAsk={noop}
      onPlan={noop}
      onMountReq={noop}
      onOpenProposal={noop}
      onOpenAutotask={noop}
      onDeleteTurns={() => Promise.resolve(false)}
      archived={false}
      onUnarchive={noop}
      attention={false}
      prefill={null}
      onPrefill={noop}
      onPrefillConsumed={noop}
      members={[]}
      formerMembers={[]}
      sessionStates={{}}
      mentionables={[]}
      onOpenMember={noop}
      onRemoveMember={noop}
      pendingCards={{}}
      boundTasks={[]}
      taskPersonaOf={() => undefined}
      onOpenTask={noop}
      onRunTask={noop}
      onToggleTask={noop}
      onDeleteTask={noop}
      onEditTask={noop}
    />
  )
}

window.__mountConv = () => {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;width:900px;height:600px;display:flex;flex-direction:column'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <I18nProvider>
      <ProfileProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </ProfileProvider>
    </I18nProvider>
  )
}
