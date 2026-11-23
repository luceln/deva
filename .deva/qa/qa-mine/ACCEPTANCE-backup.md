# 验收报告：备份包导出 / 整机还原（`feat/export-import` @ `9faf8c3`）

- 对象：`E:\deva-bundle`，HEAD `9faf8c3f9235644c95132e159cefa645dfe35ea6`，分支 `feat/export-import`
- 用户需求原文：「导出后，我彻底删除卸载了应用，包括什么会话之类的。然后我重新安装，导入本地包，结果就是跟我没卸载之前一样。」
- 全部实测夹具建于 `os.tmpdir()`，`DEVA_HOME` 指向那里。**未碰真实 `~/.deva-plus`、未执行卸载**。
- 产品代码**零改动**（`git status` 只有我新增的 `.deva/qa/qa-mine-*.cjs` 夹具）。
- 每个「通过」都尽量做了反向注入，证明判据不空跑；测不到的明确写「测不到」。

---

## 总判：**现在不能交付**

功能骨架扎实（导出、还原、哈希校验、zip slip 防护、覆盖前备份、symlink 重建、大包都能跑），但有 **2 个 P0 级静默失效**，直接违反用户那句「跟我没卸载之前一样」：

1. **不带口令导出时，旧机器的 `secrets.json` 密文会作为普通文件进包，还原后覆盖用户新填的密钥** —— 界面报「包里不含密钥」，用户以为要重填，实际盘上被换成了新环境解不开的旧密文。这正是 `bundle-crypto.ts:26-28` 注释里自己警告的「还原成功但所有服务商 401」。
2. **「整文件替换」名不副实，实际是「覆盖写入」** —— 包里没有的文件会残留。重装后应用生成的种子数据（内置角色等）会和新还原的旧数据混在一起。

另有 **1 个 P1**：600MB 包还原峰值 RSS **1872MB**（源大小 3.12 倍），因为 `unzipSync` 把整包读进内存。

---

## 逐条验收

### 验收项 1：能把当前全部数据导出成一个本地文件 —— **通过**

实测（`verify-bundle-real.cjs` + 自建夹具）：

```
PASS E1 导出成功 :: 18 文件, 9360 字节
PASS E2a 派生/临时物未进包 :: data/chats/_index.json, data/chats/_index.dirty, import.lock
PASS E3 包内每个文件哈希与源一致 :: 18 个
PASS E4 媒体二进制完全一致
PASS E5 符号链接已记录 :: target=...\external-skill
```

排除清单（`bundle-manifest.ts:37-44`）合理，逐条都有理由：`_index.json`/`_index.dirty`（派生可重建）、`import.lock`（会误判「另一个窗口在导入」）、`*.tmp`/`*.bad-*`（过程产物）、`.magpie-agent*.json`（外部插件状态，本应用只读）。

我另测了大包（不可压缩 600MB 媒体）：

```
PASS G1 大包导出成功 :: 602 文件, 600.1 MB, 用时 5588ms
NOTE 导出期间峰值 RSS: 134 MB（增量 78 MB，源数据 600 MB）
PASS G2 导出不是把全部内容读进内存
```

**导出是真流式**（峰值增量 78MB vs 源 600MB），`.part` + rename 避免半截文件，目标已存在时改名不覆盖。这块做得好。

### 验收项 2：用户能彻底卸载（含删掉凭据）—— **通过（静态核实）**

未执行卸载（红线）。读 `installer-uninstall.nsh` 核实删除范围包含：

- `$cleanRoot\secrets.json`（`:461` 附近）
- `$cleanRoot` 下 `data`/`personas`/`skills`/`projects`/`uploads`/`profile` 六目录
- `$APPDATA\devaplus`（`Local State` 存在才删，`:500-504`）—— **这是 DPAPI 主密钥所在**
- `$LOCALAPPDATA\devaplus-updater`、`$LOCALAPPDATA\devaplus`

**回答你问的第 1 条**：卸载器**确实**会删掉密钥凭据（`%APPDATA%\devaplus\Local State`）。所以「用口令重新封装密钥」这个设计**不是多余的**——原密文重装后必然解不开。设计前提成立。

