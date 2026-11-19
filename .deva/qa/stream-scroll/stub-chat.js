/**
 * store/chat 的桩（供 Conversation 依赖链里 import `/store/chat` 的模块使用）。
 *
 * 本用例的状态由 `entry.tsx` 的 Harness 直接以 props 喂给 `Conversation`，
 * 这里只需把依赖链上其它组件会读的字段都补成空值，别让它们读到 undefined 而崩。
 */
export function useChatStream() {
  return { messages: [], streaming: false, streamStatus: { elapsedSec: 0, reconnecting: null, compacting: false } }
}

export function useChatState() {
  return {
    messages: [],
    streaming: false,
    streamStatus: { elapsedSec: 0, reconnecting: null, compacting: false },
    todos: { active: null },
    currentSessionId: 's1',
    currentBinding: { focusRoot: null },
    sessions: [],
    brokenModels: {},
    memberProgress: [],
    pendingInserts: []
  }
}

export function useChatActions() {
  return {
    cancelTodoList: () => undefined,
    stopSubagent: () => undefined,
    insert: () => Promise.resolve(true),
    send: () => Promise.resolve(true),
    withdrawInserts: () => Promise.resolve({ text: '', attachments: [] })
  }
}

/** 草稿预览：Composer 之外也有引用。 */
export function useDraftPreview() {
  return null
}
