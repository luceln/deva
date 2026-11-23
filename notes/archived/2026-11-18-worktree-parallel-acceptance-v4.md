# 多需求并行开发 · 验收清单（v4 · 已冻结）

> **本文件已被取代，仅作历史快照，不当现行依据。**
> 取代者：`../implemented/2026-11-18-worktree-parallel-spec.md`（实现规格 v1 定稿）
> 取代方式：完全取代——验收有效内容已并入规格文件。原文一字未改。

> 状态：口径全部拍板；本清单只定「做到什么算对」，不含实现方案
> 基线：`my/dev` @ `b5e79ca`（`main` / `my/main` 停在 `2b2602d`）
> 版本：**v4**（按 `MEMBERS.md`「需求」章程第 2 条自查后修订，改动见 §七）
> 口径定案：`.deva/req-worktree-parallel-v3.md` · 实现规格：`.deva/spec-worktree-parallel.md`
> 用途：架构按此设计、验收按此逐条核。

---

## 零、怎么用这份清单

- **必须通过**（A 系列）：缺任意一条即不可交付。
- **应该通过**（B 系列）：可与主功能同批交付，也可紧接一个迭代；缺了要明确记录，不算失败。
- **本次不做**：明确排除，不得在验收时被判为缺陷。
- **可验性标注**：每条末尾标 `〔验：…〕`，写明**哪条命令或哪个观察**能让它失败。确实无法机械判定的标 **〔不可验·文字描述〕** 并说明理由，不硬套假断言（见 §七 清单）。

术语：「主目录」= 仓库 primary worktree（本仓 `E:\deva`）；「worktree / 独立工作区」= 本功能创建、检出独占分支的第二工作目录。

### ⚠ 编号变更（v3 → v4，验收必读）

规格文件 §0.3 定义的 **A35~A55 与本清单旧版 A35~A55 编号相同、内容完全不同**（规格 A35 = 记忆共享；本清单旧 A35 = 四项检查全列）。按编号对数会直接对错。

v4 处置：**以本清单为唯一准绳**。A35~A55 按规格原文语义重建（每条注明规格出处），旧 A35~A55 中规格未覆盖的净新增内容并入对应条目，不另立编号。规格文件里的 A 编号此后只作溯源。

**编号缺口与重映射**（避免验收时以为漏了）：

| 编号 | 状态 |
|---|---|
| **A15**（新会话带原会话上下文） | **作废**。v3 定案放弃「分叉」：继承历史会让 agent 基于与新工作区实际内容脱节的历史行事。规格 §0.2 同此判决 |
| **A16**（在 worktree-A 的会话里再分叉出 worktree-B） | **作废**。链式分叉明令不做。其「嵌套创建时 focusRoot 正确」的内核由 A13 覆盖 |
| **规格 A45**（会话改挂后记录仍在、state=ok、会话数归 0） | 落在 **A14b**（它与会话绑定同组，放在一起更易核） |

**编号顺序说明**：编号沿用规格语义分组，**不严格按数值递增**（如 A50~A50d 排在 A51 之后，因为前者属「detached 边界」、后者属「合并检查」）。每组标题已注明规格出处，按组阅读即可。

---

## 一、必须通过（缺一即不可交付）

### 1.1 创建不损伤主目录（数据安全，最高优先级）

- [ ] **A1** 主目录处于「1 个已暂存改动 + 1 个已修改未暂存 + 1 个未跟踪文件」的混合状态时创建 worktree，创建后主目录 `git status --porcelain` 与创建前**逐字符一致**。
  〔验：创建前后各存一份 `git status --porcelain > /tmp/before /tmp/after`，`diff before after` 无输出〕
- [ ] **A2** 同上场景，创建后主目录 `git stash list` 仍为空、当前分支仍是 `my/dev`、`git ls-files -s` 与创建前逐字符一致（已暂存内容没被清掉）。
  〔验：`git stash list | wc -l` 为 0；`git rev-parse --abbrev-ref HEAD` 为 `my/dev`；`git ls-files -s` 前后 diff 无输出〕
  - **不得靠 stash 暂存用户改动来实现**——否则 A1 的 `status` 也可能看起来一致。
- [ ] **A3** 创建后抽样比对主目录 3 个文件实际内容（已暂存改动 / 未暂存改动 / 未跟踪各一）与创建前一致。
  〔验：`git hash-object <file>` 或 `sha256sum <file>` 前后相等〕
- [ ] **A4** 创建任一步骤失败后，主目录 `git status --porcelain`、`git stash list`、当前分支与失败前一致。
  〔验：同 A1/A2 的快照比对，在失败路径上重跑〕
- [ ] **A4b** 创建成功后主目录的 `git worktree list` 只比之前多一条记录，且 primary（第一行）仍是 `E:\deva`。
  〔验：`git worktree list --porcelain | grep -c '^worktree '` 前后差 1；首行路径为 `E:/deva`〕

### 1.2 起点（base）取对

- [ ] **A5** 在 `my/dev`、起点选择器保持默认值时创建，新 worktree 的 HEAD 等于**预检那一刻**主目录 `my/dev` 的 HEAD。
  〔验：`git -C <新wt> rev-parse HEAD` 与预检返回的 `baseSha` 逐字符相等〕
- [ ] **A6** 新 worktree 里存在 `my/dev` 有而 `main` 没有的文件（证明不是从上游镜像切的）。
  〔验：`git diff --name-only main my/dev` 取一路径 p，`test -f <新wt>/p` 为真〕
