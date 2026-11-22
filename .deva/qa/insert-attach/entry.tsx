import { createRoot } from 'react-dom/client'
// 用相对路径，不要写死盘符：这份 entry 会被 build.cjs 从**任意工作区**（或 CI 的 checkout 目录）打包，
// 写成 `E:/deva/...` 会从另一个 checkout 加载 Composer，而 react/react-dom 仍来自当前工作区 →
// 页面里出现两份 React，`ReactCurrentDispatcher` 没初始化，渲染必崩
// （报 "Cannot read properties of null (reading 'useState')"）。
import { Composer } from '../../../apps/desktop/src/renderer/src/redesign/Composer'
import { I18nProvider } from '../../../apps/desktop/src/renderer/src/i18n/i18n'
import { messages } from '../../../apps/desktop/src/renderer/src/i18n/messages'
import { ToastProvider } from '../../../apps/desktop/src/renderer/src/components/ToastProvider'

/**
 * 把词条表交给 `test.ts`：断言按**当前 locale** 取期望文案，不再写死中文字面量。
 *
 * 写死中文会让整套用例只在中文系统成立——GitHub runner 的 `navigator.language` 是
 * en-US，界面渲染英文，断言全挂（`1 attachments go with it`、找不到「附加文件」按钮）。
 * 这不是环境问题，是断言本身脆。
 */
window.__messages = messages

let root = null
let host = null

/** 记录 onSend / onInsert 以外、外壳传下来的回调调用（这里是 onSend，插话走 store 的 insert 桩）。 */
window.__sendCalls = []

window.__mount = (props) => {
  // 先卸掉上一份：多次挂载会叠出多个 .cf-composer，querySelector 命中的是旧那个，
  // 断言就会看着旧 DOM 下判断（实测踩到过）。
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:40px;right:40px;bottom:40px'
  document.body.appendChild(host)
  root = createRoot(host)
  const p = {
    sessionId: 's1',
    // 给一个最小角色：Composer 会读 owner.model / owner.name 等处，不给就是 undefined 崩。
    owner: { id: 'p-general', name: '通用', avatar: { style: 'face', seed: 1 }, model: undefined },
    mentionables: [],
    streaming: false,
    focusRoot: null,
    onMount: () => undefined,
    onSend: (text, attachments) => {
      window.__sendCalls.push({ text, attachments })
      return Promise.resolve(true)
    },
    onStop: () => undefined,
    showJump: false,
    onJump: () => undefined,
    onRewind: () => false,
    prefill: null,
    onPrefillConsumed: () => undefined,
    ...props
  }
  root.render(
    <I18nProvider>
      <ToastProvider>
        <Composer {...p} />
      </ToastProvider>
    </I18nProvider>
  )
}
