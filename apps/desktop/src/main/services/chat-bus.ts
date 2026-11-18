import { EventEmitter } from 'node:events'
import type { ChatRemoteChange } from '../../shared/chat-protocol'
import type { ChatStreamEvent } from './chat'

/**
 * 主进程内部事件总线：会话流事件与应用级通知的唯一出口。
 * chat.ts 只管往总线上发，不关心谁在听——渲染层转发（registerChatIpc 内）是一个订阅者，
 * 远程通道（remote/hub.ts：飞书 / 以后的 Telegram …）是另一个。新增出口只需再订阅一次，不改编排层。
 *
 * 订阅者回调里绝不能抛错打断发布方（回合正在补结果 / 落盘），故 publish 逐个 try/catch 隔离。
 */

export interface ChatEventPayload {
  turnId: string
  sessionId: string
  event: ChatStreamEvent
}

/** 应用级通知（定时任务跑完 / 自动暂停 等）：系统通知之外，远程通道据此推送到手机。 */
export interface AppNotice {
  title: string
  body: string
  /** 关联的对话（远程端可一键切过去查看）。 */
  sessionId?: string
  /** 正文只是该对话刚结束那一轮回复的摘要（定时任务跑完）：已把那轮作为正常回复收到的私聊不必再推。 */
  echoesReply?: boolean
}

const bus = new EventEmitter()
// 订阅者数量随通道增长（渲染层 + 每个 IM 适配器），默认上限 10 会误报泄漏。
bus.setMaxListeners(50)

function subscribe<T>(topic: string, listener: (p: T) => void): () => void {
  const safe = (p: T): void => {
    try {
      listener(p)
    } catch (e) {
      console.warn(`[chat-bus] ${topic} 订阅者异常：`, (e as Error)?.message ?? e)
    }
  }
  bus.on(topic, safe)
  return () => bus.off(topic, safe)
}

export function publishChatEvent(p: ChatEventPayload): void {
  bus.emit('chat', p)
}

export function onChatEvent(listener: (p: ChatEventPayload) => void): () => void {
  return subscribe('chat', listener)
}

export function publishAppNotice(n: AppNotice): void {
  bus.emit('notice', n)
}

export function onAppNotice(listener: (n: AppNotice) => void): () => void {
  return subscribe('notice', listener)
}

/**
 * 对话清单在回合之外变了（手机上 /new 建出的空对话、删角色时定时任务对话改挂 Deva）。经回合新建的不必发：首轮 turn_start 已会让渲染层刷新列表。
 */
export function publishSessionsChanged(): void {
  bus.emit('sessions')
}

export function onSessionsChanged(listener: () => void): () => void {
  return subscribe<void>('sessions', listener)
}

/**
 * 工作区（git worktree）清单变了：创建成功、删除、状态变化。
 *
 * 与 `sessions` 分开一个 topic 而不是复用它：两个清单的生命周期与订阅方不同——worktree 列表只在
 * 工作区相关界面用，没必要让每个会话列表的订阅者也跟着重渲染。
 */
export function publishWorktreeChanged(): void {
  bus.emit('worktree')
}

export function onWorktreeChanged(listener: () => void): () => void {
  return subscribe<void>('worktree', listener)
}

/**
 * worktree 长操作的进度。
 *
 * - `waiting-lock`：等 Git 锁超过 5 秒（spec §5.1 第 7 条 / B6）——界面说「正在等另一个会话的 git 操作完成」。
 * - `install-deps`：依赖安装进行中（spec §3.6 / B4）——界面显示当前命令与已用时长。
 */
export type WorktreeProgress =
  | {
      phase: 'waiting-lock'
      /** 占着锁的那一头；拿不到（刚释放）时为 null。 */
      holder: { label: string; since: number } | null
    }
  | {
      phase: 'install-deps'
      /** 哪个工作区在装。 */
      path: string
      /** 当前动作（命令名）。 */
      step: string
      /** 已用毫秒。 */
      elapsedMs: number
    }

/**
 * 发一条 worktree 进度。用于「等锁超过 5 秒」这类场景（spec §5.1 第 7 条 / B6）：
 * 界面据此显示「正在等另一个会话的 git 操作完成」，而不是看起来冻住。
 */
export function publishWorktreeProgress(p: WorktreeProgress): void {
  bus.emit('worktree-progress', p)
}

export function onWorktreeProgress(listener: (p: WorktreeProgress) => void): () => void {
  return subscribe<WorktreeProgress>('worktree-progress', listener)
}

/**
 * 一轮进行中又有一步落进了对话记录（助手这一步的正文与工具调用、工具结果，随即落盘）。
 * 流事件先于落盘发出，远程端要按对话记录补拉最新内容时，以这里为准。
 */
export function publishStepSaved(sessionId: string): void {
  bus.emit('step', sessionId)
}

export function onStepSaved(listener: (sessionId: string) => void): () => void {
  return subscribe<string>('step', listener)
}

/** 某对话被看过了（电脑或手机）：手机端据此刷新未读红点。source = 在哪一端看的。 */
export interface ReadChange {
  sessionId: string
  at: number
  source: 'desktop' | 'remote'
}

export function publishReadChanged(c: ReadChange): void {
  bus.emit('read', c)
}

export function onReadChanged(listener: (c: ReadChange) => void): () => void {
  return subscribe<ReadChange>('read', listener)
}

/** 手机等别的设备改了对话（看过 / 删除 / 归档 / 改模型）：转给渲染层同步（见 read-sync.ts）。 */
export function publishRemoteChange(c: ChatRemoteChange): void {
  bus.emit('remote', c)
}

export function onRemoteChange(listener: (c: ChatRemoteChange) => void): () => void {
  return subscribe<ChatRemoteChange>('remote', listener)
}