不删除的范围也核过：worktree 代码、原版 `$APPDATA\@deva\desktop` 都不碰，与文案一致。

### 验收项 3：重装后能从该文件还原 —— **通过**

```
PASS E7a 还原成功 :: 18 文件
PASS E7b 还原后文件齐全 :: 18 个
PASS E7c 还原后内容与原文件一致（密钥段除外，它须被重封装）
PASS E7d 还原后密钥可用本机凭据解开 :: 1 条
PASS E10 非空目标未确认 → 拒绝且零写入
PASS E11 覆盖前自动备份 :: home-restore-backup-20261122141432062-d2i3
PASS E12 损坏包被拒且目标未被破坏 :: corrupt
PASS E13 zip slip 被拒 :: ../../evil.txt
PASS E14 错口令被拒 :: bad-passphrase
PASS E15a 第二次还原后内容仍与包一致（幂等）
```

安全底线守住了：zip slip 在**写任何文件前**全量校验（`bundle-import.ts:134-138`），逐文件 sha256 复核，损坏包拒绝且不动目标，临时目录在 `finally` 清理。我的夹具也确认：

```
PASS P8 临时 staging 目录已清理 :: （已清理）
```

### 验收项 4：还原后全部与卸载前一致 —— **不通过（2 项）**

分项：

| 子项 | 结论 | 依据 |
|---|---|---|
| 会话 | **通过** | `O6 旧会话回来了`（实测） |
| 附件 | **通过** | `E4 媒体二进制完全一致`（实测 sha 比对） |
| 角色（自定义） | **通过** | `O7 旧自定义角色回来了`（实测） |
| 角色（内置） | **不通过** | `O8 包里没有的内置角色在还原后是否残留 :: deva.md=true lucy.md=true` |
| 记忆 | **通过** | `O10 旧记忆回来了 :: mem-old-1, mem-old-2`（实测） |
| 技能（junction） | **通过** | 见下 |
| 服务商配置 | **通过** | `O4 旧 provider 在 :: ["old-provider"]`（实测） |
| **API 密钥** | **不通过** | 见 P0-1 |
| 主题 | **通过** | `C1 主题回来了`（实测） |
| 语言 | **通过** | `C2 语言回来了`（实测） |
| **窗口大小** | **不成立** | 见下 |

#### P0-1：不带口令导出会把旧机器密文带进包，还原后覆盖用户新填的密钥（**不通过**）

自建夹具 `qa-mine-ciphertext.cjs`：

```
PASS Q1 scanHome 把 secrets.json 当普通文件收进清单 :: 清单: config.json, secrets.json
PASS Q3 包里**没有** secrets.enc（符合设计）
PASS Q4 包里**有** home/secrets.json（原密文被当普通文件带走） :: manifest.json, home/config.json, home/secrets.json
PASS Q5 包内 home/secrets.json 就是旧机器密文（未解成明文）
FAIL Q9 无口令还原**不应**覆盖用户新填的密钥（否则重装后 provider 全 401） :: FAIL: 旧机器密文覆盖了新填的密钥
NOTE Q8 还原后 secrets.json 的 p1 值 :: 被旧机器密文覆盖了
```

**根因**：`bundle-manifest.ts:37-44` 的 `EXCLUDED_EXACT` 排除了 `_index.json`、`import.lock`、`.magpie-agent*.json`，但**没有排除 `secrets.json`**。于是：

- 带口令时：`secrets.enc` 走加密路径正确重封装，但 `home/secrets.json` 里的旧密文**同时也被写盘**，然后 `replaceAllSecrets()` 覆盖它——碰巧被修正。
- **不带口令时**：没有 `secrets.enc`，`replaceAllSecrets()` 完全不被调用（`bundle-import.ts:308` 直接 `return { restored: 0, absent: true }`），于是盘上留的就是**包里那份旧密文**。

后果：界面文案 `cf.backup.secretsAbsent = "包里不含密钥"`（实测 N7 读出原文），用户理解成「需要重填」，但实际 `secrets.json` 已被换成新环境 DPAPI 解不开的旧密文。所有 provider 会 401，而设置页显示「密钥已配置」。

