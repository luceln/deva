# main/providers/AGENTS.md

模型供应商适配层：把统一的 `GenerateRequest` 转成各家协议，把响应流还原成统一的 `StreamEvent`。
三个适配器 `anthropic.ts` / `openai.ts` / `openai-responses.ts`，共用 `request.ts` / `sse.ts` / `types.ts`。
统一入口是 `index.ts` 的 `streamChat`。父级约定见仓库根 `AGENTS.md`。

## 必须复用的实现

| 要做的事 | 用哪一处 |
| --- | --- |
| 发请求 | `request.ts` 的 `fetchModel`（已带响应超时与错误正文限时，**不要直接用 `httpFetch`**） |
| 读流 | `sse.ts` 的空闲看门狗（`STREAM_IDLE_MS`），别自己解 chunk |
| 消息归一 | `index.ts` 的 `normalizeMessages`（消弭连续同角色，对严格网关稳健） |
| 密钥 | `../services/secrets` 的 `readSecret`，见下方三态 |
| 新增供应商 | 在 `index.ts` 的 `AdapterKind` 加分支 + 对应适配器文件，不要在主循环里特判 |

## 这个目录特有的坑

**密钥必须分三态处理，不能把「读不出」当成「没配过」。** `streamChat` 里 `readSecret` 返回
`absent` 时以空串继续（本地 Ollama 这类可无钥服务靠这个工作）；`unreadable` / `store-unreadable`
必须立刻 yield `auth` 错误并说清原因。压成一种的话，用户会拿到一条误导性的 401，
被引向「密钥填错了」，而真正要做的是重填或装 libsecret。

**不要在各适配器里自己加超时。** 等待响应头的上限（10 分钟）在 `request.ts`，理由写在文件注释里
（经代理 / VPN 时本机连接活着、上游已断，不设上限会整夜停在「进行中」）。适配器里再套一层
会与它冲突，也会让「可重试的网络错误」判定不一致。

**`dsml.ts` 是 DeepSeek 的专属补丁，只在带工具的请求上生效。** `streamChat` 里按
`req.tools?.length` 决定是否 `recoverDsmlCalls`；不带工具的一次性调用（压缩摘要、提交信息）
原样透传。新增「恢复某家模型畸形输出」的类似逻辑时，照这个开关方式做，不要无条件套在所有请求上。
