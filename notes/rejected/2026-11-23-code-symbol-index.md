# 不做代码符号索引

<!-- doclink:foreign -->
<!-- 本文引用的 scripts/gen-module-graph.ts 在 E:\deepseek-harness 内，不在本仓 -->

> 状态：**否决**（讨论过，决定不做）
> 日期：2026-11-23

## 被否的方案

给仓库建代码符号索引：tree-sitter / ast-grep / ts-morph 解析出所有函数、类、导出的位置，
生成可查询的符号表或 repomap，让 AI 能按符号找代码，而不是靠读文件。

## 为什么不做

### 1. 先看参照物：dsh 11 万行都不做

`E:\deepseek-harness`（11 万行 / 32 个 workspace 包）**没有**代码符号索引。逐项查过：

- `package.json` / `pnpm-lock.yaml` 里无 tree-sitter、ast-grep、ts-morph、scip
- 全仓无 repomap
<!-- doclink:foreign 该路径在 E:\deepseek-harness 内，不在本仓 -->
- 唯一的「图」是 dsh 自己的 `scripts/gen-module-graph.ts`，从 workspace `peerDependencies` 生成 mermaid
  **包依赖图**，只画包关系、不含任何符号

它解决 AI 找模块与复用问题靠的是「写文件」：
32 个嵌套 `AGENTS.md`、`docs/` 下 47 个 md、`.agents/notes/` 决策记录（4211 个文件全部入库跟踪）、
`.agents/skills/` 22 个可执行动作技能、jscpd 查重拦截。

**10 万行级项目靠文档串联 + 嵌套约定 + 查重拦截就够用** —— 这是最有力的证据。

### 2. 维护成本大于收益

符号索引的失效模式很坏：

- 索引过期 → 模型按索引去找，代码已经移走了 → 比没有索引更浪费时间
- 索引不全（动态 import、条件导出、monorepo 路径别名）→ 模型以为不存在
- 解析失败（TS 语法边角、`.tsx` 里的泛型）→ 静默漏项

而它的收益只是「少读几个文件」。在**已有一份准确的 `AGENTS.md` 能力→唯一实现表**的前提下，
模型知道该去哪个文件，本来就不需要靠符号搜索。

### 3. 本仓的规模撑不起它

本仓 `apps/desktop/src/` 的模块数量远小于 dsh 的 32 个包。
`AGENTS.md` 里那张 8 行的「能力 → 唯一实现」表已经覆盖了最容易找错的地方
（工具登记、历史锁、写盘、项目说明注入、记忆读写、路径归一化、i18n）。

## 替代方案（已在用）

| 做法 | 产物 |
| --- | --- |
| 嵌套 `AGENTS.md` | 根 87 行 + 6 个目录各 22-35 行 |
| 决策记录 | 根 `notes/`，`proposed` / `implemented` / `rejected` / `archived` |
| 链式注入 | `project-doc.ts` 向下扫 6 层、64 KiB 预算 |
| 查重拦截 | jscpd + baseline，只拦新增 |
| 文档链接判据 | `check-doc-links.cjs`，104 处引用零悬空 |

## 什么情况下该重新评估

前提变了才重看，**不要因为「感觉该有」就重提**：

1. 单文件超过 1500 行的情况变得普遍（当前 `AGENTS.md` 要求 800 行就开始拆）
2. `AGENTS.md` 那张表膨胀到 30 行以上，说明靠人维护已经跟不上
3. 模型开始频繁找错文件（可从失败案例统计，而不是靠印象）

## 相关

- 已落地：[项目说明沿目录链发现并注入](../implemented/2026-11-23-project-doc-chain.md)
- 已落地：[查重检查 exitCode 陷阱](../implemented/2026-11-23-duplication-gate.md)
- 参照物资料：`E:\deepseek-harness`（外部仓库，不在本仓）