同理，**无加密能力（Linux 缺 libsecret）时也会留下旧密文**：

```
PASS R3 报告 noEncryption=true :: {"restored":0,"absent":false,"noEncryption":true}
NOTE R6 结论 :: 盘上留的是包内带来的旧机器密文 —— 新环境解不开，但界面会显示"密钥已配置"
```

安全底线没破（`PASS R5 没有写入明文`），但「存在但不可用」比「明确缺失」更难排查。

**影响范围判断**：这条**只有不输口令导出时触发**。输口令走界面是正常的。但界面把口令做成「可选」（`BackupPane.tsx:221` 就是普通输入框，没标必填），用户很容易不填——尤其看到「口令忘了就解不开」的提示后反而更愿意不填。

#### P0-2：「整文件替换」实际是「覆盖写入」，残留脏数据（**不通过**）

自建夹具 `qa-mine-overwrite.cjs`，模拟真实场景（重装后应用已启动过、生成了种子数据，然后还原）：

```
PASS O3 旧 config 被覆盖回来（theme=dark） :: theme=dark
PASS O6 旧会话回来了
PASS O7 旧自定义角色回来了
NOTE O8 包里没有的内置角色在还原后是否残留 :: deva.md=true lucy.md=true
NOTE O11 还原后 home 文件总数 vs 包内文件数 :: 还原后=7 包内=4
NOTE O12 结论 :: 多出 3 个包内没有的文件，说明是「覆盖」而不是「整份替换」
```

另测（`qa-mine-links.cjs`）：

```
NOTE L12 包里没有的文件在还原后是否残留（整文件替换 vs 合并） :: leftover会话=true leftover角色=true 预置memory=true
```

**根因**：`bundle-import.ts:207-222` 的替换循环只做「把包里的文件写到目标」，**从不删除目标里包里没有的文件**。而 `bundle-format.ts:7-8` 和 `bundle-import.ts:58-63` 的注释都明确宣称是「整文件复原」「一个字段都不留」。

后果：重装后应用首次启动会写种子 `config.json`、内置角色 `personas/deva.md` 等。还原后这些文件与旧数据并存——旧的自定义角色和新的内置角色混在一个目录里。`config.json` 因为是整份覆盖所以没问题，但**目录级**（`personas/`、`skills/`、`data/chats/`）是合并语义。

#### 窗口大小：**这个验收项不成立**（不是实现的问题，是需求描述有误）

你告知的事实里有「界面偏好（窗口大小/主题/语言）」，我核实：

```
FAIL C3 窗口大小在 config.json 里有对应字段 :: config 顶层键: version,theme,language,providers,activeModelId
```

全仓搜索确认窗口尺寸**从未被持久化**：

```
apps/desktop/src/main/index.ts:153   width: 1280,
apps/desktop/src/main/index.ts:154   height: 820,
（无 getBounds/setBounds/windowState 的持久化路径，全仓无 windowBounds/windowSize 字段）
```

`main/index.ts:152-156` 是写死的 `1280 × 820`。所以 **「窗口大小能回来」这个验收项在当前代码里根本不成立**——不是备份功能漏了，是这个应用从来没有存过窗口大小。主题和语言确实在 `config.json`（`i18n.tsx:29`、`ThemeContext.tsx:47` 都注明「优先 ~/.deva-plus/config.json」），所以那两项通过。

**建议**：要么把这条从需求里去掉，要么另开一个「记住窗口大小」的需求。别把它挂在备份功能的验收里。

#### 技能 junction：**通过（实测，含反向注入）**

```
PASS L2 清单里记了 junction :: [{"path":"skills/linked-skill","target":"...\external-repo"}]
PASS L3 junction 的目标内容没被打进包（只记链接本身） :: home/skills/linked-skill.symlink
PASS L5 还原后仍是符号链接（不是实体副本） :: lstat.isSymbolicLink=true
PASS L6 relinked 计数=1
PASS L8 通过还原后的链接写入能落到外部仓库（链接真的联动了）
NOTE L10 坏链接还原结果 :: relinked=0 symlinkAsCopy=["skills/linked-skill"]
```

