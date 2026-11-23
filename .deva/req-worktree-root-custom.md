# 需求：worktree 根目录可统一管理（自定义根目录 + 根内校验）

状态：**可施工**（原为「已记录，未排期」；两项取舍 + 四项细则均已拍板，见 §四、§十四）
基线：`feat/member-worktree` @ `bcad9a3`
来源：用户口头诉求（见 §二）+ 主控 2026-11-23 实测清理数据 + 本次代码复核
版本：**v2**（2026-11-23 补入 Q1~Q4 定案与「老目录不能新建」答复，见 §十四）
规格交叉引用：`.deva/spec-worktree-parallel.md`

> **本文档是重建的。** 原记录 `784df7e`（2026-11-22）写入过一份 30 行的「已记录」版本，该文件在
> `bf30126`（`revert: 撤回未完成的成员工作区功能`）中随功能一起被删除；`76757f5` 恢复成员工作区实现时
> **没有恢复这份文档**，导致它在当前工作区与 `HEAD` 中都不存在，只在 `784df7e` 里留了一份。
> 本文在原 30 行版本的硬约束基础上，补齐为可施工需求。
> 〔验：`git cat-file -e HEAD:.deva/req-worktree-root-custom.md` 报 `does not exist`；
> `git log --oneline --all -- .deva/req-worktree-root-custom.md` 只有 `05a4cf7` / `bf30126` / `784df7e`〕

---

## 一、这份需求解决什么

**一句话**：应用建的 worktree 必须有且只有一个「根」，根外不许建、根外不许删；根由用户自己指定。

不解决的（明确排除，见 §十二）：根目录内部的清理、根外目录的自动回收、QA 脚本的临时目录。

### 为什么现在必须做（不是「体验优化」）

