/**
 * 模型失效与批量替换：渲染层侧的类型再导出 + 一点兜错。
 *
 * 类型本身住在 `shared/chat-protocol.ts`（主进程 / preload / 渲染层三方共用），这里只再导出，
 * 免得调用方满仓库追 `../../../shared/chat-protocol` 的层级。
 *
 * 判定（哪些引用失效、失效原因）只在主进程的 `model-availability.ts` 里做，渲染层只消费 scan 的结果——
 * 在这里按 store/models 的 providers 自己算一遍，两套规则迟早漂移（`resolveRefStrict` 曾只查 id 不看
 * enabled 就是现成的例子）。
 */

import type { BlockedProviderRef, BrokenRef, ModelSwapResult } from '../../../shared/chat-protocol'

export type {
  AvailabilityKind,
  AvailabilityResult,
  BlockedProviderRef,
  BrokenRef,
  ModelSwapResult
} from '../../../shared/chat-protocol'

/**
 * 扫某对话（主对话 + 名下成员会话）里引用已失效的会话。只读。
 * 出任何错都回空数组：拿不到结论时界面保持原样（不标红），绝不能因为一次扫描失败就把用户的会话标成
 * 「模型不可用」。
 */
export async function scanModelSwap(mainId: string): Promise<BrokenRef[]> {
  try {
    return await window.deva.chat.scanModelSwap({ mainId })
  } catch {
    return []
  }
}

/**
 * **全量**服务商里密钥用不了的（`nokey` / `keyunreadable`），不论有没有会话引用它。
 *
 * 候选集要据此排除：只从 scan 结果反推会漏掉「缺密钥但没有会话在用」的服务商，用户换过去还是不能用（B4）。
 * 出错回空数组：拿不到结论时宁可多列几个候选（用户在 apply 时会被主进程的 isUsableRef 再拦一次），
 * 也不能因为一次读取失败就把所有服务商从候选里删光。
 */
export async function loadBlockedProviders(): Promise<BlockedProviderRef[]> {
  try {
    return await window.deva.chat.blockedProviders()
  } catch {
    return []
  }
}

/** 把某对话里引用 fromRef 的会话换成 toRef（主进程只改引用相等的会话，见 model-swap.ts）。 */
export async function applyModelSwap(
  mainId: string,
  fromRef: string,
  toRef: string
): Promise<ModelSwapResult | { error: string }> {
  try {
    return await window.deva.chat.applyModelSwap({ mainId, fromRef, toRef })
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) }
  }
}
