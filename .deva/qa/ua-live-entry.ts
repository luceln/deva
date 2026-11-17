/**
 * 实测入口：走真实的 providerHeaders + 真实的 httpFetch（Node 原生 fetch），
 * 打到一个本地服务上。装配方式与 providers/openai.ts:196 一致（content-type + authorization + ...cfg.headers）。
 */
import { providerHeaders } from '../../apps/desktop/src/main/providers/opencode'

export async function probe(base: string): Promise<Record<string, string>> {
  // 与 providers/index.ts:75 同一条调用；base 指向本地服务，isOpencodeInference 为 false，
  // 所以这里只验 UA 这一项（会话头只对 opencode.ai 加）。
  const cfgHeaders = providerHeaders(base, 'sess-test-1')
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer test-key',
    ...cfgHeaders
  }
  await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'x', messages: [] })
  })
  return cfgHeaders
}
