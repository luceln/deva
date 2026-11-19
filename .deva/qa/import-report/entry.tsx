/**
 * 导入报告 —— 浏览器验证（`unrecoverable` 用警告、`rekeyed` 出现在成功面板）。
 *
 * 挂**真实的 `ImportPane`**，只把 `importBridge` 换成受控桩，
 * 然后喂两种报告，断言界面上的类名、文案、逐条 key 名、以及「不是失败」的关键约束。
 *
 * 用户手里真实情形：`magpie` 与 `remote:bot_mwcyl7ok_3hrt:appSecret` 两条坏密文，
 * 重新导入一次会被覆盖修好（rekeyed 有值）；再有些是实在修不了的（unrecoverable）。
 */
import { createRoot } from 'react-dom/client'
import { ImportPane } from 'E:/deva/apps/desktop/src/renderer/src/redesign/ImportPane'
import { I18nProvider } from 'E:/deva/apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from 'E:/deva/apps/desktop/src/renderer/src/components/ToastProvider'

let root = null
let host = null

window.__mountImport = () => {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:760px;height:900px;overflow:auto;padding:16px'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <I18nProvider>
      <ToastProvider>
        <ImportPane />
      </ToastProvider>
    </I18nProvider>
  )
}

window.__unmountImport = () => {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
}