- [ ] **A7** 在「worktree-A 的会话」里新建会话并选「新工作区」：新 worktree 的 `baseSha` 等于**主检出**的 HEAD，**不等于** worktree-A 的 HEAD；worktree-A 那个提交带来的文件在新 worktree 里不存在。
  〔验：先在 A 里造提交使 A 的 HEAD 前进 → 从 A 的会话创建 → `git -C <新wt> rev-parse HEAD` 等于 `git -C <主目录> rev-parse HEAD`；且 `test ! -f <新wt>/<A 独有文件>`〕
  - 防「n 层单分支树」的核心断言，**必须显式构造场景**，不能靠代码走查。
- [ ] **A8** 先在 worktree-A 里 `git checkout --detach`，再在**该会话**里新建会话选「新工作区」→ 仍取主检出 HEAD，创建成功。
  〔验：`git -C <A> rev-parse --abbrev-ref HEAD` 返回字面量 `HEAD` 后创建；新 wt 的 `baseSha` 等于主目录 `git rev-parse HEAD`〕
- [ ] **A8b** 起点选择器**显示**默认值且可改成别的本地 / 远端分支；改后创建出的 worktree HEAD 等于所选分支**预检时**的 SHA。
  〔验：选择器默认文本等于当前分支名（detached 时为 `HEAD (detached @ <sha7>)`）；改为 `main` 后创建，`git -C <新wt> rev-parse HEAD` 等于预检时 `main` 的 SHA〕
- [ ] **A8c** 起点候选截断到 256 条时，界面出现 `truncated` 提示并提供直接输入分支名的输入框；输入被截断掉的远端分支名仍能创建成功。
  〔验：造 >256 个分支的仓 → `precheck` 返回 `truncated: true` 且 UI 出现输入框；输入第 257 个分支名后创建成功〕

### 1.3 隔离生效（互不覆盖）

- [ ] **A9** 在 worktree-A 里改一个已跟踪文件并新建一个文件，worktree-B 与主目录都看不到。
  〔验：`git -C <B> status --porcelain` 为空；`test ! -f <B>/<新文件>`；主目录 `git status --porcelain` 不含该新文件〕
- [ ] **A10** 在 worktree-A 里 `git commit` 后，主目录 `my/dev`、`main`、worktree-B 的 HEAD 均不变。
  〔验：三处 `git rev-parse HEAD` 与提交前取值相等〕
- [ ] **A11** worktree-A 与 worktree-B 同时各派 agent 写**各自指定的**一个文件（两个路径互不相关），两个任务结束后两边文件内容正确、主目录未被写。
  〔验：`cat <A>/f1`、`cat <B>/f2` 内容符合预期；主目录对应路径不存在或未变〕
- [ ] **A12** 同一 worktree 内开两个会话，两会话 `focusRoot` 相同，且两边能**同时**各写不同文件并都成功。
  〔验：读两会话记录的 `focusRoot` 相等；两边写入后 `cat` 各自文件正确〕
- [ ] **A12b** 同一分支不能被两个 worktree 同时检出：对已在 A 中检出的分支再建 worktree 时必须失败并给出可用替代。
  〔验：`git worktree list` 确认分支占用后重试创建，返回 `branch-exists` 类错误，不静默复用〕

### 1.4 会话与目录绑定

- [ ] **A13** 新建时选了新 worktree 的会话，其 `focusRoot` 等于新 worktree 的**绝对路径**。
  〔验：读会话记录 `focusRoot` 字段；同时在终端面板确认 cwd 与该值相同（两处一致）〕
- [ ] **A14** 原会话的 `focusRoot` 在创建后仍是主目录，值一字不变，且能继续对话、正常落盘。
  〔验：读原会话 `focusRoot` 前后相等；发一条消息后重启应用，消息仍在〕
- [ ] **A14b** 会话改挂到别的目录后，worktree 记录仍在、`state` 仍为 `ok`、该 worktree 的关联会话数归 0，原目录与分支不受影响。
  〔验：规格 A45。改挂后 `worktree:list` 中该记录 `sessionCount === 0`、`state === 'ok'`；`test -d <worktree路径>` 为真；`git branch --list <分支>` 仍在〕

### 1.5 dirty 时必须提示、可选取消

- [ ] **A17** 主目录有未提交改动时创建 → 提示文案**同时包含**未提交文件数量与「新工作区不会包含这些改动」。
  〔验：文案里的数字等于 `git status --porcelain | wc -l`；两个语义各命中一次（文本断言）〕
- [ ] **A18** 主目录干净时创建 → 不弹该提示，直接执行。
  〔验：`git status --porcelain` 为空时创建，无该弹窗出现，`precheck.needsConfirm === false`〕
- [ ] **A19** 提示上选「取消」→ 不建分支、不建目录、不新增会话、不留记录。
  〔验：`git branch --list` 数目不变；目标路径 `test ! -d`；`worktree:list` 条数不变；会话列表条数不变〕
- [ ] **A20** 提示上选「继续」→ 新 worktree 里看不到那些未提交改动。
  〔验：主目录造一个只存在于工作区的文件，`test ! -f <新wt>/<该文件>` 为真〕
- [ ] **A21** dirty 提示不得因「选了继续」而顺手 stash 或提交主目录改动。
  〔验：与 A2 同源，在 dirty 创建路径上再验一次 `git stash list` 为空、HEAD 未变〕

### 1.6 失败路径必须有可见出口

- [ ] **A22** 目标路径已有同名目录 → 报错可见并说明原因，可改名重试；不得覆盖、不得删除已有目录。**不做「空目录就复用」特例。**
  〔验：预置一个含文件的同名目录 → 创建失败；`ls <该目录>` 文件仍在；返回 `path-exists`〕
