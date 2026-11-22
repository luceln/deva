/** modelSettingsBus 桩：本用例不验跳转。 */
export function openModelSettings() {
  window.__openedModelSettings = (window.__openedModelSettings || 0) + 1
}
export function registerModelSettingsOpener() {}