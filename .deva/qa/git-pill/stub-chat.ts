/**
 * store/chat 的桩：GitWidget 只从 useChatState 取 currentBinding.model（选生成提交信息的模型）。
 * 真实 ChatProvider 挂载时会打一串 chat.* IPC，与本用例无关，故整模块替换。
 */
export function useChatState(): {
  currentBinding: { personaId?: string; focusRoot: string | null; model?: string }
} {
  return { currentBinding: { focusRoot: null } }
}