**反向注入**（把 `existsSync(link.target)` 改成 `false && ...`，即永不重建链接）：

```
FAIL L5 还原后仍是符号链接（不是实体副本） :: lstat.isSymbolicLink=false
FAIL L6 relinked 计数=1 :: relinked=0
FAIL L7 symlinkAsCopy 为空（目标存在时不降级） :: ["skills/linked-skill"]
```

判据有效。**但 `symlinkAsCopy` 在界面上完全不可见**——见下「界面缺口」。

---

## 你点名要验的 7 条

### 1. 卸载器真的会删掉密钥凭据吗？—— **会**

见验收项 2。删 `%APPDATA%\devaplus`（含 `Local State` = DPAPI 主密钥）+ `$cleanRoot\secrets.json`。所以口令封装设计**必要，不多余**。

### 2. 不输口令导出会怎样？包还能不能还原？还原后密钥怎么办？—— **能还原，但密钥被旧密文污染（P0-1）**

```
PASS A1 无口令导出成功
PASS A3 包里没有 secrets.enc
PASS A5 无口令包可还原（不报错） :: {"ok":true,..."secrets":{"restored":0,"absent":true}}
PASS A7 无口令还原后会话/配置/角色都在
NOTE A8 无口令还原后密钥库状态 :: secrets.json 存在=true
```

能还原、会话配置角色都在，但 `secrets.json` 是包里那份旧密文——见 P0-1。

### 3. 口令输错会怎样？会不会在解压 600MB 之后才告诉你错？—— **界面路径会提前拦，但接口路径不拦且已破坏数据**

界面路径（`BackupPane.tsx:144-155`）正确处理：`doRestore()` 里先 `checkPassphrase`，`bad-passphrase` 就 `return`，不会调 `restore`。实测底层能力有效：

```
PASS P9 verifyPassphrase 能在还原前判出口令对错（界面正是这么用的） :: 对=true 错=false
```

**但直接调 `restoreBundle`（即 `backup:restore` 通道）没有任何前置校验**，实测：

```
PASS P2 错口令被拒（code=bad-passphrase）
NOTE P3 错口令被拒后，目标 home 的实际状态 :: theme light→dark; 新用户会话 true→true; 新用户角色 true→true
NOTE P4 错口令被拒后，包里的旧数据是否已经写进去了 :: 旧会话=true 旧角色=true secrets.json=true
FAIL P5 错口令被拒时**不应**改动目标数据 :: theme light→dark
FAIL P6 错口令被拒时**不应**把包内文件写进目标 :: 旧会话=true 旧角色=true
```

**根因**：`restoreSecrets()` 在 `bundle-import.ts:252` 才被调用，**排在「替换 home 内容（第 5 步）」之后**。所以口令错之前，文件已经全写进去了，`overwriteConfirmed` 的「覆盖前备份」也做完了。

用户正常点界面不会踩到（有前置拦截），所以对最终用户影响有限。但：
- 通道层没有保护，将来任何别的调用方（自动重试、CLI、别的面板）复用就会中招；
- 更稳妥的做法是把 `restoreSecrets` 的解密**提到替换之前**（只验口令 + 预备明文，等文件落位后再写密钥）。

**这条我判「界面通过 / 接口不通过」。**

### 4. 目标已有数据时会不会直接覆盖？有没有明确提示？覆盖后能不能退回去？—— **有提示、能退回，但退路对用户不可见**

- 不确认 → `PASS E10 非空目标未确认 → 拒绝且零写入`（实测）
- 确认后 → 先备份到 `<home>-restore-backup-*`：`PASS L14 覆盖前备份存在 :: ...home4-restore-backup-20261122141551591-quyo`
- 备份失败会中止：`bundle-import.ts:167-170`（读代码）

**但 `backupOfPrevious` 在界面上完全没显示**：

```
$ grep -rn "backupOfPrevious" apps/desktop/src/renderer/src/
BackupPane.tsx:173:  backupOfPrevious?: string        ← 只有类型声明
```

