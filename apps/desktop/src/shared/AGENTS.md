# shared/AGENTS.md

主进程、preload、渲染层、`mobile/` 四方共用的类型与纯逻辑。实测消费方：`main` 69 处、
`renderer` 30 处、`mobile` 19 处、`preload` 4 处（`mobile/` 在 `apps/desktop/src/mobile/`）。
父级约定见仓库根 `AGENTS.md`。

## 这个目录的边界

只放**能同时被四个运行环境 import** 的东西：类型定义、协议常量、纯函数。
不 import `electron`、不 import `fs` / `node:*`、不碰 `window` / `document`——一碰就有一方跑不起来。
需要环境相关能力的，把类型放这里、实现留在各自那侧。

## 这个目录特有的坑

**改动这里的类型等于同时改四方。** `chat-protocol.ts`（679 行）是对话协议的唯一来源，
`worktree-protocol.ts`（527 行）同理。改字段前先 grep 全部消费方；`mobile/` 容易被漏掉——
它在 `apps/desktop/src/mobile/`（32 个文件，消费 shared 19 处），与 `main/` `preload/`
`renderer/` 平级，按「改桌面端」的思路搜会漏。

**协议字段加可选（`?`）就是放宽了契约，消费方会假设它必有。** 这是二开反复踩的形态：
类型上 `failed?: Failure[]`，界面却按必有写死长度。新增可选字段时，同一次改完里把消费方的
缺省分支补上；宁可设成必有 + 显式给默认值。

**不要把主进程内部类型搬进来。** 只有真的跨环境共用才放这里。判断标准：`grep` 一下，
只有一个环境用就留在那个环境。搬进来的代价是以后每次改都要考虑四方兼容。
