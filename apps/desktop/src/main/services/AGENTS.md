# main/services/AGENTS.md

主进程的业务层：工具实现、Agent 循环、会话持久化、记忆、任务、导入导出。约 100 个文件平铺，
没有子模块——找东西靠文件名，不靠目录层级。父级约定见仓库根 `AGENTS.md`，此处只写目录内部的东西。

## 必须复用的实现

| 要做的事 | 用哪一处 |
| --- | --- |
| 工具实现 | `tools.ts` 的 `toolHandlers`（`Record<name, handler>`，`hasOwnProperty` 查表，别写 if/else） |
| 闸门前处理 | `agent-loop.ts` 的 `buildLoopTools` 返回表 |
| 会话落盘 | `chat-store.ts` 的 `save` / `saveOutcome`（返回 `SaveOutcome` 三态，不是布尔） |
| 历史改写锁 | `chat-locks.ts` 的 `historyLocked()`；`chat-state.ts:19` 只是转导出 |
| 配置类写盘 | `atomic-write.ts` 的 `writeFileAtomic()` |

## 这个目录特有的坑

**写盘：`writeFileAtomic()` 是既定实现，但目前有三处例外**——`memory.ts`、`tasks.ts`、
`media-store.ts` 各自手写了 `tmp + renameSync`（各有其格式与回滚理由，见文件内注释）。
**新代码不许再加第四处**；要原子写就调 `writeFileAtomic()`。

**`historyLocked()` 的检查点在调用方，不在被调方。** `compaction.ts` 里 grep 不到它——
压缩的锁检查在 `chat.ts` 的压缩 IPC 入口（`compacting.add` 之前），`chat-store.ts` 在 `save` 前自查。
新增会改写历史（删轮 / 压缩 / 回滚 / 开始回合）的入口时，**检查要加在你自己的入口上**，
不要指望被调的 store 函数替你拦。目前已检查的位置：`chat.ts`、`chat-store.ts`、`chat-turns.ts`、
`chat-members.ts`、`background-tasks.ts`、`chat-task-handoff.ts`、`importer-sessions.ts`。

**`chat-state.ts` 与 `chat-locks.ts` 是两套东西。** 前者放多模块共用的会话状态与 `pendingAsk` /
`pendingPlan` / `activeTurns` 等；后者的三个 `Set`（`busySessions` / `compacting` / `rewinding`）
才是锁。只被一个模块用的状态留在那个模块，不要往 `chat-state.ts` 堆。