主控 2026-11-23 实测清理：`E:\` 下 **12 个** + 系统 Temp 下 **311 个** worktree 目录，共 **866MB**。
两个数字都指向同一个根因：**默认路径从未被用过**。

> **事实修正**：主进程调研里说 `~/.deva-plus/worktrees/` 是「空目录」，**实测该目录根本不存在**
> （`find` 返回 0 条目、`ls` 无输出）。结论方向一致但措辞要准：默认位置**从未被使用过**，
> 不是「用过但空了」。这个区别影响验收——「目录不存在」不能拿「目录为空」的断言去验。

---

## 二、用户原话

> 「一堆目录了，我希望到时候 worktree 可以进行统一管理：自己设一个目录，而不是放任 agent 到处去创建」

> 「删除目录必须是所选的建立 worktree 的目录里面」

两句合起来定义了本需求的**双向约束**：创建侧不许出根，删除侧不许出根。

---

## 三、已核实的事实（复现命令附后）

以下均为本次逐行核对的结果，与主控给的行号一致处标「✔ 复核」，不一致或需补充处单独标出。

### 3.1 默认路径为什么从未生效

`apps/desktop/src/main/services/worktree/precheck.ts:210` ✔ 复核：

```ts
const target = (req.path ?? '').trim() || defaultWorktreePath(repoRoot, slug)
```

`req.path` 一旦有值，`defaultWorktreePath()`（`:116-120`，产出 `<DEVA_HOME>/worktrees/<repoKey>/<slug>-<shortid>`）
**完全不参与**。而传路径的调用方有两处：

| 调用方 | 传的什么 | 位置 |
|---|---|---|
| 新建会话对话框 | 用户在「路径」框里的值（默认由 precheck 回填，但**可手改、可浏览选任意目录**） | `renderer/src/redesign/NewSessionDialog.tsx:136-141, 177-182` |
| 成员工作区绑定 | `recovery.checkoutRoot` = **上一次 precheck 返回的 `path`** | `main/services/member-worktree.ts:236, 253` |

**关键**：`NewSessionDialog.tsx:158-164` 的 `browse()` 走 `window.deva.fs.openFolder()`，用户能选**任意目录**，
选中后 `setPath(res.path)` 并置 `locationTouched = true`（此后改名不再覆盖路径）。这是「放任 agent 到处创建」
的**用户侧入口**之一，也是那些 `E:\xxx` 目录最可能的来源。

〔验：`grep -n "openFolder" apps/desktop/src/renderer/src/redesign/NewSessionDialog.tsx`〕

### 3.2 创建侧现有校验只有三条，没有根内校验

`precheck.ts:211-222` ✔ 复核，顺序为：

1. `path-too-long`（`norm.path.length >= MAX_PATH_LEN`，180）
2. `path-inside-repo`（`isInsideRepo(repoRoot, norm.path)`）
3. `path-exists`（目标路径已存在则拒绝）
4. `error`（目标路径读不出状态）

**没有「是否在 worktree 根内」这一条。** 传什么路径就按什么路径建（只要不在仓库内、不太长、不存在）。

### 3.3 删除侧同样没有根内校验

`remove.ts:98-253` 的准入是：

- `getRecord(req.path)` 有记录（`:108`）
- `looksLikeOurWorktreeDir(path, rec.repoRoot)` 通过（`:193`，实现在 `git-worktree.ts:108-`，
  判「目录里有 `.git` 文件且首行指向本仓库的 `.git/worktrees/<name>`」，空目录也放行）

通过后就 `rmSync(path, { recursive: true, force: true })`（`:202`）。**能删根外的任意合法 worktree 目录。**

### 3.4 `paths.ts` 已有可复用的归一化设施（必须复用）

`worktree/paths.ts`：

- `normalizeWorktreePath()`（`:90-94`）→ `{ path, compareKey }`
- `compareKeyOfPath()`（`:97-99`）
- `MAX_PATH_LEN = 180`（`:143`）
- `isInsideRepo()`（`:152-157`）——它自己就是靠 `normalizeWorktreePath` + `relative()` 判的，
  **不是**字符串前缀比较

`compareKey` 做了六步归一化（`:42-82`）：分隔符统一、折叠冗余 `/`、去尾斜杠、剥段尾空格与点、
去 `\\?\` 长路径前缀、Windows/macOS 小写化。文件头（`:5-11`）明确写了：

> 这些规则会被 store（主键）、create（判重）、list（反查）三处共用，每处各写一遍必然漂移

**所以根内判定必须走 `compareKey` + `relative()`，不得用 `startsWith`。**

### 3.5 `WorktreeRecord` 已有 `schemaVersion`，且是强校验（**这一条纠正了任务里的建议**）

任务建议「加版本标记（如 `createdUnderRoot` **或在记录里记 schemaVersion**）」。核实后：

- 记录级已有 `schemaVersion: 1`（`store.ts:27`），是**字面量类型**，含义是「记录格式版本」，不是「创建时的根」
- 文件级 `SCHEMA = 1`（`store.ts:61`），`ensureLoaded()` 在 `:88` 做**强校验**：
  ```ts
  if (parsed?.schemaVersion !== SCHEMA || !Array.isArray(parsed.records))
    throw new Error('无法识别工作区记录格式')
  ```
  不匹配 → `loadState = 'corrupt'` → **所有写操作 fail closed**（`upsertRecord` 拒绝写盘）

**结论**：`schemaVersion` 既不能复用为「是否在根下创建」，也不能为了本需求升级它
（升级会让旧文件整体判 corrupt，用户所有 worktree 记录变成不可写）。
**必须新增一个独立的可选字段**，见 §六.3。

### 3.6 配置层能承载这个偏好

- `config.json` 顶层是自由键值（`config.ts:203-206` `getConfig()` 返回整个对象，无键白名单）
- `setConfig()` / `setConfigDetailed()`（`:380-449`）支持「`undefined` 即删键」（`:423`），
  且写盘失败会把内存回滚（`:433-438`）——**「恢复默认」= 删键这条路径现成**
- `getDevaHome()`（`:28-38`）先读 `process.env.DEVA_HOME`，无则 `join(home, DEVA_HOME_DIRNAME)`
- 注意 `home` 是**模块级缓存**（`:17`），一个进程内只算一次

### 3.7 创建还有第二个入口，也要一起管

`create.ts:270-274` 的 `suggestPath()` 直接调 `nextFreeWorktreePath()`（`precheck.ts:128-137`），
**绕过 precheck**。若只改 precheck，这个入口生成的路径仍然基于旧根。

〔验：`grep -n "nextFreeWorktreePath\|suggestPath" apps/desktop/src/main/services/worktree/*.ts`〕

---

## 四、已拍板的两个取舍（不得改动）

### 取舍一：`path` 参数「限制在根内，允许指定根内子目录」

- **不是**「完全禁止传路径」，**不是**「保持现状」
- 调用方仍可传路径，但**必须落在 `worktreeRoot` 之内**；根外一律拒绝
- 绝对路径被接受的前提是它在根内
- 根内子目录（如 `<root>/<repoKey>/fix-login`）允许，保留「用户自己命名末级目录」的能力

**这条会改变用户可见行为**：`NewSessionDialog` 的 `browse()` 选中根外目录后，precheck 会报
`path-outside-root`。这是**预期变更，不是回归**（见 §十一的界面处理要求）。

### 取舍二：存量记录「老记录放行，只在界面标注」

- 老记录（缺「创建时根」标记）**跳过根校验**
- 界面标注「不在当前 worktree 根内」
- 新记录严格校验
- **理由**：删除是收尾动作，不该拦。用户清理存量目录时，被「你没在根内建的所以我不能删」
  挡住的后果是又留下一个删不掉的目录——正是本需求要解决的问题

---

## 五、`worktreeRoot` 的语义

**是**：应用**新建** worktree 时允许出现的目录上限（一个本地绝对路径）。

**不是**：

- 不是「所有 worktree 的父目录」——存量记录可以在根外（取舍二）
- 不是项目身份、不是仓库标识、不是权限作用域
- 不是「根下所有目录都是我们的」——根下可能有用户自己的东西，本需求**不赋予**任何「根内即安全」的删除授权（见 §八）
- 不是 `repoKey` 的替代——分桶结构 `<root>/<repoKey>/<slug>-<shortid>` 保留

---

## 六、字段与默认值

### 6.1 存放位置

`<DEVA_HOME>/config.json` **顶层**键：`worktreeRoot`

**不放进 `worktrees.json`**。理由：

- `worktrees.json` 是**机器状态**（以路径 compareKey 为主键的记录表），文件级 `schemaVersion` 强校验，
  混进用户偏好会让「改一个偏好」和「改机器状态」互相牵连
- 偏好要能跟 `config.json` 一起被用户备份 / 手改 / 版本化（`config.ts:8-14` 的定位）

### 6.2 默认值不写进文件

```
worktreeRoot 缺键（undefined） → 默认根 = join(getDevaHome(), 'worktrees')
```

**为什么是 `undefined` 而不是把默认值写进文件**：

1. `DEVA_HOME` 迁移时默认根**自动跟着走**；写死成绝对路径就断了
2. 「恢复默认」= 删键（`setConfig({ worktreeRoot: undefined })`，`config.ts:423` 现成支持）
3. 用户从没设过时，配置文件里不该出现一个他没设过的值

**后果要接受**：`getDevaHome()` 是模块级缓存（`config.ts:17`），改 `DEVA_HOME` 必须重启应用生效
——这是现有行为，本需求不改（见 §十三 R5）。

### 6.3 记录侧的「创建时根」标记（**新增独立字段，不复用 schemaVersion**）

`WorktreeRecord`（`store.ts:26-58`）新增一个**可选**字段，语义是「创建这条记录时，根是什么」：

- **新记录**：写入该字段 → 创建与删除都走严格根校验
- **老记录**：缺该字段 → 跳过根校验，界面标注（取舍二）
- **字段类型**：存归一化后的 `compareKey`（不是原始串），避免大小写 / 尾斜杠 / `\\?\` 造成假不匹配
- 也可同时存一份展示用原始路径，但**比较一律用 compareKey**

**硬约束**：

- 该字段**可选**，`ensureLoaded()` 的必填校验（`store.ts:94-100`）不得把它列为必填，
  否则老记录会被判 invalid → `loadState = 'corrupt'` → 全部写操作被拒
- **不得修改** `WorktreeRecord.schemaVersion: 1` 与文件级 `SCHEMA = 1`
- **不得**为了「老记录也能判断」去做一次性迁移回填：那需要重写 `worktrees.json`，
  与「读失败不覆盖」的既有纪律（`store.ts:70-79`）冲突，且老记录的真实根本来就不可知

### 6.4 目录结构不变

```
<worktreeRoot>/<repoKey>/<slug>-<shortid>/
```

`repoKey` 分桶**必须保留**（用户已明确要求，见原 30 行版本）——否则不同仓库的 worktree 混在一层，
名字一撞就分不清谁的。`slug` / `shortid` 的生成规则（`paths.ts:119-140`、`precheck.ts:116-120`）不变。

---

## 七、创建侧校验

### 7.1 位置

在 `precheck.ts` 的 `path-inside-repo`（`:214`）**之后**、`path-exists`（`:218`）**之前**插入根内校验。

**为什么在这个位置**：

- 必须在 `normalizeWorktreePath`（`:211`）之后——根内判定要用归一化后的 `compareKey`，不能用原始 `req.path`
- 必须在 `path-inside-repo` 之后——「先排除最严重的（仓库内）」，报错更准确
- 必须在 `path-exists` 之前——「根外」是比「已存在」更根本的错误：一个根外且刚好重名的路径，
  应报 `path-outside-root`，不该让用户以为「换个名字就行」

### 7.2 判定方式（不许用 `startsWith`）

```
rootKey   = compareKeyOfPath(worktreeRoot)          // 见 §六.2 默认值
targetKey = norm.compareKey                          // precheck.ts:211 已算好
判定：targetKey 必须等于 rootKey，或以 `${rootKey}/` 开头
```

**必须复用 `worktree/paths.ts`**，不得在 `precheck.ts` 里另写一套：

- 优先复用 `normalizeWorktreePath` / `compareKeyOfPath`
- 若 `paths.ts` 缺「根内判定」函数，**应加在 `paths.ts` 里**（与 `isInsideRepo` 并列），
  **不要在 `precheck.ts` / `remove.ts` 各写一遍**——`paths.ts:5-11` 的成文理由就是「每处各写一遍必然漂移」

**为什么不能用字符串 `startsWith`**（这四种形态都会漏判）：

| 形态 | `startsWith` 的错误结论 | `compareKey` 为什么对 |
|---|---|---|
| 大小写不同（`E:\WT` vs `e:\wt`） | 判成根外 | Windows/macOS 全小写化（`paths.ts:78`） |
| `\\?\E:\wt\...` 长路径前缀 | 判成根外 | 剥 `//?/` 前缀（`paths.ts:53`） |
| 尾斜杠 / 冗余斜杠（`E:\wt\\a\`） | 判成根外（或误判根内 `E:\wt2`） | 折叠 `/`、去尾 `/`（`paths.ts:46-48`） |
| `E:\wt2` vs 根 `E:\wt` | **误判成根内**（前缀相同！） | 逐段比较，`wt2` ≠ `wt` |

最后一行是**安全问题**：`startsWith` 会把 `E:\wt2` 当成 `E:\wt` 的子目录，于是「根外创建」被放行。

### 7.3 新增失败原因

在 `shared/worktree-protocol.ts:57-67` 的 `WorktreePrecheckReason` 增加：

```
'path-outside-root'
```

**同时**在渲染层 i18n 加中英文案（现状 `path-inside-repo` / `path-too-long` 在
`renderer/src/i18n/messages.ts:1625-1626` 中文、`:3256-3257` 英文）：

- 中文：说明「必须建在当前 worktree 根目录（示例路径）之内」，并给出当前根的实际路径
- 英文：同义

**文案要求**：必须**带出当前根路径**，否则用户不知道「根」在哪、该改成什么。这与
`path-inside-repo` 只说「不能放在仓库里面」不同——那个错误用户知道仓库在哪，这个不告诉他就没法修。

〔验：`grep -n "path-outside-root" apps/desktop/src/shared/worktree-protocol.ts apps/desktop/src/renderer/src/i18n/messages.ts`
应命中 3 处（类型定义 + 中 + 英）〕

### 7.4 `suggestPath()` 也要跟着改

`create.ts:270-274` 的 `suggestPath()` 直接调 `nextFreeWorktreePath()`，绕过 precheck。
`precheck.ts:128-137` 的 `nextFreeWorktreePath()` 内部调 `defaultWorktreePath()`，
一旦 `defaultWorktreePath()` 改成读 `worktreeRoot`，这个入口**自动跟着变**。

**要求**：`defaultWorktreePath()` 是**唯一**的默认路径来源。不得在别处再拼一次
`join(getDevaHome(), 'worktrees', ...)`。

〔验：`grep -rn "getDevaHome(), 'worktrees'" apps/desktop/src` 只应命中 `precheck.ts` 一处〕

### 7.5 成员工作区自动跟着受约束（无需额外改）

`member-worktree.ts:236` 的 `checkoutRoot: checked.precheck.path` 取自 precheck 结果，
`:253` 又把这个值作为 `path` 传回 `createWorktree`。所以根内校验加上后，成员工作区**自动**被约束在根内。

**但要确认**：成员工作区若因根外被拒，主进程返回的是 `create-failed` 还是新原因，界面提示是否说得清
（见 §十一）。

---

## 八、删除侧校验

### 8.1 位置与方向

`remove.ts:202` 的 `rmSync` **之前**。两件事分开处理：

| 动作 | 根外时 |
|---|---|
| **删目录**（`rmSync`） | **拒绝** |
| **解登记 + 删记录**（`git worktree prune` / `removeRecord`） | **允许** |

**为什么分开放**：解登记和删记录是**元数据**操作，不碰用户的磁盘数据。拦掉它的后果是
「这个 worktree 永远留在列表里，还占着一个分支名」——用户会更难收拾。而删目录是不可逆的磁盘操作，
这才是取舍二要保护的东西。

### 8.2 三种记录的判定

| 记录类型 | 根内校验 | 删目录 | 界面 |
|---|---|---|---|
| 新记录（有「创建时根」） | 严格校验 | 根内才删 | 无特殊标注 |
| 老记录（缺该字段） | **跳过**（取舍二） | 允许 | 标注「不在当前 worktree 根内」 |
| 记录本身读不出（`loadState='corrupt'`） | 走既有 fail closed | 不删（既有行为） | 既有提示 |

### 8.3 校验失败必须进 `warnings` 且反映在 ok 上

`remove.ts:31-34` 的成文纪律：

> 删不掉的地方一律进 `warnings`，不静默。这一整套的教训是「静默失效」：删一半、报告说成功，
> 用户以为干净了，实际还占着几百 MB。

**要求**：

- 根外拒绝删目录 → `warnings.push(...)`，内容含**实际路径**和**当前根**
- `dirRemoved` 保持 `false`（这是既有字段，如实反映磁盘真相）
- **不得**因为「记录删掉了」就把 `ok` 报成「全部成功」——
  `ok` 的现有语义是 `res.recordRemoved`（`:250`），要确认这样报不会让用户误以为目录也删了
- 若用户明确要求「就是要删根外这个」，**本需求不提供该开关**（见 §十三 R4 的取舍说明）

### 8.4 不允许做的事

- **不得**把「在根内」当作删除授权。根内仍要过完整的既有准入
  （`getRecord` 有记录 + `looksLikeOurWorktreeDir`）。根内可能有用户自己的目录，本需求不给它额外的删除权力
- **不得**因为根外就跳过 `getRecord` / `looksLikeOurWorktreeDir`——那是既有的安全边界
- **不得**在根外时改成「移到别处」或「先备份再删」——那是新功能，不在本需求

---

## 九、设置界面

### 9.1 位置

`renderer/src/redesign/SettingsPane.tsx:41` 已有 `worktrees` 分区（`:56` 导航项、`:91` 渲染 `WorktreePane`）。
根目录设置加在该分区内。

### 9.2 控件

- 一个路径展示 + 「更改」按钮（走 `window.deva.fs.openFolder()`，与 `NewSessionDialog.tsx:158-164` 同一入口）
- 一个「恢复默认」按钮 → `setConfig({ worktreeRoot: undefined })` → 展示回默认根
- 展示当前生效值：**若是默认，要明确写「默认」**，而不是把默认路径当用户设定值显示

### 9.3 保存前必须校验的三件事

**保存时就拒**，不许等到创建时才报错：

| # | 校验 | 为什么必须在保存时拦 |
|---|---|---|
| 1 | 根**不在仓库内** | 否则每次创建都撞 `path-inside-repo`（`precheck.ts:214`），用户设了个永远用不了的根 |
| 2 | 根不能太深，使 `MAX_PATH_LEN`（180）容不下 | `node_modules` 会吃掉 80~120 字符（spec `:1270` 有记录），根已经很长时，`<root>/<repoKey>/<slug>-<shortid>` 必然超限 |
| 3 | 路径合法（`normalizeWorktreePath` 不抛、是绝对路径） | 畸形路径会让后续每次归一化都失败（`getRecord` 里 `catch → null`，`store.ts:140-145`） |

**校验 2 的具体口径**：用当前仓库的 `repoKey` 长度 + 一个不短于常见长度的 slug 试算，
对**所有已登记仓库**各算一次，任一超限就拒。不要只算当前仓库——根是全局的，切到别的项目就炸。

**校验失败时**：不写盘，给可操作提示（例如「这个根会让路径超过 180 字符，请选浅一点的目录」），
并展示试算出的超限路径样例。

### 9.4 校验 1 的细节：**拒绝，且必须说清是哪个仓库**（已拍板 Q2）

「根在仓库内」要按**每个已登记仓库**判（`listRecords()` 里的 `repoRoot` 去重），
不是只判当前打开的仓库。理由：根是全局的，切到别的项目就炸。

**判定结果：拒绝保存，不写盘。** 不做「警告但允许」的例外。

**为什么不允许保存**（用户已明确的理由）：

`isInsideRepo`（`precheck.ts:214`）会在那个仓库上**每次创建都拒绝**。允许保存的后果是
「设置说能存、实际操作每次都失败」——**这正是本需求要消灭的那类矛盾**，不能自己再造一个。

**但拒绝信息必须包含具体仓库路径，不能只说「不允许」。**

用户担心「被一个自己都忘了的旧仓库挡死」，解法不是放行，而是让他**一眼看到是哪个仓库**：

- 文案必须含**该仓库的完整路径**（`repoRoot`），必要时可附末级目录名便于辨认
- 中文示例：「这个根目录在仓库 `E:\deva` 内，请换一个」（路径必须是实际的，不是占位符）
- 英文同义，同样含实际路径
- 若有**多个**仓库命中，全部列出，不要只报第一个

〔这条对应验收断言 **A27**，是本项唯一能证伪「真的说清了」的方式〕

> **§9.3 校验 2（路径过长）同样要给出试算样例**，理由相同：拒绝必须让用户知道怎么改。

---

## 十、存量兼容

### 10.1 现有目录（如 `E:\deva-bundle`）不受影响

列表、合并、依赖、重建都按 `rec.path` 走（`list.ts:503-522` 用 `rec.path` / `rec.compareKey`），
**与根无关**。所以：

- 仍在列表里正常显示
- 合并 / 重建 / 装依赖全部照旧
- 只是**删除时**按取舍二放行，并加界面标注

### 10.1b 老目录能继续用，但不能在它旁边新建（**已拍板：取舍一优先**）

用户提问：「我以前的目录还能用啊，为什么不能在那儿新建？」——答复已定：

| 老 worktree 所在的根外目录 | 允许？ |
|---|---|
| **保留**（不删、不搬、不改路径） | ✅ |
| **出现在列表里** | ✅ |
| **删除**（取舍二：跳过根校验） | ✅ |
| **正常使用**：开会话、跑成员、合并、装依赖、重建 | ✅ |
| **在它旁边再新建一个 worktree** | ❌ **拒绝**（`path-outside-root`） |

**为什么这样分**：取舍一管的是「**新建**往哪儿建」，不管「已有资产怎么处置」。
新建是可控的决策点，制止它成本最低；而处置已有资产是不可逆操作，不该由这个需求顺手做。

**用户想继续在那个位置干活的唯一正路**：把那个目录设成 `worktreeRoot`。
设完之后它就是**标准的根**，在里面新建完全合法——**这不算例外，是正常路径**。

**界面要说清这一条**，否则用户会困惑「我的目录明明还能用」：

- 在根外老记录旁边引导一句（如「此处不能新建；想把根设到这里，去设置」），
  或在新建设置里直接给出「把当前目录设为根」的快捷入口
- 措辞不要用「非法」「无效」——这个目录本身没问题，只是不在当前根的辖区

〔这条对应验收断言 **A28**（列表与使用不受影响）与 **A2/A3**（新建受根约束）〕

### 10.2 删除老记录会发生什么

- 目录被删（跳过根校验）
- 记录被删（`removeRecord`）
- 分支按既有逻辑删（`remove.ts:213-243`）

**与现状完全一致**，只是多一条「这个目录不在当前根内」的信息性 warn。

### 10.3 不能做的事

- **不得**在列表里隐藏根外记录（用户会以为丢了）
- **不得**自动把根外目录搬到根内（那是破坏性操作，且可能跨盘）
- **不得**给根外记录改路径（改路径等于伪造历史，`rec.path` 是主键）
- **不得**因为「不在根内」就降低删除前的其他检查（脏检查、分支占用检查都保留）
- **不得**禁止在根外老记录**里**继续使用（它只是不能当新 worktree 的落点）

### 10.4 为什么不做「移到根内」（**已拍板 Q3：不做**）

用户已确认这个克制是对的。技术理由（用户已实测 `git worktree move` 跨卷 `EXDEV` 失败）：

- 要处理在跑会话、分支检出状态、`node_modules` 迁移
- 跨卷搬迁会失败，而失败时两头都不完整
- 工作量会超过本需求主体，且**移失败的风险远大于收益**

用户诉求是「别到处乱建」，不是「帮我把旧的搬家」。想做搬迁，单独排期。

---

## 十一、界面要求

### 11.1 新建会话对话框

`NewSessionDialog.tsx` 现状：`browse()` 可选任意目录（`:158-164`），选中后 `locationTouched = true`
（`:114` 起改名不再覆盖路径）。

**要求**：

- 选了根外目录 → precheck 返回 `path-outside-root` → 用 `precheckMessage()`（`:151`）显示，
  文案含当前根路径
- **不要**静默把用户选的路径改成根内路径——他选的就是他想去的，替他改是骗人
- 建议（不强制）在路径框旁常显「根：`<root>`」，让用户提前知道边界

### 11.2 工作区设置面板

`WorktreePane.tsx` 现有列表（`:29-52` 注释描述了 §7.4/§7.5 的定位）。根外记录要能看出来。

**要求**：

- 根外老记录带标注（如 secondary 文案「不在当前根内」，**不要**用红色 error 态——它不是错误，是历史）
- 标注**不得**影响其他按钮的可用性（删除、合并、重建照旧）
- 「恢复默认」后，之前的根外标注要**按新根重算**（不是一次性快照）

〔这条属界面项：`〔需要原型〕` 标注位置与形态需设计确认，但「必须能看出来」是硬要求〕

### 11.3 文案

- `path-outside-root` 必须带实际根路径
- 根外记录的标注说「不在当前 worktree 根内」，不说「非法」「无效」

---

## 十二、不在本需求范围

### 12.1 QA 脚本的临时目录（**另一件独立的事，不同批提交**）

`review-data-countercheck.cjs:5`、`review-memory-countercheck.cjs:3` 用
`fs.mkdtempSync(path.join(os.tmpdir(), ...))` 建临时目录，**文件内无 `rmSync`、无任何清理逻辑**。
✔ 本次复核：`grep -n "tmpdir\|rmSync\|mkdtemp" .deva/qa/review-{data,memory}-countercheck.cjs`
只命中 `mkdtempSync`，无 `rmSync`。

**明确切出去**：

- 与本需求**不同批提交**
- 不进本需求的验收清单
- 在本需求实施时**不要顺手改**——`os.tmpdir()` 的清理策略（何时删、删不掉的怎么办）
  需要单独定，混进来会让这个提交的验收范围失控

### 12.2 其他不做

| 项 | 理由 |
|---|---|
| 根内目录的自动清理 / 回收 | 与「删除必须是用户明确意图」冲突（`remove.ts:24-29`） |
| 存量根外目录的搬迁 / 纳管 | 破坏性、可能跨盘、会改主键 |
| 多个根（每个仓库一个根） | 用户要的是「自己设**一个**目录」；多根会让「根外」判定失去唯一参照 |
| 根目录的容量 / 配额管理 | 超出范围 |
| 强制老记录回填「创建时根」 | 真实值不可知，且需重写 `worktrees.json`（见 §6.3） |
| 根外记录的「强制删除」开关 | 本需求不提供；若后续确有需要，单独排期 |

---

## 十三、验收清单

每条都能回答「哪条命令 / 哪个观察能证明它没做到」。**A 档缺一即不可交付。**

### 13.1 创建侧：根外被拒

- [ ] **A1** 未设 `worktreeRoot`（`config.json` 里无该键）时创建，新目录落在
  `join(getDevaHome(), 'worktrees')/<repoKey>/<slug>-<shortid>`。
  〔验：创建后 `node -e "console.log(require('./.deva/wt.json').path)"` 或界面展示路径，
  与 `path.join(process.env.DEVA_HOME||'~/.deva-plus','worktrees')` 比对；`realpath` 后逐字符相等〕
  - **前置**：`~/.deva-plus/worktrees` 原本**不存在**（实测如此），创建后应被建出来——
    这条同时验证「默认位置终于被用上了」

- [ ] **A2** 传一个根外绝对路径给 `worktree:precheck`，返回 `ok:false` 且 `reason === 'path-outside-root'`。
  〔验：`curl`/单测调 precheck，`path: "E:\\some-outside-dir"` → 断言 `reason` 逐字符等于 `path-outside-root`，
  并贴出 `message` 原文〕
  - 反向证据：把该断言改成 `reason === 'path-exists'` 或 `ok === true`，必须失败

- [ ] **A3** 传根内子目录（`<root>/<repoKey>/my-custom-name`）创建**成功**，目录就在那里。
  〔验：precheck `ok:true`、`create` 返回 `ok:true`、`test -d <那个路径>` 为真〕

- [ ] **A4** 前缀相同的根外兄弟目录被拒：根 `E:\wt`，目标 `E:\wt2\x` → `path-outside-root`。
  〔验：直接把目标路径写成 `E:\wt2\x`，断言 `reason === 'path-outside-root'`〕
  - 这条专验「没用 `startsWith`」。若实现用了 `startsWith('E:\wt')`，`E:\wt2\x` 会被判**根内**并放行 → 失败

- [ ] **A5** 同一路径的四种变形都判**根内**：大小写不同、`\\?\` 前缀、尾斜杠、冗余斜杠。
  〔验：`E:\WT\a`、`\\?\E:\wt\a`、`E:\wt\a\`、`E:\wt\\a` 四个输入 → `reason !== 'path-outside-root'`〕
  - 与 A4 互为反向证据：A4 验「不误放行」，A5 验「不误拒绝」

- [ ] **A6** `path-outside-root` 的文案**含当前根的实际路径**。
  〔验：读出 `messages.ts` 里该键的中英文，`includes` 断言含占位符；或调 precheck 后 `message` 里
  出现根路径的子串〕

- [ ] **A7** `WorktreePrecheckReason` 类型里存在 `path-outside-root`，且 i18n 中英文都有该键。
  〔验：`grep -c "path-outside-root" apps/desktop/src/shared/worktree-protocol.ts` ≥1；
  `grep -c "path-outside-root" apps/desktop/src/renderer/src/i18n/messages.ts` 为 2（中+英）〕

- [ ] **A8** 默认路径只有一个来源：`grep -rn "getDevaHome(), 'worktrees'" apps/desktop/src` 只命中 `precheck.ts` 一处。
  〔验：上面那条 grep 的命中数 == 1〕

### 13.2 删除侧：根外不删、但能收拾

- [ ] **A9** 对根外的新记录执行删除：目录**仍在**（`test -d` 为真）、记录**已删**（`getRecord` 返回 null）、
  `warnings` 里有含实际路径的一条、`dirRemoved === false`。
  〔验：造一条根外新记录 → `worktree:remove` → 逐项断言上述四项；贴 `warnings` 原文〕

- [ ] **A10** 对根外的**老记录**（缺「创建时根」字段）执行删除：目录被删、记录被删。
  〔验：手写一条缺该字段的 `worktrees.json` 记录 + 真目录 → remove → `test -d` 为假、记录为 null〕

- [ ] **A11** 根外的老记录在列表里可见，且带「不在当前根内」标注；其它按钮不受影响。
  〔验：`list()` 返回该项有标注字段；界面断言标注文本存在；`mergeGate` / 删除按钮可用性不变〕
  - `〔需要原型〕` 标注位置与形态

- [ ] **A12** 在根外拒绝删目录时**不得**报成「全部成功」：`ok` 与 `dirRemoved` 各自如实。
  〔验：A9 场景下检查返回体；若 `ok === true` 而 `dirRemoved === false`，
  断言界面**有可见提示**说目录没删（不能只看 `ok`）〕

### 13.3 存量兼容

- [ ] **A13** 现有根外目录（如 `E:\deva-bundle`）在列表、合并、重建、装依赖上**行为与改动前一致**。
  〔验：改动前后各跑一次 `list()`，该条目的 `state` / `deps` / `mergeGate` / `sessionCount` 逐字段相等〕

- [ ] **A14** 改根之后，老记录**不因为根变了而消失或变红**。
  〔验：设根 A → 记录若干 → 改成根 B → `list()` 条数不变，老记录只多标注、`state` 仍为 `ok`〕

### 13.4 设置界面

- [ ] **A15** 保存一个**在仓库内**的根 → 被拒，不写盘，且拒绝信息含该仓库完整路径（详见 **A27**）。
  〔验：`setConfig({worktreeRoot: <repoRoot>/sub})` → `ok:false`；重读 `config.json` 无该键〕
  - 与 A27 的分工：A15 验「有没有拒 + 有没有写盘」，A27 专验「拒绝信息含不含具体路径」。两条都要过

- [ ] **A16** 保存一个**会让路径超 180** 的根 → 被拒，并给出试算超限样例。
  〔验：造一个长根（如 170 字符）→ 保存被拒，`message` 里出现一条试算路径〕

- [ ] **A17** 「恢复默认」= 删键：`config.json` 里不再有 `worktreeRoot`，展示回默认根。
  〔验：`setConfig({worktreeRoot: undefined})` → `grep -c worktreeRoot config.json` 为 0；
  precheck 返回的默认路径是 `<DEVA_HOME>/worktrees/...`〕

- [ ] **A18** 设了自定义根后，`precheck` 返回的**默认路径**（不传 `path` 时）基于新根。
  〔验：设根 X → `precheck({path:''})` → `res.path` 以 `X` 开头（用 compareKey 比，不用 startsWith）〕

### 13.5 `DEVA_HOME` 与默认根

- [ ] **A19** 未设 `worktreeRoot` 时，改 `DEVA_HOME` 并重启，默认根**跟着变**。
  〔验：`DEVA_HOME=E:\tmp\dh2 pnpm start` → precheck 默认路径在 `E:\tmp\dh2\worktrees` 下〕
  - 说明：这条验证「默认值不写进文件」这个设计。若把默认值写死进 `config.json`，重启后仍是旧路径 → 失败

- [ ] **A20** 设了 `worktreeRoot` 时，改 `DEVA_HOME` **不**改变根（用户显式设定的优先）。
  〔验：设根 X + 改 `DEVA_HOME` 重启 → 默认路径仍在 X 下〕

### 13.6 记录兼容（不破坏既有纪律）

- [ ] **A21** 老记录的 `worktrees.json` 载入后**不被判 corrupt**：`loadState === 'ok'`，写操作正常。
  〔验：用改动前的 `worktrees.json`（无新字段）启动 → 创建一个新 worktree 成功（若被判 corrupt，
  `upsertRecord` 会拒绝写盘、创建报失败）〕
  - 这条专验「新字段必须是可选的」。把它改成必填后此条会失败

- [ ] **A22** 文件级 `schemaVersion` 仍是 `1`，`WorktreeRecord.schemaVersion` 仍是字面量 `1`。
  〔验：`grep -n "SCHEMA = 1\|schemaVersion: 1" apps/desktop/src/main/services/worktree/store.ts`〕

- [ ] **A23** 新记录写入了「创建时根」（compareKey 形态），且能据此严格校验。
  〔验：新建后读 `worktrees.json` 该条有新字段；把根改成别的值 → 该记录删除时被拒删目录〕

### 13.7 成员工作区

- [ ] **A24** 成员工作区创建时，若其 `checkoutRoot` 落在根外 → 被 `path-outside-root` 拒，且界面提示说得清。
  〔验：把根改成不含某成员的旧路径 → 触发一次成员绑定 → 返回原因是 `create-failed` 且 message 含根信息；
  会话未被错误地标为已绑定〕

- [ ] **A25** 正常路径下（根内）成员工作区绑定行为与改动前一致。
  〔验：`bindMemberWorktree` 成功，`checkoutRoot` 在根内，`focusRoot` 正确〕

### 13.8 不算失败的观察（避免误判）

- [ ] **A26** 记录改动前的现状：`test -d ~/.deva-plus/worktrees` 为**假**（目录不存在）。
  〔验：改动前跑 `test -d "$HOME/.deva-plus/worktrees" && echo exists || echo absent`，应输出 `absent`〕
  - **这不是断言「做错了」**，而是取基线。若验收时发现改动前该目录已存在，说明机器上另有来源，
    需重新核对 §一 的 323 个目录统计，**不得**把「改动前目录不存在」当成 bug。

### 13.9 设置拒绝必须说清原因（Q2 / Q4 的关键点）

- [ ] **A27** 保存一个**落在某个已登记仓库内**的根 → 被拒，且**拒绝信息里包含该仓库的完整路径**。
  〔验：造两态——
  ① 单仓库命中：设根为 `<repoRoot>/sub` → `setConfig` 返回 `ok:false`，
     `message`（或 `detail`）`includes` 该仓库的 `repoRoot` 实际字符串（不是占位符、不是「某个仓库」这种泛称）；
  ② 多仓库命中：登记两个仓库 A、B，根同时落在两者内 → 拒绝信息里 **A 与 B 的路径都出现**（不得只报第一个）。
  两条都要断言，缺一条即算没做到〕
  - **反向证据**：把文案改成不含路径的「这个根目录不允许」→ 本断言必须失败。
    这是刻意设计的：只验「拒绝了」不够，本需求要消灭的就是「拒绝了但不说清怎么改」
  - 用户已明确：这是他不同意「警告但允许」的**唯一补偿条件**，必须硬性满足

- [ ] **A28** 根外老 worktree **可列出、可删除、可正常使用**，但**不能在它旁边新建**（取舍一优先）。
  〔验：造一条根外老记录（如 `E:\deva-bundle`）→
  ① `list()` 里有它、`state === 'ok'`、`sessionCount` 正常；
  ② 在里面开会话/跑一轮正常；
  ③ 对它执行 remove 成功删目录（A10 同）；
  ④ 以它所在的目录为落点新建 → `path-outside-root` 拒绝；
  ⑤ 把 `worktreeRoot` 设为它所在的目录后，同一位置新建**成功**〕
  - 第 ⑤ 步是关键：证明「设成根就不算例外」，不是硬拒绝

---

## 十四、已拍板的四项取舍（v2 · 2026-11-23 用户定案）

以下 4 项原为待拍板，**现已全部拍板**，本节即定案。实现方按此执行，**不得自行改动**。

### Q1 根内子目录允许嵌几层 → **任意深度**

只要最终落在根内，**不限层数**。不加任何层数上限。

**理由**（用户原话要点）：限制层数是在替用户决定怎么用，收益只是「将来好做结构清理」，
而清理本来就应该靠 **marker + 根内判定**，不靠层数。加限制会挡住
`E:\wt\项目A\特性B\尝试1` 这种合理用法。

**实现要求**：

- 根内判定只看「最终路径是否在根内」，**不数层数**
- 不得引入「只允许 N 层」的校验（那会成为新的误拒来源）
- 将来若要做根内清理，靠记录/标记定位，不靠目录深度

### Q2 根落在某个仓库内时 → **拒绝保存**（不做「遍历后放行」的例外）

**拒绝保存，不写盘。** 不做「警告但允许」。

**理由**：`isInsideRepo`（`precheck.ts:214`）会逐次拒绝在该仓库内创建，用户会看到一个
**能保存、但每次都失败**的设置——这正是本来要消灭的那类「设置说行、实际操作不行」。

**但拒绝信息必须包含具体仓库路径**（这是 Q2 的硬要求）：

- 文案必须含**仓库的完整路径**，不能只说「不允许」
- 有多个仓库命中时全部列出，不要只报第一个
- 示例：「这个根目录在仓库 `E:\deva` 内，请换一个」
- 〔验：**A27**〕

**「被忘了的旧仓库挡死」的解法不是放行**：用户看到路径就知道是哪个，删掉那条记录或换个根即可。

### Q3 根外老记录要不要「移到根内」出口 → **不做**

**不做搬迁、不做原地纳管。** 这是正确的克制。

**理由**：移目录要处理在跑会话、分支检出、`node_modules` 迁移、`git worktree move`
跨卷 `EXDEV` 失败（用户已实测）。工作量会超过主体，**移失败风险远大于收益**。
用户诉求是「别到处乱建」，不是「帮我把旧的搬家」。详见 §10.4。

### Q4 保存时要不要算「slug 还剩几字符」 → **不单独校验**

沿用既有 `path-too-long`。

**理由**：人为阈值没有依据；字符预算跟 slug 命名策略耦合，定死一个数字迟早要改。

**实现要求**：

- 保存时只做 §9.3 的校验 2（用常见长度试算，任一已登记仓库超限就拒，并给试算样例）
- 创建时由既有 `path-too-long`（`precheck.ts:212-213`）兜住
- 不得引入「剩余字符数 < N 就警告」这类阈值

---

## 十四附、取舍一览（给实现方速查）

| 编号 | 问题 | 结论 | 关键要求 |
|---|---|---|---|
| Q1 | 根内子目录嵌几层 | **任意深度** | 不数层数，清理靠 marker 不靠深度 |
| Q2 | 根在某仓库内能否保存 | **拒绝** | 错误信息必须含该仓库完整路径 |
| Q3 | 根外老记录能否移到根内 | **不做** | 不搬、不纳管；用户自己删了重建 |
| Q4 | 保存时算 slug 剩余字符 | **不单独校验** | 沿用 `path-too-long`，不设人为阈值 |

**另有一条已定的矛盾答复**（见 §10.1b）：根外老 worktree **保留、可列出、可删除、可正常使用**，
但**不能在它旁边新建**。想在那儿继续干活，就把该目录设为 `worktreeRoot`——此时它是标准根，不算例外。

---

## 十五、与既有规格的关系

### 15.1 不改变的东西

| 项 | 依据 |
|---|---|
| `repoKey` 分桶 | 用户明确要求保留；`paths.ts:107-110` |
| `MAX_PATH_LEN = 180` | `paths.ts:143`，本需求不绕过 |
| `isInsideRepo` 硬约束 | `precheck.ts:214`，本需求不绕过 |
| 存量记录按 `rec.path` 工作 | `list.ts:503-522` |
| 删除的既有准入（有记录 + 像我们的目录） | `remove.ts:108, 193` |
| 写盘失败不静默 | `remove.ts:31-34`、`store.ts:70-79, 120-130` |
| `worktrees.json` 读失败 fail closed | `store.ts:80-118` |

### 15.2 需要同步修改的文件（给实现方的范围提示，不是实现方案）

| 文件 | 改什么 |
|---|---|
| `main/services/config.ts` 或新模块 | 读 `worktreeRoot`（缺键返回 `undefined`，由调用方算默认） |
| `main/services/worktree/paths.ts` | 加「根内判定」函数（与 `isInsideRepo` 并列，复用 compareKey） |
| `main/services/worktree/precheck.ts` | `:116-120` 默认路径读根；`:211-222` 之间插根内校验 |
| `main/services/worktree/store.ts` | `WorktreeRecord` 加可选字段；**不动** `schemaVersion` / `SCHEMA` |
| `main/services/worktree/create.ts` | 写入「创建时根」；确认 `suggestPath` 跟着变 |
| `main/services/worktree/remove.ts` | `:202` 前加根内校验；老记录放行；进 `warnings` |
| `main/services/worktree/list.ts` | 返回「是否在根内」标记供界面标注 |
| `shared/worktree-protocol.ts` | `:57-67` 加 `path-outside-root`；`WorktreeListItem` 加标注字段 |
| `renderer/src/i18n/messages.ts` | `:1625` / `:3256` 附近加中英文案（带根路径） |
| `renderer/src/redesign/WorktreePane.tsx` | 根外标注 + 根目录设置控件 + 恢复默认 |
| `renderer/src/redesign/NewSessionDialog.tsx` | 确认 `path-outside-root` 有可读提示（`precheckMessage`） |

**必须在同一提交内完成**：`path-outside-root` 的类型定义 + 主进程返回 + 中英文案。
漏掉文案会让界面显示原始错误码（`MEMBERS.md` 界面章「错误码两端同时改」）。

### 15.3 交叉引用

在 `.deva/spec-worktree-parallel.md` 的根目录相关段落（§6.1 / §6.2.2 / `:1270` 附近）
加一句：worktree 根可自定义，约束与校验见本文档。**不重复描述**，避免两份文档漂移。
