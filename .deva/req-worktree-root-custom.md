# 待做需求：worktree 根目录允许用户自定义

状态：**已记录，未排期**（用户 2026-11 口头提出，明确"到时候再说"）。

## 用户原话要点

- 看到 Codex 会把 worktree 放在它自己的目录下，觉得"最好允许用户修改"根目录位置。

## 现状（已核对）

- 应用创建的 worktree 位置由 `apps/desktop/src/main/services/worktree/precheck.ts:116-120`
  的 `defaultWorktreePath()` 决定：`<DEVA_HOME>/worktrees/<repoKey>/<slug>-<shortid>/`。
- `<DEVA_HOME>` 来自 `getDevaHome()`（`main/services/config.ts:27-31`），默认 `~/.deva-plus`，
  可用环境变量 `DEVA_HOME` 整体覆盖。
- `precheck.ts:210` 已经是 `req.path || defaultWorktreePath(...)` —— **用户显式传路径的能力已存在**，
  缺的是界面入口 + 偏好持久化 + 默认值来源。
- 仓库外是硬约束：`precheck.ts:214` 用 `isInsideRepo()`，命中报 `path-inside-repo`
  （原因见 `.deva/spec-worktree-parallel.md:1152`：`.deva/` 被 gitignore 后，
  放在仓库内会让"不在仓库内"的断言恒真）。

## 做的时候要注意

- 自定义根目录不能绕过"仓库外"校验和 `MAX_PATH_LEN`（180）检查。
- 偏好要能恢复默认；`repoKey` 分桶结构应保留，避免不同仓库的 worktree 混在一层。
- 改动会影响 `worktrees.json` 里已有记录的路径解析，需考虑存量记录仍按原绝对路径工作。
- 与"成员独立 worktree"是两个不同需求，不要混在一个提交里。

## 不做

- 本轮（导入修复 / 成员 worktree 收口）不实现。