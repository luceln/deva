# 导入功能提交计划（按 magpie 小步原则）

> 依据：magpie 一天 220 次提交不崩，靠的是**每个改动很小、马上提交**。
> 我们反过来攒了 36 个文件 2440 行，这是三轮变五轮的根本原因。
> 目标：拆成 6 个可独立回退的提交，让下一次改动只面对一小片代码。

## 前置条件（必须等）

- [ ] 主进程「修 getSecret 三态与 withTypes」完成
- [ ] 验收第三轮完成并判 PASS
- [ ] `pnpm typecheck` + `pnpm build` 通过
- [ ] `node .deva/qa/scan-same-class.cjs` 通过

**现在不能提交**：`secrets.ts` 有 86 行新增（`SecretRead` 三态），是半成品。

## 已清理

- `ij-llms.txt`（0 字节，调研子智能体下载残留）— 已删
- `labelize-test-output.txt`（3736 字节，设计成员测试输出）— 已删

## 提交拆分（6 个）

按「一个提交一个目标」拆，每个都能独立回退。

### 1. `feat(import): 源侧读取区分「没有」与「读不出」`

**文件**：
- 新增 `apps/desktop/src/main/importer-source-dir.ts`
- `importer-sessions.ts`、`importer-personas.ts`、`importer-skills.ts`、`importer-assoc.ts`、`importer-memory.ts` 的调用点

**内容**：`readSourceDir(dir, withTypes)` → `absent` / `ok{names,dirents}` / `unreadable`；失败码统一 `source-dir-unreadable`，目录身份放 `id`（`<data/chats>` 等）。覆盖 8 处（含 `copyAvatar` 与 `data/subagents`）。

**为什么单独**：这是本轮最大的一个模式，7+1 处复制品。回退它不影响其他修复。

### 2. `feat(import): 目标侧四态探测`

**文件**：
- 新增 `apps/desktop/src/main/importer-target.ts`
- `importer-assoc.ts`、`importer-sessions.ts`、`importer-personas.ts` 的调用点

**内容**：`inspectTarget()` / `inspectDirTarget()` / `backupBroken()` → `absent` / `usable` / `blocked` / `unreadable`。含尺寸校验、`copyFileFresh` 写完校验。

### 3. `fix(import): 收尾不清 sessionCache，避免在跑的对话丢盘`

**文件**：`services/chat-store.ts`（新增 `invalidateIndexOnly()`）、`importer.ts`

**内容**：P0-1。导入收尾改调只清索引的窄版本。含真机反向证据（旧语义丢盘 / 新语义不丢）。

**为什么单独**：这是数据丢失，最需要能精确回退。

### 4. `fix(import): 复制后刷新 mtime，避免被启动清扫删空`

**文件**：`importer-assoc.ts` 的 `copyFileFresh`

**内容**：P0-2。`copyFileSync` + `utimesSync(now)`。

### 5. `fix(memory): 记忆读写区分三态，未配与解不开分开`

**文件**：`services/memory.ts`、`services/secrets.ts`、`preload/index.ts`、`shared/config-protocol.ts`

**内容**：
- `readMemories` 三态，写入路径在 `unreadable` 时拒绝
- `SecretRead` 三态（`absent` / `ok` / `unreadable`），`decrypt-failed` 与 `no-encryption` 分开
- 新增错误码 `readFailed` / `writeFailed`

**注意**：这个提交含 `secrets.ts`，**必须在主进程改完之后才能做**。

### 6. `fix(import): 失败原因两端对齐，界面不再显示裸码`

**文件**：`renderer/src/redesign/ImportPane.tsx`、`renderer/src/i18n/messages.ts`、`renderer/src/redesign/SettingsPane.tsx`、`renderer/src/redesign/importBridge.ts`、`renderer/src/redesign/redesign.css`、`renderer/src/styles/app.css`

**内容**：`FAILURE_REASON_KEY` 补 12+ 条、`cf.profile.err.*` 文案、`skillSharedTip`、secrets 五类状态拆解。

### 7. `docs: 规则体系（AGENTS / MEMBERS / LESSONS）`

**文件**：`MEMBERS.md`（新）、`LESSONS.md`（新）；`AGENTS.md` 改动不进版本库（`.gitignore:31`）

**内容**：9 个成员章程、18 条教训、`Seen` 计数机制。

**注意**：`AGENTS.md` 被 gitignore 忽略，但每次对话照常下发。提交时不要试图 add 它。

## 提交信息格式（AGENTS.md 约定的）

```
<type>(<scope>): <中文简述> / <english summary>

- <中文改动点> / <english change>
```

硬性要求：中英双语；中文在前、` / ` 分隔；body 每条一行不折行；body 里不用 `**加粗**`。

## 每个提交的 body 必须含

```
验证：<命令> → <结果原文>
```

这是 magpie 的规矩：**提交 body 是跑了什么的唯一记录**，不写进 push notes 或对话。

## 拆分后要做的两件事

1. **让验收针对每个提交单独复验**——验证面小很多
2. **下一个需求开工前，把「≤200 行 / ≤6 文件」变成硬拦截**（`MEMBERS.md` 已有条款，但导入功能在它之前开工，从没执行过）

## 如果拆分太麻烦的退路

先做一个整体提交（`feat(import): 从原版一次性导入数据`），再另开一轮做拆分。

**但这条路的问题**：整体提交后没有干净的基准，下一轮改动的验证面还是那 36 个文件。

**建议还是拆。** 拆的代价是一两个小时，不拆的代价是下一轮再来三天。