- [ ] **A23** 目标分支名已存在 → 报错并给出可用替代；不得静默复用已有分支。
  〔验：`git branch --list <名>` 已存在时创建失败，返回 `branch-exists`；不产生新 worktree〕
- [ ] **A24** 目标位置不是 git 仓库 → 入口禁用（带 tooltip）或点击后明确报错。
  〔验：在非仓库目录开会话 → 入口 `disabled` 或返回 `not-a-repo`〕
- [ ] **A25** 创建失败后不得留下孤儿分支。
  〔验：实测 `git worktree add -b featX <已存在路径>` 会先建分支再失败 → 失败后 `git branch --list '<该前缀>*'` 不含本次尝试产生的分支〕
  - 清理必须用 `git branch -D`（`-d` 删不掉未合并分支，且报错会被误当成清理成功）。
- [ ] **A26** 权限不足导致创建失败 → 报错可见并说明原因，主目录不受影响。
  〔验：把目标父目录设为只读（`icacls` 去写权限）后创建，返回错误且文案可读；主目录快照同 A1〕
- [ ] **A26b** 磁盘满导致创建失败 → 报错可见、说明「空间不足」，主目录不受影响。
  〔不可验·注入困难〕真造卷满需填充整块盘，代价高。**处理**：用可控替代——把 `DEVA_HOME` 指到一个容量很小的临时卷（如 64MB 的 VHD / tmpfs），或用 mock 让 `git worktree add` 返回 `ENOSPC`。**验收时按替代方案执行并注明用了哪种**；若两者都做不到，此项记「未验证」而非「通过」。
- [ ] **A27** `pnpm install` 失败（断网 / registry 不可达）→ 提示可见并说明「依赖未装好，需要手动处理」；会话仍可打开；**不回滚已建好的 worktree**；`deps === 'failed'` 且 `depsDetail` 含最后 20 行输出。
  〔验：`pnpm config set registry http://127.0.0.1:9` 后创建 → `deps === 'failed'`、会话可发消息、`test -d <worktree>` 为真〕
- [ ] **A28** 不得「界面显示成功、实际没建成」：显示成功后 worktree 目录存在且 `git worktree list` 含它。
  〔验：创建成功后立刻 `test -d <路径>` 且 `git worktree list --porcelain | grep -c <路径>` 为 1；另断创建后 HEAD 等于 `baseSha`（防 add 成功但校验失败）〕
- [ ] **A28b** 失败后 `intent` 凭据生效：只有本次新建的分支 / 目录才允许被清理，用户原有目录绝不被删。
  〔验：预置一个同名目录（A22 场景）走失败路径，清理逻辑执行后该目录与其中文件仍在〕

### 1.7 创建流程不得让在跑的对话丢数据（已知同类事故回归）

> 背景：导入功能修过 P0——收尾清空 `sessionCache`，正在跑的那轮对话 `save()` 静默 return，消息只留内存。创建 worktree 是同类「异步 + 刷列表」场景，必须回归。

- [ ] **A29** 在会话 X 启动一轮长对话（agent 正在跑）时，从会话 Y 发起创建；创建完成后会话 X 那轮的后续消息全部正常落盘。
  〔验：重启应用后会话 X 的后续消息仍在（对比落盘前后 `data/chats/<id>.json` 的 messages 条数）〕
- [ ] **A30** 创建后刷新列表用的**不是**会清空 `sessionCache` 的全量失效路径。
  〔不可验·界面不可见〕这是实现内部机制，界面上无法区分用了哪个函数。
  **处理**：拆成两部分——① 行为部分由 A29 覆盖（真实后果可观察）；② 机制部分改为**代码核查项**：`grep` 调用点确认用的是 `invalidateIndexOnly()` 而非 `invalidateIndex()`，由审查方在读 diff 时核。验收结论里须注明「机制项：代码核查 / 行为项：A29 实测」。
- [ ] **A31** 创建后不重启、不手动刷新，新会话即出现在左侧列表。
  〔验：创建完成后立即查 `listSessions()` 返回，含新会话 id〕

### 1.8 worktree 目录被外部删除

- [ ] **A32** 用文件管理器删掉 worktree 目录后打开对应会话 → 明确提示「工作区目录已缺失」并给出可操作出口（重建 / 换目录 / 删会话），不静默建空目录、不白屏。
  〔验：`rm -rf <worktree>` 后打开会话 → `state === 'dir-missing'` 且界面出现提示与至少一个出口按钮〕
- [ ] **A33** 应用不得在用户未确认时自动 `git worktree prune`。
  〔验：删目录后 `git worktree list` 仍列出并标 `prunable`；重启应用并打开列表后该行数量不变；启动清扫代码里无 prune 调用（代码核查项）〕
- [ ] **A34** 目录缺失时点「重建」→ 要么成功重建到原路径，要么明确报错；不得「提示成功但目录仍不存在」。
  〔验：点重建后 `test -d <路径>` 且 `git worktree list` 含该路径；失败时返回具体错误码〕

### 1.9 项目记忆跨 worktree 共享（规格 A35 / §1.4 M1~M16）

- [ ] **A35** worktree 会话读到的项目私有记忆与主仓库完全一致；在 worktree 会话里 `memory_write(scope="project")` 写入后，主仓库会话立刻能读到同一条。
  〔验：主目录记一条唯一字符串 → worktree 会话 `memory_read` 输出含该字符串；worktree 里再写一条唯一字符串 → 主目录会话 `memory_read` 含它〕