用户被告知「已覆盖」，但不知道退路在哪、叫什么名字。`symlinkAsCopy`、`relinked`、`configReloadError` 同样只出现在类型声明里：

```
needsRestart: 1 处 / backupOfPrevious: 1 处 / symlinkAsCopy: 1 处 / relinked: 1 处 / configReloadError: 1 处
（全部在 161-177 行的类型里，界面上零渲染）
```

### 5. 还原完成后要不要重启？`needsRestart: true` 意味着什么？—— **要重启；字段本身是废的，提示是硬编码**

`needsRestart` **恒为 `true`**（实测 B1），因为 `bundle-import.ts:286` 写死：

```ts
needsRestart: true,
...(cfg.ok ? {} : { configReloadError: cfg.reason })
```

也就是说：`reloadConfigFromDisk()` 成功与否都返回 `true`。这个字段**不携带信息**，界面也没读它（只在类型里）。实际提示来自写死的文案：

```
fork.ts:196  restoreDone: '还原完成：{files} 个文件，{secrets}。建议重启应用让所有改动生效。'
```

**实际影响**：`config` 会重读（`bundle-import.ts:274`），会话索引会用 `invalidateIndexOnly()` 失效重建，所以**当前窗口里大部分东西会立刻生效**（实测 `O3 theme=dark` 说明 config 确实重读了）。但内存里其它模块（角色列表、技能注册、MCP 连接）不一定重载，所以「建议重启」这个提示是对的，只是它不是根据 `needsRestart` 判断出来的，而是无条件显示。

**这不是 bug，是字段设计冗余**。但如果将来有人想「配置重读成功就不提示重启」，会以为改 `needsRestart` 有用——实际它恒 true，改了没效果。

### 6. 界面偏好真的会回来吗？—— **主题/语言会，窗口大小不成立**

见验收项 4 的表格与说明。

### 7. 技能里的 junction 还原后还生效吗？—— **会（实测）**

见验收项 4 的技能行。还额外验了「通过还原后的链接写文件能落到外部仓库」（L8），证明链接真的联动，不是空壳。

---

## 我另外发现的问题

### P1：还原用 `unzipSync` 把整包读进内存，峰值是源大小的 3 倍

```
300MB 包：NOTE 还原期间峰值 RSS: 994 MB（源 300 MB），3.31×
600MB 包：NOTE 还原期间峰值 RSS: 1872 MB（源 600 MB），3.12×
（导出侧同期峰值仅 134 MB，增量 78 MB）
```

`bundle-import.ts:122` 的 `unzipSync(new Uint8Array(zipBuf))` + 第 115 行 `readFile` 同时持有两份。60 万级 pak 在低配机器（8GB 内存 + 常驻应用已占 2-3GB）上有 OOM 风险。

代码注释（`:108-111`）解释了为什么选 sync（换取「解压前能校验全部条目名」），理由成立。但可以用「先扫中央目录只取条目名 → 校验 → 再流式解压」兼顾两者。**不阻塞交付，但建议记一条**。

### 他们的 `verify-bundle-real.cjs` 有 2 处假通过（这条影响我对「参考命令」的信任度）

**E8a/E8b（mtime 刷新）判据太宽松**：判据是 `mtime > oldTime + 86400000`。我把 `utimes` 整行删掉后跑他们的脚本：

```
（删掉 utimes 后）
PASS E8a checkpoint mtime 已刷新
PASS E8b 媒体 mtime 已刷新
==RESULT== 24 PASS / 0 FAIL
```

**24 条仍全绿**。原因：还原流程先在 staging 里 `writeFile`（新文件，mtime=现在），再 `cp` 到 home，`cp` 保留的是 staging 的「现在」。所以即使删掉 `utimes`，mtime 也远大于 `oldTime`。**他们这条断言无法发现 `utimes` 被删。**

我自建 `qa-mine-mtime.cjs` 也用严判据测，结果同样是「删了 `utimes` 也通过」——所以我要如实说：**在当前实现下 `utimes` 这段是冗余的**（因为来源已是新时间戳）。它只在「staging 里文件被保留了旧 mtime」时才必要，而当前 staging 是 `writeFile` 出来的，恒为新。

