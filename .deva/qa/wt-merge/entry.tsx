/**
 * 合并面板（MergePanel）的浏览器用例。
 *
 * 分两类：
 *  - **纯函数**（`mergeCommand` / `abortCommand`）：规格里逐字规定了命令内容，直接断言字符串。
 *  - **渲染**：用受控的假 `MergeResult` 驱动面板，验那些「做错会被打回」的硬约束。
 */
import { createRoot } from 'react-dom/client'
import { MergePanel, mergeCommand, abortCommand } from 'E:/deva/apps/desktop/src/renderer/src/redesign/MergePanel'
import { I18nProvider } from 'E:/deva/apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from 'E:/deva/apps/desktop/src/renderer/src/components/ToastProvider'
import type { WorktreeListItem } from 'E:/deva/apps/desktop/src/shared/worktree-protocol'

function mkView(): WorktreeListItem {
  return {
    compareKey: 'k',
    path: 'C:\\repo\\wts\\feat',
    branch: 'deva/req-worktree-ui',
    targetBranch: 'my/dev',
    state: 'ok',
    deps: { state: 'ready' },
    sessionCount: 0,
    sizeBytes: null,
    lockHolder: null,
    dirtyCount: 0,
    mergeGate: { mayMerge: true },
    mergeInProgress: null
  } as unknown as WorktreeListItem
}

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null

window.__mountMerge = (v?: Partial<WorktreeListItem>) => {
  if (root) {
    root.unmount()
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  host = document.createElement('div')
  host.style.cssText = 'width:760px;padding:16px'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <I18nProvider>
      <ToastProvider>
        <MergePanel view={{ ...mkView(), ...(v ?? {}) } as WorktreeListItem} onClose={() => {}} onMerged={() => {}} />
      </ToastProvider>
    </I18nProvider>
  )
}

window.__mergeCommand = mergeCommand
window.__abortCommand = abortCommand

// test.ts 在挂载辅助就绪后自己跑（它用 window.__mountMerge）
import './test'