- [ ] **A35b** `memory_read` 输出里项目私有记忆的标签显示**主仓库根路径**，并注明与当前工作区共享。
  〔验：输出含 `【项目私有记忆】（E:\deva）` 且紧跟「与主仓库共享」字样；不含 worktree 路径作为记忆根〕
- [ ] **A35c** 磁盘上只有**一份**项目记忆文件，落在主仓库对应 key 下，worktree 不产生独立 key 目录。
  〔验：`ls ~/.deva-plus/projects/` 中不出现 `<sha1(worktree路径)前24>`；写入后主仓库 key 目录的 `memory.json` mtime 变新〕
- [ ] **A35d** 三条记忆链路必须同时生效：系统提示词段、每轮下发的记忆清单、`memory_read` 工具输出。
  〔验：worktree 会话里同时检查①`memoryPromptSection` 生成的提示词含项目记忆判据②该轮下发的「【记忆条目】」含该条③`memory_read` 输出含该条。**只改一处的表现是：提示词说有记忆、下发清单为空，agent 判断记忆不存在且不报错**——必须构造出来确认能被测到〕
  - 规格 §10 第 1 条点名的易漏处：`listing.ts:163` 与 `agent-loop.ts:504` 需与 `tools.ts` 那组同批改。
- [ ] **A35e** 项目记忆的**总量上限是同一份**：在 worktree 里写满后，主目录也满（写不进去并返回配额错误）。
  〔验：worktree 会话连续写入至返回 `budget`/`full`，回主目录再写 → 同样被拒〕

### 1.10 边界告知（规格 A36 / §1.5）

- [ ] **A36** worktree 会话的系统提示词【环境】段同时包含五项：①当前工作目录 = worktree 绝对路径；②「你在独立工作区里」＋改动需手动合回 `<targetBranch>`；③「本工作区从 `<baseLabel>` 切出，不含主目录未提交的改动」＋未提交改动数量；④负面约束「不要假设你看到的就是主目录的当前状态，需要确认时读文件而不是凭记忆」；⑤「项目记忆与主仓库共享」。
  〔验：抓取该会话实际下发的 system prompt 原文，五项各做一次字符串断言；③的数字等于 `git -C <主目录> status --porcelain | wc -l`〕
- [ ] **A36b** 第④项负面约束必须存在，不得被省略或改写为描述性语句。
  〔验：对 prompt 原文断言含「不要假设你看到的就是主目录的当前状态」与「读文件而不是凭记忆」两个短语〕
- [ ] **A36c** 三处【环境】段（`systemPrompt` / `sealedSystemPrompt` / `memberSystemPrompt`）都要带这段，不能只改一处。
  〔验：分别在普通会话、封存会话、成员会话里各抓一次 prompt，三处都含五项〕
- [ ] **A36d** `targetBranch === null` 时，第②项改为「尚未指定，需在合并面板里选一次」。
  〔验：主目录 detached 状态创建 worktree → prompt 里目标分支表述为「尚未指定」〕
- [ ] **A36e** 未提交改动数为 0 时，第③项的数字行整行省略，不显示「还有 0 个」。
  〔验：干净主目录创建 → prompt 不含「0 个未提交改动」这类字样〕

### 1.11 合并（最小合并，规格 §4）

- [ ] **A37** 合并成功路径：source 与 target 检出均干净、target 分支在唯一检出中 → target 分支多一个**两条父提交**的合并提交，source 文件内容出现在 target 中，source 分支与 worktree 均不受影响。
  〔验：`git -C <target> rev-list --parents -n 1 <mergeCommit>` 输出三段；`test -f <target>/<source 改的文件>`；`git -C <source> rev-parse HEAD` 与合并前相等；`test -d <source worktree>` 为真〕
- [ ] **A38** source 有未提交改动时点合并 → 明确拒绝并给出文件数量，不执行 merge。
  〔验：返回 `checks` 中 C1 为 bad；`git -C <target> rev-parse MERGE_HEAD` 仍失败〕
- [ ] **A39** target 检出有未提交改动时点合并 → 明确拒绝并给出文件数量，不执行 merge。
  〔验：返回 `checks` 中 C4/C5 为 bad；`git -C <target> rev-parse MERGE_HEAD` 失败；target 的 `git status` 与合并前一致〕
- [ ] **A40** 在 worktree 里 `git checkout <其它分支>` 后点合并 → 明确拒绝（source 不在自己的分支上），不执行 merge。
  〔验：返回 `checks` 中 C2 为 bad；target HEAD 未变〕
- [ ] **A41** target 分支已不在任何检出中（用户在主目录切走且没在别处检出）→ 明确拒绝并说明，不执行 merge。
  〔验：`git worktree list --porcelain` 里找不到该分支 → 返回「找不到检出」错误；target 未被触碰〕
- [ ] **A41b** 合并前用 `git worktree list --porcelain` **反查** targetBranch 的检出路径，不用「主目录当前分支」。
  〔验：先在主目录建 worktree，再把主目录 `git checkout` 到别的分支 → 合并仍打到 targetBranch 上；`git -C <target> log -1` 出现合并提交，而主目录当前分支未变〕
- [ ] **A42** 合并冲突 → 返回内容含 git 原始 `CONFLICT` 文本；target 检出 `mergeInProgress === true`；界面出现可用的「中止合并」。
  〔验：造同一文件同行冲突 → 返回文本含 `CONFLICT`；`git -C <target> status` 显示 merge in progress；界面有「中止合并」按钮且点击后 `MERGE_HEAD` 消失〕
