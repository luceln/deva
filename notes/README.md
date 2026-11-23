# 决策记录索引

规则见 [AGENTS.md](AGENTS.md)。**`archived/` 只读、不当现行依据。**

## implemented —— 已落地，可作现行依据

| note | 讲了什么 | 落地证据 |
|---|---|---|
| [worktree 并行开发规格](implemented/2026-11-18-worktree-parallel-spec.md) | 新建会话可选位置、独立 worktree、最小合并；取代 v3 口径与 v4 验收两份 | `main/services/worktree/` 15 文件、`preload/worktree.ts`、`WorktreePane.tsx` |
| [worktree 根目录自定义](implemented/2026-11-23-worktree-root-custom.md) | 根可设、创建限根内、删除不删根外、老记录放行并标注 | `worktree/root-setting.ts`、`precheck.ts:232` `path-outside-root`、`e84e564` + `cda8759` |
| [模型失效 UI 恢复](implemented/2026-11-18-model-swap-ui-restore.md) | 上游重写模型面板后，把失效标红 + 批量替换接回 `ModelPanel.tsx` | `ModelPanel.tsx:13-22,113-120`、`ModelSwapDialog` 已挂载 |
| [导入功能提交拆分](implemented/2026-11-18-import-commit-plan.md) | 按小步原则把导入功能拆成 6 个可独立回退的提交 | `importer-source-dir.ts`、`importer-target.ts`、`invalidateIndexOnly()`、`copyFileFresh` |
| [判据被注释骗过](implemented/2026-11-23-qa-comment-trap.md) | 正则断言先剥注释再匹配；元判据三态查假绿；`\|\|` 兜底本身是假绿来源 | `.deva/qa/lib/strip-comments.cjs`、`.deva/qa/check-qa-no-comment-trap.cjs`（15 脚本 45 PASS） |
| [查重只拦新增](implemented/2026-11-23-duplication-gate.md) | jscpd baseline 拦新克隆；**`exitCode:1` 会让 `--fail-on-new-clones` 失效** | `.jscpd.json`（无 exitCode）、`.jscpd-baseline.json`（41 指纹）、`check-duplication.cjs`、`pnpm check:dup` |
| [项目说明沿目录链注入](implemented/2026-11-23-project-doc-chain.md) | 向下扫 6 层、64KiB 预算、超限整份丢弃最宽的；单份注入逐字节不变 | `project-doc.ts` 的 `loadProjectDocChain` / `budgetProjectDocChain`、`check-project-doc-chain.cjs`（30 PASS） |

## rejected —— 讨论过，决定不做（别再重提）

| note | 否了什么 | 什么时候才该重看 |
|---|---|---|
| [不做代码符号索引](rejected/2026-11-23-code-symbol-index.md) | 不上 tree-sitter / ast-grep / repomap；dsh 11 万行也不做 | 单文件 1500 行变普遍，或 `AGENTS.md` 能力表涨到 30 行以上 |
| [不做动态补读目录说明](rejected/2026-11-23-project-doc-dynamic-read.md) | 不接 `touchedPaths` 到 `agent-loop.ts`；当前 +3.3k token 可接受 | 预算开始被触发（出现「因超预算未注入」） |

## proposed —— 还没（完全）落地

| note | 讲了什么 | 卡在哪 |
|---|---|---|
| [模型切换验收清单](proposed/2026-11-18-model-swap-acceptance.md) | 反推出的「做对了长什么样」，A 42 条 + B 9 条 | 主功能已在，但 **B1（左侧列表标红）未做**（`detectAllBrokenRefs` 零调用）；断言未逐条跑过 |
| [防静默失败机制](proposed/2026-11-18-mechanism-against-silent-failure.md) | 6 条机制防「不报错但没生效」 | 机制 1 已进 `LESSONS.md`；**机制 2 的 `scripts/check-silent-failure.mjs` 不存在** |
| [分阶段规则对照](proposed/2026-11-18-rules-by-phase.md) | magpie 按任务阶段定规则的方式，对照本仓 8 个成员 | 是调研不是规则；引用前先确认是否已进 `AGENTS.md` |

## archived —— 冻结历史，不当依据

| note | 为什么冻结 |
|---|---|
| [worktree 验收清单 v4](archived/2026-11-18-worktree-parallel-acceptance-v4.md) | 完全取代：有效断言已并入规格 |
| [worktree 口径 v3](archived/2026-11-18-worktree-parallel-scope-v3.md) | 完全取代：口径已并入规格 |
| [会话二开复盘](archived/2026-11-23-session-retrospective.md) | 某段会话的历史复盘，不描述当前状态 |

## 不属于 note 的文档

| 文件 | 为什么不是 note |
|---|---|
| `.deva/design-system.md` | 活文档：界面规范随设计变，不是一次决策 |
| `.deva/qa/*.cjs` | 可执行检查脚本，不是记录 |

一次性的排查记录、临时脚本、补丁包不进这张表：它们**用完即删**，不留在仓库里。

## 怎么新增一条

1. 先在 `implemented/`、`proposed/`、`rejected/` 搜同一主题的旧 note
2. 有完全取代 → 旧 note 移进 `archived/` 并加一行头部说明（正文不改）
3. 有部分取代 → 旧 note 留原处，两边互相链接
4. 决定**不做**的写进 `rejected/`，并写明「什么情况下该重新评估」——不是永远钉死
5. 写完更新本索引