# 二开与上游同步

本仓是 [sqfcyily/deva](https://github.com/sqfcyily/deva) 的 fork，在 fork 上做二开。

## 分支分工

| 分支 | 作用 | 规则 |
| --- | --- | --- |
| **`main`** | **稳定线**（长期存在，GitHub 默认分支） | 只收验证过的东西；上游有更新时合进来。**只 merge 不 rebase** |
| `dev` | **集成分支** | 日常开发与主题分支（`feat/*`、`fix/*`）合入这里；验证后由 `dev` 合进 `main`。**只 merge 不 rebase** |
| `upstream-mirror` | 上游镜像 | 只允许快进到 `upstream/main`，**永不写自己的提交** |

主题分支 → `dev` → `main`，三级往上合，**一路都是 merge**。任何一条线都不 rebase：`main`/`dev` 改写历史会连累所有下游分支，已经合进 `dev` 的主题分支 rebase 会让同一个提交在历史里出现两次。

### 为什么上游镜像叫 `upstream-mirror` 而不是 `main`

上游自己的默认分支在远端叫 `upstream/main`（那是远端引用，改不了）。本地如果也给自己留一个叫 `main` 的镜像分支，就会出现「一个名字两种含义」：

- `upstream/main` —— 上游的默认分支
- 本地 `main` —— 上游代码的本地副本，还是我们自己的主线？

讨论「合并到 main」时谁都说不准指哪个。**所以本地 `main` 归我们自己用**，上游镜像单独叫 `upstream-mirror`，只作参照。

镜像分支留着有两个好处：随时能切过去跑一遍纯净版，判断某个 bug 是上游的还是自己改出来的；主线出了乱子也能直接从它重开。

> 历史：早前二开分支用过 `my/main` / `my/dev` 的写法（`main` 当时被上游镜像占用）。上游镜像改名 `upstream-mirror` 后，`main` 空了出来，二开分支就收回成 `main` / `dev` 了。看到旧文档或旧提交信息里的 `my/*`，指的就是现在的 `main` / `dev`。

上游有更新时，把 `upstream-mirror` 合进 `main`（不要 rebase，`main` 是长期线，改写历史会连累所有下游分支）：

```bash
bash sync-upstream.sh              # ① 快进 upstream-mirror 到上游
git switch main
git merge upstream-mirror          # ② 把上游更新合进 main
pnpm typecheck && pnpm build       # ③ 冲突解决后必须验一遍
```

或者一条命令做完 ①②（有冲突会停下）：

```bash
bash sync-upstream.sh --merge-main
```

开发分支（`dev`）**不要 rebase**——它是集成分支，主题分支都从它分叉，改写历史会让所有人基于旧 `dev` 的工作全部对不上。要让主题分支跟上 `main`，用（仅限尚未合入 `dev` 的分支）：

```bash
bash sync-upstream.sh --rebase-topic
```

脚本会拒绝在 `dev` / `main` / `upstream-mirror` 上执行，也会拒绝已经合入 `dev` 的分支。

## 远端

```
origin    https://ghfast.top/https://github.com/luceln/deva.git   # 自己的 fork（读写）
upstream  https://ghfast.top/https://github.com/sqfcyily/deva.git # 原作者（只读，push 地址已置为 DISABLED_no_push）
```

国内直连 github 偶尔会 `Recv failure`，两个远端都走了 ghfast 镜像。镜像不可用时把地址换回 `https://github.com/...` 原址重试即可。

## 同步上游

```bash
bash sync-upstream.sh              # 只快进 upstream-mirror，不打扰当前分支
bash sync-upstream.sh --merge-main # 快进后把上游合进 main
bash sync-upstream.sh --rebase-topic # 快进后把**未合入 dev 的主题分支** rebase 到 main
```

脚本会先确认是快进（上游强推改写历史时报错而不是硬合），有冲突时停下并给出手动处理的提示。`rerere.enabled` 已开，同一个冲突修过一次之后会自动复用解法。

跟进节奏别攒：上游一天好几个提交，攒一个月再合就是灾难。

## 回灌：把主干的新改动吸收进开发线

上游一天好几个提交，且大量是 `refactor: 拆分 xxx.ts` 这类**改结构**的动作。开发线如果长期不管，等要合并时才处理，冲突会攒成一大坨，而且是在最密集的文件上。

所以两个方向都要走，含义完全不同：

| 方向 | 什么时候做 | 命令 |
| --- | --- | --- |
| main → 开发线（回灌） | **开发期间**，定期做 | 在 `dev`（或主题分支）上 `git merge main` |
| 开发线 → main（合并） | **功能做完且验收过** | 在 `main` 上 `git merge dev` |

回灌节奏：上游出现大重构（拆文件、抽类型、改目录结构）就回灌一次，别按时间攒。

```bash
bash sync-upstream.sh          # ① 快进 upstream-mirror 到上游最新
git switch dev
git merge upstream-mirror      # ② 上游改动流进开发线（也可先合进 main 再流下来）
pnpm typecheck && pnpm build   # ③ 冲突解决后必须验一遍
```

大功能分支（存在超过一周的）同样要定期回灌，把冲突拆成小份，而不是最后一次性解决：

```bash
git switch feat/xxx
git merge dev               # 把 dev 的新改动吸收进主题分支
```

`main` 与 `dev` 都是长期线，**只 merge 不 rebase**；主题分支合进 `dev` 之后就不要再 rebase 它，否则同一个提交会在历史里出现两次。

## 提交前自检

`dev` 是唯一会合进稳定线的分支，提交前跑一遍：

```bash
pnpm typecheck && pnpm build
```

CI（`.github/workflows/ci.yml`）也跑这两条，它触发于推到 `dev*`、推 `main`（远端分支，不是本地镜像）和 PR——`dev` 分支推上去会跑，别以为它有兜底。

## 冲突高发区

上游的提交大量是 `refactor: 拆分 xxx.ts`、`抽出 … 模块` 这类动作，文件会被改名、拆分、搬家。二开尽量做成「新增文件 + 少量改动点」。

**清单不要手抄，自己算。** 冲突面 = 「上游改过的文件」∩「我们改过的文件」。

```bash
# ① 取分叉点：**上一次把上游合进来的那个提交的第一父**所在的分叉点。
#    不能直接用 `git merge-base dev upstream/main`——合并完成之后，dev 里已经含了上游
#    那 72 个文件，merge-base 会跳到最后的交叠点，算出的交集虚高（实测 33 → 72）。
PREV=$(git rev-parse "$(git log --format=%H --grep='合并上游' -1 dev)^1")
BASE=$(git merge-base "$PREV" upstream/main)

# ② 双方都改过的文件 = 真正的冲突面（数字越小越好，文件越少越好）
comm -12 \
  <(git diff --name-only "$BASE" upstream/main | sort) \
  <(git diff --name-only "$BASE" "$PREV"     | sort)

# ③ 也能直接让 git 告诉你谁在动
git log --oneline upstream/main -- <某个文件>
```

数目变化就是拆分工作的成绩单：**这个交集越小，下次合并越轻松。**

> 自检：在 `b0f0d82` 已合入 `dev` 的现在跑 ①②，应当仍得到 **33**。若得 72，说明 `PREV` 取错了（取成了合并后的提交）。

截至 `b0f0d82` 那轮合并（分叉点 `718908e`）实测：**33 个文件**。其中改动最密集的 5 个（按双方改动行数排序）：

| 文件 | 我们 | 上游 |
| --- | --- | --- |
| `main/services/memory.ts` | 254/39 | 309/194 |
| `main/services/memory-consolidate.ts` | 424/26 | 77/47 |
| `preload/index.ts` | 287/19 | 41/15 |
| `main/services/chat-turns.ts` | 226/17 | 83/24 |
| `renderer/src/redesign/ModelPanel.tsx` | 142/7 | 61/342 |

这几个数字会随拆分变化，**当作趋势看，不要当契约**。`preload/index.ts` 已在 `feat/decouple` 上拆出 `preload/import.ts`、`preload/worktree.ts`（并入 `dev` 后生效），下次合并再算一次，它的数字应当明显变小。

## 二开语义清单（解冲突后逐项核对）

### 为什么要这一节

这次合并（上游 `b0f0d82`）最大的教训是：**上游没有的东西，很容易在解冲突时被静默丢弃。**

当时有 33 个文件双方都改过。解冲突时如果整块取上游版本，二开功能就会消失，而且**没有任何报错**——tsc 过、build 过、界面能开，只是功能没了。实测发现的典型例子：`ModelPanel.tsx` 上游把它从 530 行重写成 114 行，我们那 29 处 `broken` 标红、`swapTarget`、`ModelSwapDialog` 入口整块不见了；`ModelSwapDialog.tsx` 这个文件上游**从来没有过**，如果"以有你没有"为收口标准，它会被直接删掉。

所以：**每次解完冲突，逐项核对下面这张表。** 判据不是"上游有没有"，而是"这个功能是不是我们独有的"。

### 怎么用

```bash
# 1. 文件还在不在
git diff --name-only "$(git merge-base dev upstream/main)" dev -- '*某个模块*'

# 2. 关键符号还引用得到吗（比看文件更可靠）
git grep -n '<符号名>' -- 'apps/desktop/src/**'

# 3. 全仓范围找"dev 有、当前没有"的文件（真丢失，应为空）
comm -23 <(git ls-tree -r dev --name-only | sort) <(git ls-files | sort)
```

第 3 条应当输出**空**。有输出就是丢文件了。

### 清单

| # | 二开独有功能 | 关键文件 / 符号 | 上游有吗 | 核对点 |
| --- | --- | --- | --- | --- |
| 1 | **导入器**（从原版 `~/.deva` 一次性导入） | `main/importer*.ts`（15 个）、`importer-ipc.ts`、`renderer/redesign/ImportPane.tsx` | ❌ 从未有 | `adoptSessionFile`、`saveOutcome`、`prepareImportHistory`、`index-dirty.ts`、`chat-locks.ts` |
| 2 | **git worktree 并行工作区** | `main/services/worktree/`（15 个）、`preload/worktree.ts`、`WorktreePane.tsx`、`MergePanel.tsx`、`store/worktree.tsx` | ❌ 从未有 | `worktree/store.ts`、`worktree/scope.ts`、`worktree/brief.ts`、`projectMemoryRootOf` |
| 3 | **模型失效批量替换** | `ModelSwapDialog.tsx`、`main/services/model-swap.ts`、`store/modelSwap.ts` | ❌ 从未有（`ModelSwapDialog.tsx` 上游根本没这个文件） | `ModelPanel` 里 `broken` 标红、`swapTarget={mainId,fromRef}`（固定打开时引用，结果弹窗不随 broken 瞬时消失）、`indexStale`/`superseded`/`failed` 逐项结果 |
| 4 | **密钥三态** | `main/services/secrets.ts` 的 `readSecret` | ❌ 上游是 `(await getSecret()) ?? ''` | `absent`/`ok`/`unreadable`/`store-unreadable` 四分支；**解不开必须报 auth 错误，不能拿空串换 401** |
| 5 | **记忆整轮拒绝** | `memory.ts`、`memory-consolidate.ts`、`memory-condense-ipc.ts` | ❌ 上游只逐条合并 | 任一已有 id 被改/删或出现新增 id → **整轮拒绝**，`concurrent-change` 与 `over-limit`/`model-failed` 分开；并发比对要适配 v2 的 `type/title/body` 三字段 |
| 6 | **记忆一键整理** | `memory-consolidate.ts` 的 `condenseMemories`、preload `memory.condense` | ❌ | `condenseMemories` 通道仍在，`MemoryCondenseResult` 类型在 |
| 7 | **记忆读取三态** | `memory.ts` 的 `MemoryRead`（`absent`/`ok`/`unreadable`）、`snapshot.readError` | ❌ 上游只有空/非空 | 读不出时不能显示成「还没有记忆」 |
| 8 | **角色默认文件夹 + `mount_workspace`** | 上游也有（`role-home.ts`、`workspace-mount.ts`） | ✅ 已并入 | 只需确认 `~/.deva-plus` 路径注释没被改回 `~/.deva` |
| 9 | **数据目录品牌隔离** | `config.ts:30` 的 `.deva-plus`、`main/index.ts:114` 的 `.deva-plus-dev` | ❌ 上游是 `.deva` | **绝不能被解冲突改回 `.deva`**——老用户数据会"消失"且不报错 |
| 10 | **UA 前缀 `DevaPlus/`** | `providers/opencode.ts`、`services/tools.ts` | ❌ 上游是 `deva/` | 有外部语义（服务商 WAF 识别），不能丢 |
| 11 | **任务中心** | `main/services/tasks.ts`、`tasks-types.ts` | 部分 | `tasks.json` 路径含 `~/.deva-plus` |
| 12 | **跨应用密钥重加密** | `secret-rekey.ts`、`resources/secret-rekey-helper.cjs` | ❌ | 用真 Electron 二进制（`DEVA_ELECTRON_BIN`） |
| 13 | **插入消息带附件** | `chat-inserts.ts`、`shared/chat-protocol.ts` 的 `InsertAttachment` | ✅ 上游本轮新增 | 保住 50e2868 验收点：**回合被停/撤回时附件跟着回输入框** |
| 14 | **品牌串整体** | 全仓 139 行（`git grep -c` 逐文件计数之和） | ❌ | 见「自己发版前必须改的」；`~/.deva-plus`、`appId`、`productName` 三处**不可参数化** |

**核对结论记在提交信息里**：哪几项核对过、哪几项不适用、哪几项有变化。下次合并的人（可能是未来的你）靠它判断有没有漏。

## 自己发版前必须核对的

**这四项已经全部改好**（早前是本表列出的上游值）。发版前只需要**核对它们仍然是二开值**，别在合并上游时被带回去：

| 位置 | 必须是 | 现为 | 被改回去的后果 |
| --- | --- | --- | --- |
| `apps/desktop/electron-builder.yml` `publish.owner` | `luceln`（fork 自己） | ✅ `luceln` | 自动更新去拉上游 Release，装完二开版就没了 |
| `apps/desktop/electron-builder.yml` `appId` | `dev.lucel.devaplus` | ✅ | 与上游同 appId，同机会互相顶掉 |
| `apps/desktop/electron-builder.yml` `productName` | `DevaPlus` | ✅ | 决定 Windows 安装目录，与上游版共装会冲突 |
| `apps/desktop/package.json` `version` | `<上游版本>-plus.<序号>` | ✅ `0.1.16-plus.4` | 自建 tag 与上游 Release 撞名 |

2026-11 补充的**第五项**（这次合并时发现仍是上游作者署名）：

| 位置 | 必须是 | 被改回去的后果 |
| --- | --- | --- |
| `apps/desktop/electron-builder.yml` `copyright` | `Copyright © 2026 luceln` | 构建产物带着**上游作者署名**对外分发，归属错误 |

`apps/desktop/src/main/index.ts` 的注释指出：应用名同时决定 userData 目录与钥匙环里加密密钥的条目名。若要把二开版和上游版装在同一台机器上分别跑，userData 目录也得分开。

**`appId` / `productName` 现在有机检护栏**（`.deva/qa/check-brand-home.cjs`，随 `feat/decouple` 的 `test(qa): 新增品牌与数据目录护栏` 一起并入 `dev`）：断言四件事——无 `DEVA_HOME` 时 `getDevaHome()` 末段是 `.deva-plus`、`DEVA_HOME` 覆盖仍生效、`appId` 未变、`productName` 未变。改坏任何一项直接报红。

这条护栏补的是一个**真实空白**：`driver.cjs` 每个场景都会设 `DEVA_HOME`，所以「没设时用哪个目录」这条默认路径——也就是真实用户走的那条——此前从来没被测过。

## 推送到 fork 会怎样

- 推送**不会**替你把 fork 同步到上游，也不会自动建 PR。
- 推 `dev` 到 fork 的分支：安全，只动你自己的分支。
- 推远端 `main` 到 fork：**会把 fork 的 `main` 推离上游**，fork 从此无法一键快进跟上上游，还得强推修回去。本地镜像 `upstream-mirror` 就是个参照物，别推它。
- 打 `v*` tag 并推上去，`.github/workflows/release.yml` 会在 fork 上真的跑打包并发布到 fork 的 Release（它同时支持 `workflow_dispatch` 手动触发）。
- 推远端 `main` 这类操作对上游仓库零影响——fork 与上游只在 GitHub 层面共享对象库。

## 与代码无关的部分

角色（persona）、技能、MCP、定时任务、会话数据都在 `~/.deva-plus` 下，不进版本库，本来就不存在同步冲突。这部分二开完全不用管这套流程。

---

# 交付流程：六道关，每道只干一件事

这个 fork 是单人主导的（用户出需求，AI 角色分工实现）。单人最贵的成本不是写代码，是**返工**。

```
需求 → 【设计评审】 → 实现 → 【代码审查】 → 测试 → 验收
第1关     第2关        第3关     第4关       第5关   第6关
```

每道关的视角必须**只用一个**，混视角等于没换。下面的规则全部针对实际发生过的返工，不是通用方法论。

## 一、开工前先定「验收清单」，用户签字

**验收清单不是需求文档**。需求文档写"要做什么"，验收清单写"**我做到什么程度算对**"——用用户的视角、用能看到的现象描述。

开工前必须让用户确认这六类问题，缺一不可：

| 类别 | 要问清什么 | 反例（这次踩的） |
| --- | --- | --- |
| **数据边界** | 哪些算"用户的"，哪些算"应用自带的" | 把 11 个预置服务商算进导入数量，用户看到「跳过 11 个」觉得莫名其妙 |
| **冲突处理** | 目标已有数据时，覆盖 / 跳过 / 分叉 | 只说了"别覆盖"，没确认"原版后来聊的新内容要不要跟进" |
| **触发时机** | 自动还是手动？启动时还是用户点？ | 差点做成启动自动导入，用户明确要手动 |
| **失败可见性** | 出错时用户看到什么 | 报告显示「导入完成」，实际会话一个都没导 |
| **并发安全** | 操作期间用户干别的事会怎样 | 导入跑几十秒，中途点开对话会把导入的服务商覆盖掉 |
| **数据完整性** | 中途崩溃/退出后重跑会怎样 | 附件目录已存在就整目录跳过，残缺永远补不回来 |

写成用户能读的句子，例如：

```
我点「开始导入」后：
□ 会话列表里出现原版的 28 个会话，点开能看到历史消息
□ 模型下拉里只有我的 5 个自定义服务商（不显示 11 个自带的）
□ 角色列表里有我自建的 8 个（不是 10 个）
□ 密钥不用重输，能直接发消息
□ 如果中途我点了别的对话，导入照样完成
□ 出了问题会告诉我「哪一条失败了」，而不是只说「完成」
```

**这六条里每一条都对应一次返工。** 开工前给用户看，能砍掉大部分「不合预期」。

## 二、「报告成功」必须可被证伪

单人开发最危险的 bug 不是崩溃，是**静默失效**——不报错、看着正常、数据缺一块。

定一条硬规矩，任何批量操作（导入、迁移、清理、同步）都必须满足：

1. **每一步都有失败通道**，不是只有最容易出错的那步有
2. **`ok === true` 的含义是「我逐项检查过，都做到了」**，不是「我没遇到异常」
3. **失败条目带 `step` / `id` / `reason`**，界面能逐条显示，不能只写日志
4. **不吞异常**。catch 里要么记失败，要么重新抛出，不许 `catch {}`
5. **写盘返回值要检查**。`writeMemory` 超配额返回 `ok:false` 而不是抛错，忽略返回值就会「看着导成功、实际没写」

审查时可以直接搜：`catch {`、`catch (e) {` 后面是否只有注释。

反例（这次真实代码）：

```ts
} catch {
  /* 单条失败不影响其它 */    // ← 失败从此消失，报告仍是 ok
}
```

## 三、验证者不能复用实现者的前提

**这是这次最大的教训。** 主进程交回来说"58 项断言全过"，测试成员也说"核心承诺全部成立"——**两个独立验证都说没问题，用户一试就出问题**。

原因：我把「已知的六个坑」写进了验证任务里，验证者就在这个前提里验证，于是六条全过、六条之外的问题全漏。

**做法**：每轮验收派一个**不带前置假设**的验证者。只给它两样东西：

1. 用户的验收清单（第一条产出的那份）
2. 代码和真实数据

**不给**开发者的说法、不给已知问题的清单、不给实现思路。让它自己从代码和实测得出结论。

对照效果：子智能体就是因为不知道"lockfile 的既有解释"，自己去翻了 Chromium 的 `process_singleton_win.cc`，才发现「Electron 退出不删锁」这句是错的。

**代价与收益**：多一轮验证的时间，但对比返工成本（这次导入功能三轮修复、两个独立测试、约 4000 行改动），便宜得多。

## 三条的适用边界

- **小改动**（改文案、调样式、修单点 bug）：第一条可以简化成一两句话，第二三条仍需遵守
- **一次性脚本**（临时排查、数据修正）：三条都可放宽，但要说明是临时的
- **大功能**（新模块、跨多个文件）：三条全部执行，且第二条要写进代码审查清单

微软工程手册的原话可以当标准：「**We consider code to be incomplete if it is not accompanied by tests**」——没测试的代码算未完成，不算质量差。这里的"测试"包括上面第二条那些可证伪的断言。

## 四、设计评审：写码前定清楚这五件事

**在写第一行代码之前做**，产出不是文档，而是**几个必须由用户拍板的取舍**。没人拍板就不开工。

| 要定什么 | 具体问法 | 反例 |
| --- | --- | --- |
| **数据流** | 谁读谁写？源和目标有没有可能重合？ | `DEVA_HOME` 指到原版目录 → `invalidateIndex()` 删了原版的 `_index.json` |
| **并发** | 操作期间还有谁能改同一份数据？ | 导入跑几十秒，中途点开对话触发回写，把导入的 providers 整段覆盖 |
| **失效模式** | 每步失败了会怎样？用户看得出来吗？ | 目标 `data/chats` 被占用 → 会话一个没导，报告 `ok: true` |
| **幂等与重入** | 跑第二遍会怎样？中途崩溃再跑呢？ | 补回逻辑用 `copied.length` 判断，第二轮必然为 0，守卫失效 |
| **边界与上限** | 数据量、配额、路径长度、权限 | 记忆 100 条 / 4000 字上限；Windows 路径 260 字符 |

**并发和失效模式最容易漏**，因为平时写业务逻辑不常遇到。判断方法很土但有效：**问「如果这期间用户干了 X 会怎样」，X 取遍界面上所有可点的东西**。

产出示例（导入功能的正确做法）：

```
设计评审 · 导入

并发：导入期间渲染层会整段回写 models（用户切换对话就触发）
  → 方案 A 冻结写入 + 收尾补回（保用户改动，但守卫条件不能依赖 copied.length）
  → 方案 B config:set 排队到结束（会阻塞渲染层）
  → 方案 C 收尾再读盘合并（保不住用户本轮改动）
  【需拍板】选 A

失效：五步都可能失败，只有记忆有失败通道
  【需拍板】五步都加 failed[]，ok = failures.length === 0

边界：DEVA_HOME 可能与原版重合
  【需拍板】比较路径，重合则拒绝
```

## 五、代码审查：只读不跑，专查五类

**在交给测试之前做**。审查者不运行业务代码（可以跑 typecheck/build），只读 diff，因为这几类问题静态就能看出来，跑起来反而会被"看起来正常"骗过。

**必查五类**（都是这次真实踩过的）：

```bash
# 1. 被丢弃的返回值 —— 返回布尔/结果对象的函数，调用处是否检查了
grep -n "setConfig\|writeMemory\|setPersonaEnabled\|persist" <改动文件>
# 看调用行有没有 if / 三元 / 赋值给变量

# 2. 被吞的异常 —— catch 块里只有注释
grep -n -A2 "catch {\|catch (e) {" <改动文件>

# 3. 失效的守卫条件 —— 条件里用了会随幂等变化的值
#    典型：if (xxx.copied.length) —— 第二轮必然为 0

# 4. 契约不一致 —— 类型上可选（?）但消费方假设必有
#    典型：id: string 实际传空串；failed?: Failure[] 但界面写死 0

# 5. 注释与实现不符 —— 注释承诺的行为代码里没有
#    典型：「activeModelId 跟随」但代码没写；「Electron 退出不删锁」但实际会删
```

**审查者的产出是问题清单，不是修复**。它不改代码，避免「自己查自己」。

对照这次的三个 bug，五类里各占一条：

| 类 | 实例 |
| --- | --- |
| 丢弃返回值 | `setPersonaEnabled(id, true)` 返回值不管，`catch {}` 吞掉 |
| 失效守卫 | `if (held.length && report.providers.copied.length)` |
| 契约不一致 | 兜底 failure 推 `id: ''`，而界面按 id 定位 |

**这三个都能被 grep 抓到**，不需要跑测试。

## 六、六类角色的分工

单人主导的项目里，角色是"换个视角看同一件事"，不是真的五个人。每个角色**必须只用一个视角**，混视角就等于没换。

| 角色 | 视角 | 唯一产出 | 绝不能做 |
| --- | --- | --- | --- |
| **需求** | 用户要什么 | 验收清单（用户签字） | 不设计实现、不写码 |
| **架构** | 会不会出事 | 取舍清单（用户拍板） | 不写码、不审查 |
| **实现**（主进程/界面） | 怎么做到 | 代码 + 自测 | 不自评"能交付" |
| **审查** | 代码本身对不对 | 问题清单 | 不改码、不跑业务代码 |
| **测试** | 改坏了没有 | 回归结果 | 不判断能不能交付 |
| **验收** | 用户能不能用 | 交付判断 | 不给开发者说法（第三条规定） |

三个原则：

1. **实现者不自评交付**——它只能说"我做完了，自测通过"，能不能交付由验收说
2. **审查者不改码**——自己查自己必然放过
3. **验收者不知道已知问题**——知道就会在这些问题范围内验证（第三条）

# 二开风格约定

以下全部从既有代码实测得出，不是凭空定的规矩。目标是与上游代码放在一起时**看不出是两个来源**。

## 代码风格

**格式**：无 prettier、无 eslint，全凭手写。`.editorconfig` 只约定了 `end_of_line = lf`。

| 项 | 约定 | 依据 |
| --- | --- | --- |
| 分号 | 不用 | `chat-store.ts` 613 行只有 7 个（都在 `for(;;)` 这类语法必需处） |
| 引号 | 单引号 | 全仓一致 |
| 行宽 | 100 字以内，极少超 | 抽查核心文件，>100 字的不超过 1% |
| 缩进 | 2 空格 | 全仓一致 |
| 类型导入 | `import type { X }` 单独写 | 各文件统一 |
| 类型注解 | 函数返回值显式写 `: void` / `: string` | 全仓一致，不靠推断 |

**注释密度按模块风险分级，这是最值得学的一条：**

| 模块类型 | 密度 | 例子 |
| --- | --- | --- |
| 存储 / 持久化 | ~39% | `chat-store.ts` 613 行，242 行注释 |
| 时序 / 调度 | ~26% | `scheduler.ts` 270 行，72 行注释 |
| 业务主流程 | ~14% | `chat.ts` 985 行，141 行注释 |

规律是：**越容易出静默错误的模块，注释越密**。缓存、并发、全量重写、时序这类地方写透；主流程保持克制，靠命名自明。

**注释写「为什么」，不写「做什么」**。反例（不要写）：

```ts
// 删除 personas 段
delete cfg.personas
```

正例（上游的真实写法）：

```ts
/**
 * 为什么必须剔：`personas.seeded` 是「**这套数据目录**里已经种过哪些默认角色」的状态位，跨目录无效。
 * 而 personas.ts 见到 seeded[id] === true 就绝不复活（用户可以删掉默认角色，删除必须留得住）。
 * 原样搬 config 会造出「seeded 说都种过了、磁盘上却一个角色文件都没有」的目录。
 */
```

**注释语法**：`**加粗**` 标关键判断，`·` 分隔并列要点，`①②③` 标顺序，`⚠️` 标陷阱。文件头用一段块注释交代定位、关键决策与「刻意不做什么」。

## 开发风格

**最小改动优先，贴合既有代码**。新增文件优于大改既有文件——上游一直在拆文件、搬模块，你改得越深，以后合并冲突越大。

**先查后改**。改某个模块前先看它最近的提交，确认上游没有正在改同一处：

```bash
git log --oneline upstream/main -- <文件路径>
```

**静默错误必须显式处理**。这个代码库里最危险的 bug 类型是「不报错但没生效」：

- 缓存没清 → 文件写进去了但列表看不见
- 配额满了返回 `{ ok: false }` → 不检查返回值就当成功了
- 启动清扫删掉「还没被引用」的数据 → 用户只看到图片变成「数据已丢失」

遇到这类地方，**注释写清楚为什么这么做**，并且**验证要真跑**，不能只做类型检查。

**验证到哪一步就说到哪一步**。`pnpm typecheck` 过了不等于功能对；能用脚本断言的行为要断言，GUI 行为如果没法驱动就如实说没验过。

**不越界**。主进程的活不要顺手改渲染层，渲染层的活不要顺手改 `shared/`。跨了范围要在交付时明说，让分工的人决定。

## 提交风格

**格式**（严格照抄，中英双写）：

```
<type>(<scope>): <中文简述> / <english summary>

- <中文改动点> / <english change>
- <中文改动点> / <english change>
```

**type** 只用这几个，按使用频次：`feat` > `fix` > `docs` > `refactor` > `chore` > `build` > `style` > `ci` > `perf`。

**scope** 是模块名，小写，如 `import`、`build`、`models`、`fork`、`chat`、`member`。

**硬性要求**：

- subject 中文在前、` / ` 分隔、英文全小写开头
- body 每条 `- ` 开头，中文与英文用 ` / ` 分隔，**一行一条不折行**
- body 数量与改动规模相称：小改动 1–2 条，中等 3–5 条，大改动 5–8 条
- **body 里不用 `**加粗**`**（那是注释风格），不用段落式长句
- 一个提交只做一件相关的事；攒多个改动点就写多条 body，不要拆成多个琐碎提交

**对照**（上游真实提交）：

```
feat(remote): 「仅最终结果」模式改为聊天式回复并显示正在输入 / add chat-style replies with typing indicator for final-only mode

- 「仅最终结果」的机器人不再发回合卡片，回合结束后发一条聊天式回复 / final-only bots skip turn cards and send a chat-style reply when the turn ends
- 飞书在用户消息上挂「敲键盘」表情代替正在输入，并申请表情回应权限 / Feishu adds a Typing reaction on user messages and requests the reactions scope
- 插入、作答、停止时手机端加入当前回合，等待决定时收起正在输入 / mobile insert, answer and stop join the running turn; typing hides while waiting
```

**中文写作要求**：说清楚「改了什么、为什么」，不用「优化了」「调整了」这种空话。对比：

- ✗ `优化导入逻辑 / improve import logic`
- ✓ `导入收尾广播 config:changed，模型列表不再需要重启才刷新 / emit config:changed when the import finishes so the model list refreshes without a restart`

## 发版

版本号在 `apps/desktop/package.json`，形如 `0.1.16-plus.4`（`<上游版本>-plus.<序号>`）。上游 3–6 天一个版本，二开用 `-plus.N` 后缀避免与上游 tag 撞名。

发版流程：改版本号 → 提交（`chore: 版本号升级至 x.y.z`）→ 打 `v*` tag 推上去，CI 自动打三平台包并发布到 fork 的 Release。

### 版本号规则：`<上游版本>-plus.<序号>`

```
0.1.16-plus.1   第一个二开发版（对齐上游 0.1.16）
0.1.16-plus.2   第二个
...
0.1.16-plus.10
0.1.17-plus.1   跟到上游 0.1.17 之后，序号归 1 重新累加
```

前半段永远**对齐当时的上游版本**，一眼能看出「基于上游哪个版本」。后半段是本仓自己的累加，不管上游发到哪一号都不受影响——上游一天几个提交，二开发版可以比它快得多。

**三条硬约束，缺一条「检查更新」就会静默失效：**

1. **必须是合法 semver**：`0.1.16-plus.1` ✅、`0.1.17-plus.1` ✅，但 `0.1.16.1` ❌（四段不是 semver，`semver.valid()` 返回 null，`electron-updater` 内部直接抛错）。
2. **tag 不能被标成 prerelease**：GitHub 的 `releases/latest` 只返回「non-prerelease, non-draft」（[官方文档](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)），而 `services/updater.ts:24` 读的正是这个接口。`release.yml` 已改成**排除 `-plus.`**、只把 `beta`/`alpha`/`rc` 当预发布——改那行之前先想清楚后果。
3. **序号在同一上游版本内单调递增**：`compareVersions`（`updater.ts:62`）用 `localeCompare(..., {numeric: true})` 比较后缀，所以 `-plus.10 > -plus.9` 成立。

**没有「上游版本用户」这回事**：`updater.ts:24` 读的是 `api.github.com/repos/luceln/deva/releases/latest`，只查本仓；本仓的 tag 与上游同号 tag 互不相关（各自仓库各算各的）。装 DevaPlus 的人 `app.getVersion()` 取的是本仓 `package.json` 的版本，永远只在本仓序列里升。

**前缀是否可以不动**：可以。一路 `-plus.1, -plus.2, -plus.3…` 直到 `-plus.99` 在技术上是完全正确的（semver 单调递增）。跟着上游改前缀纯粹是给人看的——一眼知道「这个二开版基于上游哪一版」。不改也不影响任何功能。

发版时三处要一起改：`apps/desktop/package.json` 的 `version`、提交信息、`git tag v<同号>`。`release.yml` 会校验 tag 与 package.json 版本一致，不一致直接报错。
