/**
 * features/browser/shared 的桩：Composer 只通过 BrowserCapsule 用到 `useBrowserState` 与 `PagesPanel`。
 * 本用例不验浏览器胶囊，给空状态与空面板即可（不挂真实 IPC）。
 */
export function useBrowserState(): null {
  return null
}

export function PagesPanel(): null {
  return null
}