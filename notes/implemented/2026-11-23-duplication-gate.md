# 查重检查：`exitCode` 会让「只拦新增」完全失效

> 状态：已落地（`.jscpd.json` + `.jscpd-baseline.json` + `.deva/qa/check-duplication.cjs`）
> 日期：2026-11-23

## 问题

仓库有 41 处存量重复（832 行，0.86%）。直接开 jscpd 会一上线全红，
所有人的第一反应是关掉它 —— 这等于白装。

想解决就得只拦**新增**的重复，jscpd 5.4.3 提供 `--fail-on-new-clones` + baseline。

## 两个实测出来的坑

### 坑 1：`.jscpd.json` 里的 `exitCode: 1` 让 `--fail-on-new-clones` 彻底失效

dsh（`E:\deepseek-harness`）的 `.jscpd.json` 里写了 `exitCode: 1`，我照抄了。

后果：**存量那 41 处也照样判 exit 1**。`--fail-on-new-clones` 明明是「没有新克隆就返回 0」，
但 `exitCode` 配置项覆盖了退出码，两者互相打架，实际表现是「永远红」。

**这就是「一上线全红、所有人关掉」的直接原因**，而配置里看不出任何异常。

→ `.jscpd.json` 里**必须没有 `exitCode` 字段**。这条没有写进 jscpd 文档，是我先得出假结论、再实测证伪的。

### 坑 2：`--baseline-from-ref origin/main` 会误报

看起来更省事：不落 baseline 文件，直接从 `origin/main` 取基线。

实测**误报 2 处**。原因：`main` 是发版线，落后 `dev` 很多（见 `docs/development-branches.md`），
基线取自一个**内容更旧**的树，于是 `dev` 上早已存在的重复被当成「新增」。

→ 基线必须落成文件（`.jscpd-baseline.json`，41 个指纹哈希、1150 字节、**不含代码**），
由 `pnpm check:dup:update` 显式更新。

## 现在的机制

| 文件 / 命令 | 作用 |
| --- | --- |
| `.jscpd.json` | `minTokens: 60`、`minLines: 6`，**无 `exitCode`** |
| `.jscpd-baseline.json` | 41 个指纹哈希，只存指纹不存代码 |
| `.deva/qa/check-duplication.cjs` | 包装 jscpd，解析 `--fail-on-new-clones` 输出 |
| `pnpm check:dup` | 跑检查（CI 用这个） |
| `pnpm check:dup:update` | 确认新重复可接受后更新基线 |

已接进 `.github/workflows/ci.yml`，位置在「文档链接」之后。

## 正向 / 反向验证

正向：`Found 41 exact clones with 832(0.86%) duplicated lines in 306 files`，EXIT=0。

反向：把 `throttle()` 整个函数（221 tokens）复制到 `git.ts` →
- 42 clones
- `found 1 new clones`
- EXIT=1
- 报告点名 `main\backup-ipc.ts 23-67` 与 `main\services\git.ts 1047-1091`

**探针坑**：复制片段太短（不足 60 token 或构不成完整 token 序列）时 jscpd 根本检不出，
会被误读成「baseline 放过了第三份」。必须整函数 / 整块复制。
`/* jscpd:ignore-start */ … /* jscpd:ignore-end */` 实测确实能放行。

## 存量 41 处怎么办

只值得清一类：`preload/index.ts` 与 main services 的重复
（`shared/tasks-types.ts:23` ↔ `preload/index.ts:473`，98 行）。
provider 三家之间的相似不建议动 —— 它们是**刻意的平行实现**，合并成抽象层反而更难读。

## 何时重看这份记录

- 改 `.jscpd.json` 或 `.jscpd-baseline.json` 时
- 有人想把 `exitCode` 加回来时（**不要**）
- 有人想用 `--baseline-from-ref` 省掉 baseline 文件时（**不要**）
- 查重报了「新克隆」但看着不像新增时
