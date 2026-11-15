/**
 * 「打开 设置 › 模型」的单点入口。
 *
 * 为什么单独做一小块：调用方是输入框里的模型失效对话框（Composer → ModelPicker → ModelSwapDialog），
 * 而设置面板由外壳（ChatFirstShell）掌管。为这一个按钮从外壳逐层把回调传四级下来，会把签名塞满
 * 与它无关的组件；这里沿用 restoreToComposer 那套「模块级登记一个实现」的写法：外壳启动时登记，
 * 深处直接调。没登记时静默无操作（理论上不会发生——外壳先于对话区挂载）。
 */
let opener: (() => void) | null = null

/** 外壳启动时登记「打开设置 › 模型」的实现。 */
export function registerModelSettingsOpener(fn: (() => void) | null): void {
  opener = fn
}

/** 打开设置 › 模型（模型失效对话框里「去填密钥」的落点）。 */
export function openModelSettings(): void {
  opener?.()
}
