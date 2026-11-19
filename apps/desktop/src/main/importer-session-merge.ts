/**
 * 已存在的会话，这次要不要用源覆盖它——纯逻辑，不碰磁盘。
 *
 * ## 为什么不用时间戳
 *
 * 时间戳有三种，都不可靠：
 *  - **文件 mtime**：`copyFileSync` 会保留源 mtime，而另一处代码复制后 `utimesSync` 刷当前时间
 *    （那是修「源超保留期被清扫删空」的 P0）。这套代码会主动改写 mtime，它不反映内容。
 *  - **`updatedAt`**：它在**两边**都会被自己的应用更新。原版聊过 → 源更新；本应用聊过 → 目标更新。
 *    先聊后聊是**分叉**，不是「谁新用谁」——拿它当判据，两边都写过时必定丢一边。
 *  - **`lastRequestAt`**：只在请求时写，编辑标题之类不更新它。
 *
 * ## 判据：目标的内容必须是源的前缀
 *
 * 只有当**目标的每一条消息都能在源的开头按序找到**、且源更长（或有差异地更长）时，才说明
 * 「源是在这份目标的基础上继续聊出来的」，覆盖不会丢掉目标里的任何内容。
 *
 * 其余一律不覆盖：
 *  - 目标有自己的消息（在本地聊过）→ 覆盖会删掉用户的对话
 *  - 两边都有对方没有的（分叉）→ 无论覆盖哪边都丢内容
 *
 * 这直接对应用户的诉求：「要区分用户有没有在二开版聊过，不能直接覆盖」。
 *
 * ## 消息没有 id
 *
 * 会话里的消息是 `{role, content}`，**没有稳定 id**（实测：983 条消息的会话，字段只有
 * `role` / `content`）。所以只能按内容逐条比：`role` 相同且 `content` 序列化后相同，即视作同一条。
 * `content` 可能是字符串，也可能是多模态的数组，统一用 `JSON.stringify` 比。
 */

/** 判定需要的会话形状（只取用到的两段，便于测试构造）。 */
export interface SessionShape {
  /** 消息数组；不是数组时按空处理（调用方已保证是有效会话）。 */
  messages?: unknown
}

/** 一次判定的结论。 */
export type ExistingDecision =
  /** 内容完全相同：什么都不用做。 */
  | 'same'
  /** 源是目标的严格超集：可以安全覆盖，目标里的东西一条都不会丢。 */
  | 'source-newer'
  /** 目标有自己的内容（本地聊过 / 删过）：**不能覆盖**。 */
  | 'target-diverged'
  /** 两边各有对方没有的内容：无论覆盖哪边都要丢东西。 */
  | 'both-diverged'

/** 一条消息的比较键。内容序列化，兼顾字符串与多模态数组。 */
function messageKey(m: unknown): string {
  if (!m || typeof m !== 'object') return JSON.stringify(m) ?? ''
  const rec = m as { role?: unknown; content?: unknown }
  return `${typeof rec.role === 'string' ? rec.role : ''}\u0000${JSON.stringify(rec.content) ?? ''}`
}

/** 读取消息数组；不是数组时按空数组（「没有消息」）处理。 */
function messagesOf(s: SessionShape): unknown[] {
  return Array.isArray(s.messages) ? s.messages : []
}

/**
 * 目标作为源的前缀，能对上多少条。
 *
 * 返回首个不一致的下标；全部对得上时返回较短那一边的长度。
 * 一旦不一致就停，不必比完——剩下多长都不影响结论。
 */
function commonPrefixLength(target: unknown[], source: unknown[]): number {
  const shorter = Math.min(target.length, source.length)
  for (let i = 0; i < shorter; i++) {
    if (messageKey(target[i]) !== messageKey(source[i])) return i
  }
  return shorter
}

/**
 * 目标已存在时，这次到底怎么处理。
 *
 * 只认四种结论，都不依赖时间：
 *
 * | 结论 | 条件 | 动作 |
 * |---|---|---|
 * | `same` | 消息数组逐条相同 | 跳过 |
 * | `source-newer` | 目标是源的前缀，且源更长 | **覆盖**（安全：源包含目标全部内容）|
 * | `target-diverged` | 目标是源的前缀，但目标更长 | 不覆盖（本地聊过）|
 * | `both-diverged` | 前缀就断了：两边各有对方没有的 | 不覆盖（分叉）|
 *
 * ⚠️ `target-diverged` 与 `both-diverged` 都**不覆盖**。宁可不同步，也不能删掉用户在本应用里的对话
 * ——不同步的代价是「内容旧一点、用户自己能看出来」，覆盖的代价是「对话消失、用户不知道」。
 */
export function decideExisting(target: SessionShape, source: SessionShape): ExistingDecision {
  const t = messagesOf(target)
  const s = messagesOf(source)
  const common = commonPrefixLength(t, s)
  const shorter = Math.min(t.length, s.length)

  if (common < shorter) return 'both-diverged'
  if (t.length === s.length) return 'same'
  return s.length > t.length ? 'source-newer' : 'target-diverged'
}