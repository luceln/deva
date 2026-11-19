/** modelSettingsBus 桩：用例不验跳转，只验按钮存在。 */
export function openModelSettings() {
  window.__openedModelSettings = (window.__openedModelSettings || 0) + 1
}
export function registerModelSettingsOpener() {}
