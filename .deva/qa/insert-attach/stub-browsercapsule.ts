/**
 * BrowserCapsule 的桩：本用例验的是输入框附件与插话，浏览器胶囊与它无关。
 * 它的真实实现要一整套 `window.deva.browser.*` API（onLiveFrame / setPreviewPinned / …），
 * 逐个打桩只会让本用例的桩面越铺越大，与用例目标无关——直接替换成不渲染。
 */
export function BrowserCapsule(): null {
  return null
}