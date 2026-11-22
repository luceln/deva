/**
 * 导入新状态 —— 浏览器验证页的入口。
 *
 * 挂**真实的 `ImportPane`** 与**真实的 `ModelSwapDialog`**，只替换 IPC / store 桩。
 * 两个组件各用一个宿主 div，避免同时挂载时 querySelector 命中对方的节点。
 */
import { createRoot } from 'react-dom/client'
import { ImportPane } from '../../../apps/desktop/src/renderer/src/redesign/ImportPane'
import { ModelSwapDialog } from '../../../apps/desktop/src/renderer/src/redesign/ModelSwapDialog'
import { __resetImportSession } from '../../../apps/desktop/src/renderer/src/redesign/importSession'
import { I18nProvider } from '../../../apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from '../../../apps/desktop/src/renderer/src/components/ToastProvider'
import { DialogProvider } from '../../../apps/desktop/src/renderer/src/components/DialogProvider'

let importRoot = null
let importHost = null
let swapRoot = null
let swapHost = null

window.__resetImportSession = __resetImportSession

function teardownImport() {
  if (importRoot) {
    importRoot.unmount()
    importRoot = null
  }
  if (importHost) {
    importHost.remove()
    importHost = null
  }
}

function teardownSwap() {
  if (swapRoot) {
    swapRoot.unmount()
    swapRoot = null
  }
  if (swapHost) {
    swapHost.remove()
    swapHost = null
  }
}

window.__unmountAll = () => {
  teardownImport()
  teardownSwap()
}

/** 只卸导入面板：「切到别的设置页」用。 */
window.__unmountImportOnly = teardownImport

window.__mountImport = () => {
  teardownImport()
  importHost = document.createElement('div')
  importHost.id = 'host-import'
  importHost.style.cssText = 'position:fixed;left:0;top:0;width:780px;height:920px;overflow:auto;padding:16px'
  document.body.appendChild(importHost)
  importRoot = createRoot(importHost)
  importRoot.render(
    <I18nProvider>
      <ToastProvider>
        <ImportPane />
      </ToastProvider>
    </I18nProvider>
  )
}

/**
 * 打开真实替换对话框并**立即执行一次替换**（用例已通过 __swapResult 指定返回）。
 * 真实组件要先选目标模型才能点「替换」，这里走同一条 UI 路径：点开 Select 再点候选。
 */
window.__mountSwap = (result) => {
  teardownSwap()
  window.__swapResult = result
  window.__setChat({
    brokenModels: {
      s1: [{ sessionId: 's1', name: '主对话', ref: 'anthropic:claude', kind: 'model-disabled' }]
    }
  })
  swapHost = document.createElement('div')
  swapHost.id = 'host-swap'
  swapHost.style.cssText = 'position:fixed;left:800px;top:0;width:620px;height:920px;overflow:auto;padding:16px'
  document.body.appendChild(swapHost)
  swapRoot = createRoot(swapHost)
  swapRoot.render(
    <I18nProvider>
      <ToastProvider>
        <DialogProvider>
          <ModelSwapDialog mainId="s1" fromRef="anthropic:claude" onClose={() => {}} />
        </DialogProvider>
      </ToastProvider>
    </I18nProvider>
  )
}