- [ ] **A43** 合并失败后不得自动 `git merge --abort`、不得 `reset --hard`、不得删除 source 分支。
  〔验：冲突后 source 分支仍在（`git branch --list`）、worktree 内容 `sha256sum` 与冲突前一致；`MERGE_HEAD` 仍在（需用户手动中止）〕
- [ ] **A43b** 合并参数用**检查那一刻的 source HEAD SHA**，不用分支名。
  〔验：检查完成、执行前在 source 再提交一次 → 合并的是检查时那个 SHA；target 里不含后提交的内容〕
- [ ] **A51** 四项检查**全列**：source 脏 + source 分支被切走 + target 找不到检出 + target 脏 同时成立 → `checks` 长度为 4 且 4 项全为 bad，不得只报第一个。
  〔验：构造四项同时不满足 → 返回数组长 4；再断言清掉第一项后重试仍报其余三项（不得「命中即返回」）〕
- [ ] **A52** 合并成功返回 `mergeCommit`（40 位）且 `gitOutput` 非空；`upToDate: true` 时 `mergeCommit === null` 且界面不显示 SHA。
  〔验：成功时断言 40 位 hex 且 `git cat-file -p <sha>` 有两个 parent；`Already up to date.` 场景断言 `mergeCommit === null` 且界面无 SHA 文案〕
- [ ] **A55** 「复制 git 命令」内容含 `cd`、目标是 **targetPath**（不是 sourcePath）、Windows 带 `/d`；冲突时给的是 `git merge --abort` 版本。
  〔验：复制出的字符串断言含 `cd /d <targetPath>`；不含 sourcePath；冲突态下含 `merge --abort`〕

### 1.12 detached HEAD 与目标分支（规格 A50 / §3.1）

- [ ] **A50** 主目录 detached 时仍能创建（`targetBranch === null`），`precheck` 给出 `primaryDetached: true` + `mergeTargetWarning` 且 UI 显示该警告。
  〔验：`git checkout --detach` 后创建 → 记录 `targetBranch === null`；precheck 两字段为真/非空；界面起点字段下方有警告文案〕
- [ ] **A50b** `targetBranch === null` 时点合并 → 拒绝（`reason: 'target-not-set'`、`checks: []`），**target 未被触碰**。
  〔验：合并请求返回该 reason；`git worktree list` 与各 ref 未变〕
- [ ] **A50c** 用 `worktree:set-target` 指定目标后再合并 → 成功，且该目标**写回记录**成为新的 `targetBranch`，此后固定。
  〔验：指定后记录 `targetBranch` 非空；合并成功；之后主目录再切分支，记录里的 `targetBranch` 不变〕
- [ ] **A50d** 创建后主目录切到某分支，**不得自动填充** `targetBranch`。
  〔验：detached 创建 → 主目录 `git checkout my/dev` → 记录 `targetBranch` 仍为 null〕

### 1.13 state / deps / sessionCount 的语义（规格 A45/A54、§2）

- [ ] **A54** 「无关联会话」用 `sessionCount === 0` 表达，与 `state` 正交：`ok` + 0 会话、`dir-missing` + 1 会话两种组合都能正确表达。
  〔验：构造前者（改挂会话使计数归 0）与后者（删目录但保留会话）→ 两记录的 `state`/`sessionCount` 组合符合预期；`state` 枚举里不含「无会话」值〕
- [ ] **A54b** `deps` 五态（`pending`/`installing`/`ready`/`failed`/`skipped`）与 `state` 是正交两组，不得合并进一个枚举。
  〔验：存在合法组合 `state:'ok'` + `deps:'skipped'`（无 lockfile 的仓）与 `state:'ok'` + `deps:'ready'`；类型定义中两者为独立字段〕
- [ ] **A54c** 禁止的 `deps` 转移不发生：`ready → skipped` 不得出现；任何状态下 `deps` 不得回到 `pending`。
  〔验：`ready` 后点「重新安装」→ `installing`（非 skipped）；读记录确认无 `pending` 回退路径〕
- [ ] **A48** 把 worktree 切到别的分支后，列表卡片显示 `branch-mismatch` **且**合并按钮禁用（`mergeGate.mayMerge === false`），两处同时反映同一事实。
  〔验：`git -C <wt> checkout <别的分支>` → `worktree:list` 的 `state === 'branch-mismatch'`；`mergeGate.mayMerge === false`〕

### 1.14 路径、命名与长度（规格 A44/A46/A47、§6）