**结论**：`utimes` 留着无妨（防御性），但它**不是**他们声称的「不能省」，且他们的测试无法验证它。这点我要指出，免得将来有人以为有测试保护。

`E8` 之外的 22 条没发现假通过（E10/E11/E12/E13/E14 我都独立复现过）。

### 界面缺口（4 个字段从不显示）

`needsRestart`、`backupOfPrevious`、`symlinkAsCopy`、`relinked`、`configReloadError` 五个字段在 `RestoreResult` 里定义完整、主进程也都填了，但 **`BackupPane.tsx` 只在类型声明里出现它们，界面上零渲染**。

后果具体到用户：
- 覆盖前的备份路径看不到 → 想退回时找不到；
- 哪些技能降级成了副本看不到 → 以为还跟外部仓库联动；
- `configReloadError`（配置重读失败）看不到 → 界面说「还原完成」，实际配置是旧的。

`B10b 目标不存在要报告` 在 wiring 检查里是 PASS，但「报告」只到 IPC 返回值，没到用户眼睛。

### i18n 完整（这条通过）

自建夹具 `qa-mine-i18n.cjs`（**先修了我自己的假绿**：初始版因 CRLF 导致 `backup: {` 一行都匹配不到，却输出「所有语言段都齐全」；加反向自检后才发现）：

```
BackupPane 用到 40 个 cf.backup.* key
找到 2 个 backup 段: forkZhCN@173, forkEn@515
PASS forkZhCN 齐全 40/40
PASS forkEn 齐全 40/40
PASS 反向自检：不存在的 key 会被判定为缺
```

应用只支持 zh-CN / en 两种（`i18n/messages.ts:3316` 只有 `'zh-CN'`），两种都齐全。

---

## 回归（我复核的）

| 项 | 结果 | 原文 |
|---|---|---|
| `check-bundle-wiring.cjs` | **ALL PASS** | `==RESULT== ALL PASS` |
| `verify-bundle-real.cjs` | **24 PASS / 0 FAIL** | `==RESULT== 24 PASS / 0 FAIL`（注意 E8 判据问题） |
| tsc node | **0** | `TSC_NODE=0` |
| tsc web | **0** | `TSC_WEB=0` |
| build | **0** | `BUILD_EXIT=0`，`✓ built in 7.54s` |

---

## 逐条验收结论汇总

| 验收项 | 结论 | 依据 |
|---|---|---|
| **1. 导出成单文件** | **通过** | 实测 18 文件/600MB 均成功；派生物正确排除；真流式 |
| **2. 彻底卸载（含凭证）** | **通过（静态）** | 读 `.nsh`：删 `secrets.json` + `%APPDATA%\devaplus`（含 `Local State`）。未实测（红线） |
| **3. 重装后能还原** | **通过** | 实测 E7a-7d、E10-E15、P8；zip slip/哈希/临时清理都对 |
| **4. 还原后完全一致** | **不通过** | 会话/附件/角色(自定义)/记忆/服务商/主题/语言/junction 都通过；**API 密钥被旧密文污染**、**内置角色残留**；**窗口大小该项不成立** |
| 4-a 会话 | **通过** | `O6 旧会话回来了` |
| 4-b 附件 | **通过** | `E4 媒体二进制完全一致` |
| 4-c 角色 | **部分不通过** | 自定义回来了（O7）；内置残留（O8 deva.md/lucy.md=true） |
| 4-d 记忆 | **通过** | `O10 旧记忆回来了` |
| 4-e 技能 junction | **通过** | L5/L6/L8 + 反向注入 3 条红 |
| 4-f 服务商配置 | **通过** | `O4 旧 provider 在` |
| 4-g **API 密钥** | **不通过** | Q9 FAIL：无口令时旧密文覆盖新密钥 |
| 4-h 主题/语言 | **通过** | C1/C2 |
| 4-i **窗口大小** | **不成立** | 应用从未持久化窗口尺寸（`index.ts:153-154` 写死 1280×820） |
| 问题3 错口令是否解压后才报 | **界面通过 / 接口不通过** | P9 提前判对；但 P5/P6 显示直接调 `restoreBundle` 时目标已被覆盖 |
| 问题4 覆盖提示与退路 | **提示有、退路不可见** | E10 拒绝零写入；`backupOfPrevious` 界面零渲染 |
| 问题5 重启 | **提示是硬编码，字段恒 true** | `bundle-import.ts:286` + `fork.ts:196` |
| 大包内存 | **P1 风险** | 600MB 峰值 RSS 1872MB（3.12×） |
| i18n | **通过** | forkZhCN/forkEn 各 40/40 |
| 卸载后凭证真的没了 | **是** | 设计前提成立，口令封装非多余 |

