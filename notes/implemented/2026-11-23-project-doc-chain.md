# 项目说明沿目录链发现并注入

> 状态：已落地（`main/services/project-doc.ts`）
> 日期：2026-11-23

## 问题

原来只注入一份 `AGENTS.md`（项目根）。嵌套的 `AGENTS.md` 写好了也没用 —— 模型看不到，
等于白写。dsh（`E:\deepseek-harness`）有 32 个嵌套 `AGENTS.md`，靠这套做「最近的赢」。

## 关键判断纠正：不是「祖先链」，是「子树」

任务书写的是照抄 dsh 的 `ancestorChain(root, cwd)` —— 只读 `projectRoot → cwd` 这条链上的文件。

**但本项目没有独立的 cwd**：`chat-turns.ts:638` 是 `workDir = { root: effectiveRoot }`，
root 和 cwd 是同一个值。照抄的后果是这条链**只有一级**，行为和改动前一模一样。

→ 改成**向下扫子树**，这才是本项目需要的语义。

## 实现

```ts
export const PROJECT_DOC_MAX_DEPTH = 6            // 扫 6 层遍历 105 个目录、7.5ms
export const PROJECT_DOC_CHAIN_MAX_BYTES = 64 * 1024
export function loadProjectDocChain(root: string | null): ProjectDoc[]   // 宽→窄
export function budgetProjectDocChain(docs, maxBytes?)
```

- 深度定 6 的依据：扫 4 层只找到 3 份，扫 6 层找到 7 份全部装得下
- `ProjectDoc` 只加可选字段 `dir?: string`，其余不动
- 保留 `loadProjectDoc`（`git.ts:997`、`workspace-mount.ts:93` 仍在用单份场景）
- `projectDocPromptSection` 做成重载，老签名不变
- 调用点 3 处：`chat-prompts.ts:388`、`chat-turns.ts:717/719`

## 预算策略（照 dsh）

超限时**从最宽的整份丢弃**，不做部分截断。被丢的列出路径、不给内容。

整份丢弃的理由：截断过的 `AGENTS.md` 会让模型读到半条规则，比读不到更糟 ——
它会以为自己知道这条约定，实际只看到前半句。

## 一条不能破的不变量

**单份场景下，注入字符串必须与改动前逐字节相同**（812 字节 / 4 行）。

原因：提示缓存按前缀匹配。多一个空格就整段缓存失效，每轮都要重新计费。
这个不变量在本轮改动中被踩破过两次：

1. 删了「近者优先」后半句 → 362 变成 317 字节
2. 丢了 `read_file` 的具体路径

两次都已退回。判据 `check-project-doc-chain.cjs` 守着这条。

## 实测数字

| 场景 | 注入字节 |
| --- | --- |
| 单份（改动前 = 改动后） | 5844 |
| 链式（7 份全装下） | 19213 |

净增 13369 字节，约 +3.3k token。

## 留下的缺口

**没做 dsh 的 `descendantDirsBetween` 动态补读层。**

dsh 的做法：模型实际碰到某个路径时（`touchedPaths`，`index.ts:104 stepTouches` 记录），
才把那个目录链上的说明补读进来。

我们现在是**每轮一次性扫 6 层内全部**，不管模型这轮碰了什么。仓库越大越浪费。

补齐它要接进 `agent-loop.ts` 的工具结果处理，属于改产品代码。当前 +3.3k token 还能接受，
等仓库再大些再做。

## 判据

`.deva/qa/check-project-doc-chain.cjs`：**30 PASS / 0 FAIL**，做过 5 轮反向验证。

## 何时重看这份记录

- 改 `project-doc.ts` 或注入预算时
- 发现提示缓存命中率下降时（先查单份不变量是否破了）
- 想补 `descendantDirsBetween` 时