- [ ] **A44** 同一 worktree 用大小写不同 / 尾部斜杠不同的路径表示时，只算一个记录、一个关联会话、一把锁。
  〔验：`E:\...\wt-a` 与 `e:\...\wt-a\` 两种写法分别查询 → 返回同一条记录；`projects/` 下只有一个对应 key〕
- [ ] **A44b** 目录已被删除后，`realpath` 失败时仍只算一条记录（不得退化成字面比较产生第二条）。
  〔验：删掉 worktree 目录 → 用大小写不同写法查询 → 仍返回原记录、`state === 'dir-missing'`〕
- [ ] **A46** worktree 完整路径超过 180 字符 → **创建前**报错并说明，不产生分支、不产生目录。
  〔验：构造长路径提交 → 返回 `path-too-long` 且带「当前 N 字符，上限 180，建议缩短到 X」；`git branch --list` 无新增、`test ! -d` 成立〕
- [ ] **A47** 分支名为中文 / 含空格 → slug 回落为 `worktree`（或用户改写后的值），路径框可编辑；用户改写为合法值后创建成功。
  〔验：填「需求一」→ 目录 slug 为 `worktree-<shortid>`；改写为 `req-one` 后创建 → 目录名含 `req-one`〕
- [ ] **A47b** 分支名合法性走 `git check-ref-format --branch`，不自写规则。
  〔验：填 `feat/ok` 通过、填 `bad..name` 被拒（返回 `bad-branch`），与 `git check-ref-format --branch` 退出码一致〕
- [ ] **A47c** slug 的 7 步规范化按序生效：大小写归一、非法片段转 `-`、折叠、去首尾、`..`→`.`、空则 `worktree`、截断 40 后再折叠。
  〔验：逐条构造输入断言输出，如 `A__B` → `a-b`；纯中文 → `worktree`；41 字符含尾部 `-` → 截断后无尾 `-`〕
- [ ] **A46b** 路径必须落在仓库外，用 `relative()` 判定而非 `git status`。
  〔验：`path.relative(repoRoot, worktreePath)` 以 `..` 开头；**不得**用 `git status` 是否包含它来判（`.deva/` 已 ignore，恒真）〕

### 1.15 删除与安装互斥（规格 A53、§2.6）

- [ ] **A53** 删除 worktree：`state:'ok'` + 3 个未提交改动 → 拒绝并返回 `dirtyCount: 3`；勾选「我知道这些改动会永久丢失」后可删；`deps === 'installing'` 时无条件拒绝（不给勾选项）。
  〔验：造 3 个未提交改动 → 删除返回 `dirtyCount: 3` 且目录仍在；勾选后删除成功；`installing` 期间删除返回拒绝且响应里无「确认项」字段〕
- [ ] **A53b** 删除成功后**分支默认保留**，确认框里写明这一点。
  〔验：删完 `git branch --list <分支>` 仍在；删除确认框文案含「分支会保留」〕
- [ ] **A53c** 删除有未提交改动的 worktree 时不是「按钮直接禁用」，而是点击后弹出拒绝 + 两条出路。
  〔验：按钮 `disabled === false`；点击后出现弹窗，含「在终端里打开」与勾选项两类出路〕
- [ ] **A53d** `dir-missing` / `prunable` 状态下的按钮语义是「移除登记」，只清 git 登记与本地记录，不删任何文件。
  〔验：该状态下按钮文案为「移除登记」；执行后 `git worktree list` 不再含该行，磁盘上其它文件未被删〕

### 1.16 Git 锁（规格 A49、§5）

- [ ] **A49** 两个会话同时发起合并到同一 target：第二个收到「正在等待」提示后串行完成，两者都得到确定结果，`.git/index.lock` 不留残。
  〔验：并发发起两次合并 → 两次都有明确结果（成功或具体失败原因）；`test ! -f .git/index.lock`〕
- [ ] **A49b** 锁按**工作目录粒度**串行化，不是全局一把：两个不同 worktree 同时提交互不阻塞；同一 worktree 并发操作串行。
  〔验：A、B 两 wt 同时提交，两个 `git commit` 都在合理时间内成功；同一 wt 并发两次提交，第二次等待而非交错写入〕
- [ ] **A49c** 合并同时持两把锁，按路径字典序获取，不得死锁。
  〔验：构造相反顺序的两方并发（A→B 与 B→A 两个合并方向），两方都在超时内返回结果，无互相等待卡死〕
- [ ] **A49d** `install-deps` 与只读操作不加锁：安装期间列表刷新、`git:status` 不被阻塞。
  〔验：`installing` 期间打开列表并刷新 → 立即返回（延迟与无安装时同量级，不含 20-30s 等待）〕
- [ ] **A49e** 锁只约束 Deva 发起的 git IPC；用户终端里并发写的错误原样透出，不重试、不自动清 `index.lock`。
  〔不可验·需跨进程构造〕无法在自动化里稳定制造「用户终端与 Deva 同时写」并断言 UI 行为。
  **处理**：改为两条可验的替代——① 代码核查：锁模块无跨进程租约实现且注释写明此前提（规格 §5.3 要求）；② 文本断言：`index.lock` 冲突的报错文案含 git 原始输出、且代码中无自动删除 `index.lock` 的调用（`grep` 可查）。

### 1.17 状态权威（规格 §2.1、§7.5）

- [ ] **A48b** worktree 状态（`state`/`deps`/`sessionCount`）**只由主进程计算**，渲染层不推断：同一份快照不得出现两处不同判断。
  〔验：构造 `branch-mismatch` 场景 → 列表卡片与合并按钮读同一 `worktree:list` 返回值；代码核查确认渲染层无独立判定分支（如无本地 `mayMerge` 自算）〕

---

## 二、应该通过（可后续迭代，缺了要记录）

- [ ] **B1** worktree 列表可见：显示路径、分支名、关联会话数、`state`、`deps`。
  〔验：打开列表，每卡片含这 5 项；数值与 `worktree:list` 返回值逐项相等〕
- [ ] **B2** 能手动删除 worktree：有未提交改动时拒绝并说明，不强删、不静默丢弃改动。
  〔验：入口存在且可达；拒绝行为同 A53〕
- [ ] **B3** 分支命名可读（如 `deva/<需求 slug>`），中文 / 空格 / 特殊字符规范化成合法分支名；冲突时自动加后缀。
  〔验：填中文名 → 分支名合法；同名再建 → 得 `-2` 后缀而非报错〕
- [ ] **B4** `pnpm install`（实测 20-30s）在界面上有进度反馈，不表现为「卡住」。
  〔验：安装期间进度事件推送 ≥2 次，界面数值变化〕
- [ ] **B5** 应用创建的 worktree 路径落在仓库**外部**。
  〔验：同 A46b，`path.relative(repoRoot, wtPath)` 以 `..` 开头。**不得**用 `git status` 判——`.deva/` 已 ignore，恒真〕
- [ ] **B6** 同一 worktree 内多会话的 Git 写操作串行：两会话同时 `git add` 不出现 index 损坏，且提示「另一个会话正在提交」。
  〔验：并发 `git add` 后 `git fsck` 无错、`git status` 可解析；出现等待提示〕
- [ ] **B7** 创建入口在「会话无工作目录」或「当前目录不是仓库」时状态明确（禁用 + tooltip 说明原因）。
  〔验：两场景下按钮 `disabled === true` 且 `title` 非空并说明原因〕
- [ ] **B8** 创建的 worktree 分支不自动推送到远端。
  〔验：提交后 `git ls-remote --heads origin <分支>` 为空〕
- [ ] **B9** 启动清扫（崩溃恢复）把中断的 `installing` 记为 `failed`，`depsDetail: 'aborted-by-restart'`。
  〔验：安装中强杀应用 → 重启后该记录 `deps === 'failed'` 且 `depsDetail` 为该值〕

---

## 三、本次不做（明确排除，不得判为缺陷）

| 项 | 原因 |
|---|---|
| 会话分叉（继承历史上下文） | v3 定案放弃：历史对应的代码状态可能与新工作区实际内容脱节，agent 会凭记忆行事。改为「新建会话 + 选位置」 |
| 链式分叉 / 从 worktree 再分叉的专门入口 | 需要「在 A 基础上做 B」时应在 A 的 worktree 内再开会话（共享目录） |
| worktree 生命周期状态机（vibex 那套 14 状态） | 工量大，未验证前可能白做 |
| preflight revision（哈希绑定确认） | 属完整合并流程，本次只做最小合并 |
| 冲突解决面板 | 冲突时显示 git 原始报错 + 复制命令，让用户去终端 |
| 文件重叠预检测 | vibex 完全没做，答案是「允许并行 + 合并时处理冲突」 |
| 每 worktree 独立数据目录 | 隔离的是工作目录，不是数据目录 |
| dev server 端口分配 | 单进程多 worktree，不涉及 |
| 自动推送 | 见 B8 |
| 跨进程 Git 锁（多窗口 / 多实例） | 本次不做，但模块注释须写明此前提（A49e 代码核查项） |
| 跨 worktree 的会话迁移 | 会话可改挂，但不提供「迁移到另一个 worktree」的功能 |

---

## 四、待澄清项的当前状态

原 7 条 + 第五节 4 条，**现已全部拍板**：

| 原编号 | 问题 | 状态 | 落位 |
|---|---|---|---|
| 1 | 会话能否中途换 worktree？ | **已拍板：允许**（`focusRoot` 本就是可变属性） | A14b、A54；关联归 0 是正确行为，不干预 |
| 2 | `pnpm install` 失败是否回滚？ | **已拍板：不回滚** | A27（保留 worktree，`deps=failed`，可重试） |
| 3 | 分支名冲突如何处理？ | **已拍板：自动加后缀** | A23、B3 |
| 4 | 分叉 / worktree 数量上限？ | **已拍板：不设硬上限**，`>= 5` 给 `softWarn: 'many-worktrees'` 不阻断 | 规格 §3.1 0.10，**不设断言**（见 §五） |
| 5 | 合并怎么办？ | **已拍板：做最小合并**（四项检查 + `--no-ff`，失败显示 git 原始报错） | A37~A43、A51、A52、A55 |
| 6 | Git 互斥范围？ | **已拍板：按工作目录粒度加锁**，`install-deps` 与只读不加锁 | A49b~A49d、B6 |
| 7 | worktree 何时回收？ | **已拍板：不自动回收**；删除走显式操作，分支默认保留 | A53b、A53d；会话删除不连带删 worktree |
| 五-1 | base 取「分叉那刻分支」还是「会话创建时分支」？ | **已拍板：新建会话时用户可选起点，默认值 = 当前分支**（可见可改） | A5、A8b |
| 五-2 | A7 要求 base 回到主分支的隐含要求 | **已拍板并改写场景** | A7、A8 |
| 五-3 | 不做链式分叉 + 合并 UI 的体验落差 | **已拍板：补最小合并**（不再是落差） | A37~A43 |
| 五-4 | `workspace_root_missing` 是否停掉面板 | **已拍板：不停面板**，只给提示与出口 | A32 |

**结论：无遗留待澄清项。** 验收中若出现本表之外的歧义，按章程第 3 条列回用户，不得自行填默认值。

---

## 五、本轮自查：不可验断言清单（按章程第 2 条）

逐条问「哪条命令失败能证明它没做到」，答不出的原文与处理：

| 编号 | 原表述（摘要） | 为什么不可验 | 处理 |
|---|---|---|---|
| 旧 A26 | 「磁盘满 / 权限不足 → 报错可见」 | 磁盘满无法稳定注入 | **拆分**：权限不足 → A26（`icacls` 可造，保留必须通过）；磁盘满 → A26b 标 **不可验·注入困难**，给两种替代（小容量卷 / mock `ENOSPC`），做不到记「未验证」而非「通过」 |
| 旧 A30 | 「用的是不清 `sessionCache` 的窄失效路径」 | 纯实现内部机制，界面无法区分调了哪个函数 | **拆两层**：行为后果由 A29 覆盖（实测）；机制层改**代码核查项**（grep 调用点）。结论须注明哪层实测、哪层读 diff |
| 旧 A33 | 「不得在用户未确认时自动 prune」 | 「未确认时」是意图判断 | 保留可观察部分（删目录后重启，`prunable` 行数不变）+ 代码核查项（启动清扫无 prune 调用） |
| 旧 B5 | 「路径不被 `git status` 看见」 | `.deva/` 已在 `.gitignore:20`，放那里断言恒真 | 改用 `path.relative()` 以 `..` 开头判定（A46b/B5） |
| A49e | 「用户终端并发写的错误原样透出、不重试」 | 需跨进程稳定构造 | 标 **不可验·需跨进程**，改两条替代：注释写明前提（代码核查）+ 文案含 git 原始输出且无自动删 `index.lock` 的调用（grep） |
| 旧 A11 | 「两个 agent 并行改互不相关的文件」 | 「互不相关」是我顺手定义，非用户场景 | 改为**各写各自指定的一个文件**，断言可执行 |
| 旧 A12 | 「两边都能正常读写文件」 | 「正常」不可判定 | 改为同时各写不同文件并 `cat` 校验内容 |
| 旧 A32 | 「明确提示 + 可操作出口」 | 「明确」「可操作」是形容词 | 加判定条件：`state === 'dir-missing'` 且界面出现提示文本 + ≥1 个出口按钮 |
| 旧 A36 系 | 原清单无系统提示词断言 | 规格 §0.3 的 A36 是五项文本要求，原清单漏了 | 新建 A36~A36e，五项拆成可字符串断言形式，数字与 `git status` 计数一致 |
| 全清单 | 「分叉」一词 | v3 已放弃该概念，清单仍在用，A7/A8 无法对应真实入口 | 统一改为「新建会话 + 选位置」，A7/A8 按规格 §0.2 改写 |

**明确保留为「不设断言」的一处**：`softWarn: 'many-worktrees'`（原待澄清 4 落位）。它是软提示，「第 5 个才警告」是产品取舍而非正确性，**不硬凑断言**。

---

## 六、给架构的输入（事实，非结论）- `apps/desktop/src/main/services/git.ts` 已有 git 服务层（`registerGitIpc`、文件级 diff），**全仓无 worktree 相关代码**（`grep -rn worktree` 只命中注释），属全新模块。
- 会话工作目录是 `focusRoot`（`chat-store.ts:33-36`：「挂载目录纯粹是对话属性，决定聚焦工作区、终端 cwd、权限模式键」），不是「项目 / 分桶」。
- `chat-store.ts` 有两个缓存失效函数：`invalidateIndex()`（两缓存都清，注释写明用于「整份数据目录被换掉」）与 `invalidateIndexOnly()`（只清索引、**不动 `sessionCache`**，注释写明是导入收尾专用，因清 `sessionCache` 会让在跑对话的 `save()` 静默 return）。A29/A30 由此而来。
- 全仓**没有会话复制 / 分叉能力**（`ensureSession` 只能新建空会话）。v3 放弃分叉后，该能力**不再需要**。
- 实测（本清单写作时在临时仓库验证，未触碰项目）：
  - `git worktree add` 在脏主检出上执行后，主检出 `git status`、`git ls-files -s`、文件内容、`git stash list` 全部不变。
  - 新 worktree 里只有 base 提交的内容，未提交改动与未跟踪文件都不存在。
  - **`git worktree add -b <新分支> <已存在路径>` 会先创建分支再失败，留下孤儿分支**（A25 依据）。
  - 同一分支不能被两个 worktree 同时检出（A12b 依据）。
  - worktree 目录被外部删除后，`git worktree list` 仍列出并标 `prunable`（A33 依据）。
  - 主检出 detached 时 `git rev-parse --abbrev-ref HEAD` 返回字面量 `HEAD`（A8 依据）；`git rev-parse HEAD` 正常返回 SHA（A50 依据）。

---

## 七、本轮（v3 → v4）改了什么、为什么

按 `MEMBERS.md`「需求」章程四条自查：

1. **编号冲突修正（最重要）**：规格 §0.3 的 A35~A55 与本清单旧 A35~A55 **同号异义**，验收按编号对数会完全对错。已把 A35~A55 重建为规格语义，旧内容的净新增项并入对应条目。**这是本次自查发现的唯一「会直接导致验收失效」的问题。**
2. **全清单术语改口**：「分叉」→「新建会话 + 选位置」（v3 已放弃分叉），A7/A8 按规格 §0.2 的 A7'/A8' 改写场景。
3. **作废 A15/A16**（新会话带上下文、链式分叉），按规格 §0.2 与 v3 §五。原 A16 的「嵌套创建 focusRoot 正确」内核由 A13/A14b 覆盖。
4. **补 8 类规格断言**：记忆共享（A35~A35e）、边界告知（A36~A36e）、合并（A37~A43、A51、A52、A55）、detached（A50~A50d）、state/deps 正交（A54~A54c）、路径归一化与长度（A44~A47c）、删除三态（A53~A53d）、Git 锁（A49~A49d）。**原清单这些一条都没有**，而它们正是规格 §9.1 的 R1~R15 风险点。
5. **改掉 10 处不可验表述**（§五），其中 3 处拆成「行为断言 + 代码核查项」双轨，3 处换成可执行的具体动作，1 处改用 `path.relative()`，1 处补可判定条件，1 处补全缺失断言，1 处统一术语。
6. **修正「本次不做」的过期项**：原表把「合并 UI」列为不做，但 v3 已拍板做最小合并 → 移出并落到 A37~A43；补入「会话分叉（继承历史）」为明确不做。
7. **待澄清全部结项**（§四），标注每条落位编号，避免实现者找不到依据。