---

## 能不能交付

**不能。** 卡在三处，按优先级：

### 必须先修（阻塞）

**1. `secrets.json` 没被排除出包（P0-1）**
`bundle-manifest.ts:37` 的 `EXCLUDED_EXACT` 加 `'secrets.json'`。密钥只能走 `secrets.enc` 这一条路，不带口令时就是「没有密钥」（`absent: true`），而不是「把旧密文带过去」。
修完要验：无口令导出 → 包里无 `home/secrets.json`；还原后目标原有 `secrets.json` 不被改动。

**2. 「整文件替换」名不副实（P0-2）**
两个选择，选一个并统一文档与实现：
- **改实现**：替换前把目标里「包里没有的」旧条目删掉（注意保留 `_index.json` 等派生文件、保留 worktree 代码）；
- **改文案**：把注释与界面说清「还原 = 覆盖同名文件，不删除多出来的」，并让 `hasAnyUserData` 的「非空确认」文案明确这一点。

用户那句「跟我没卸载之前一样」要求的是前者。

**3. 错口令在接口层不设防（问题 3）**
把密钥解密提到替换之前，或至少在 `backup:restore` 里先 `verifyPassphrase`。现在只有界面拦，通道本身不拦且已破坏数据。

### 建议一并修（不阻塞，但会被用户感知）

**4. 界面把 5 个字段显示出来**：`backupOfPrevious`（退路在哪）、`symlinkAsCopy`（哪些技能脱钩了）、`configReloadError`（配置没重读成功）。这三个是用户真要用的。

**5. `needsRestart` 恒 true**：要么让它反映真实情况（`cfg.ok` 为真且无其它内存态未重载时不提示），要么从协议里删掉、只留文案。

**6. 大包内存（P1）**：600MB → 1.87GB 峰值。低配机器有 OOM 风险。

### 文档/需求要改

**7. 「窗口大小会回来」从验收清单里去掉**——这个应用从来没存过窗口大小。

### 顺带提醒

他们的 `verify-bundle-real.cjs` 的 E8a/E8b 判据无法发现 `utimes` 被删（我实测删掉后 24 条仍全绿）。修 P0 时如果改动替换逻辑，别指望这两条能保护 mtime 行为。

---

## 现场

- `E:\deva-bundle`：`git status` 只有 11 个我新增的 `.deva/qa/qa-mine-*.cjs` 夹具，**产品代码零改动**（所有反向注入均已用备份还原，逐个确认 `git diff` 为 0）
- 未碰真实 `~/.deva-plus`、未执行卸载、所有夹具 `DEVA_HOME` 都在 `os.tmpdir()` 下并已 `rmSync` 清理
- 夹具可复跑（均在 `E:\deva-bundle\.deva\qa\`）：
  - `qa-mine-ciphertext.cjs` —— P0-1 密钥密文入包（最关键）
  - `qa-mine-overwrite.cjs` —— P0-2 残留不删
  - `qa-mine-badpass.cjs` —— 错口令破坏范围
  - `qa-mine-large.cjs [MB]` —— 大包内存
  - `qa-mine-links.cjs` —— junction 重建与降级
  - `qa-mine-mtime.cjs` —— mtime（含对 E8 判据的反证）
  - `qa-mine-nopass.cjs` / `qa-mine-nosecrets.cjs` / `qa-mine-noenc.cjs` —— 无口令/无密钥/无加密能力三条路径
  - `qa-mine-i18n.cjs` —— 词条完整性（含反向自检）
