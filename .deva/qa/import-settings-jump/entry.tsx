/**
 * 「去设置 › 模型重填」点击实测：复刻外壳的 openSettings 逻辑 + 真实 Settings 面板。
 *
 * 验的是这条链：
 *   用户此刻站在「设置 › 导入」页 → ImportPane（它就渲染在 Settings 内部）里的按钮
 *   → openModelSettings() → 外壳 openSettings({ section: 'models' })
 *   → setSettingsInit(...) + setSettingsOpen(true)
 *   → ???
 *
 * 外壳的 settingsOpen 早就是 true（用户正在设置里），所以真正起作用的只有 setSettingsInit。
 * 而 Settings 里 section 是 useState(initial?.section) —— 初值只在挂载时读一次。
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Settings, type SettingsInit } from 'E:/deva/apps/desktop/src/renderer/src/redesign/SettingsPane'
import { registerModelSettingsOpener } from 'E:/deva/apps/desktop/src/renderer/src/redesign/modelSettingsBus'
import { ModelsProvider } from 'E:/deva/apps/desktop/src/renderer/src/store/models'
import { I18nProvider } from 'E:/deva/apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from 'E:/deva/apps/desktop/src/renderer/src/components/ToastProvider'
import { ThemeProvider } from 'E:/deva/apps/desktop/src/renderer/src/theme/ThemeContext'
import { DialogProvider } from 'E:/deva/apps/desktop/src/renderer/src/components/DialogProvider'

/** 复刻 ChatFirstShell:215-233 的外壳逻辑（含 settingsNonce 修复，逐行照抄）。 */
function Shell(): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInit, setSettingsInit] = useState<SettingsInit>({})
  const [settingsNonce, setSettingsNonce] = useState(0)
  const openSettings = (init: SettingsInit = {}): void => {
    setSettingsInit(init)
    setSettingsNonce((n) => n + 1)
    setSettingsOpen(true)
  }
  // 与外壳一致：useEffect 登记，卸载时撤掉（不能只用一次性标记——重挂后 opener 会指向已卸载的组件）
  useEffect(() => {
    registerModelSettingsOpener(() => openSettings({ section: 'models' }))
    return () => registerModelSettingsOpener(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  ;(window as any).__openSettings = openSettings
  return (
    <>
      <button
        id="outside"
        onClick={() => openSettings({ section: 'import' })}
        style={{ position: 'fixed', left: 0, top: 0, zIndex: 9999 }}
      >
        打开设置›导入
      </button>
      {settingsOpen && (
        <Settings
          key={settingsNonce}
          initial={settingsInit}
          onClose={() => {
            setSettingsOpen(false)
          }}
        />
      )}
    </>
  )
}

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null

window.__mount = () => {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:900px'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <DialogProvider>
            <ModelsProvider>
              <Shell />
            </ModelsProvider>
          </DialogProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  )
}
