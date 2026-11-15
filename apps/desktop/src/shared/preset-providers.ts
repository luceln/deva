/**
 * 应用自带的预置服务商 id（单一事实来源）。
 *
 * 为什么要单独放 shared：渲染层的种子清单在 `renderer/src/mock/models.ts` 的 `seedProviders`（含地址/协议/文档链接，
 * 体积大且依赖渲染层类型），主进程引不到；而主进程的导入统计需要知道「哪些 id 是应用自带的」——从原版 Deva 导入时，
 * 这 11 个预置服务商在二开版启动时就已被种进 config，不该算作用户导入的东西。
 *
 * 若主进程自己硬编码一份，两份清单必然漂移（加一个预置服务商时只改了一边），统计就会错。所以 id 清单落在 shared，
 * `mock/models.ts` 只做**一致性自检**：它才是真正定义连接信息的地方，两边不一致时开发期就能看到告警。
 *
 * ⚠️ 这里只放 id，不放地址/协议——连接信息仍以 `seedProviders` 为准，避免同一份数据两处维护。
 */
export const PRESET_PROVIDER_IDS: readonly string[] = [
  'anthropic',
  'openai',
  'openai-responses',
  'gemini',
  'deepseek',
  'moonshot',
  'zhipu',
  'qwen',
  'opencode-go',
  'ollama',
  'typesafe'
]

const PRESET_SET = new Set(PRESET_PROVIDER_IDS)

/** 该服务商 id 是否属于应用自带（导入统计据此排除，不计入「新增 / 跳过」）。 */
export function isPresetProviderId(id: string): boolean {
  return PRESET_SET.has(id)
}
