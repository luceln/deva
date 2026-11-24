import { createHash } from 'crypto'
import { isAbsolute, join, relative, resolve } from 'path'
import { realResolve } from '../fs-guard'
import { getConfig, getDevaHome } from '../config'

/**
 * worktree 的路径工具：归一化、比较键、repoKey、slug。
 *
 * 为什么单独一个文件：这些规则会被 store（主键）、create（判重）、list（反查）三处共用，
 * 每处各写一遍必然漂移——而漂移的后果是**静默**的：同一个工作区出现两条记录、两把锁、
 * 关联会话数各算一半（spec §6.2.1 的「未归一化的后果」表）。
 */

/** 归一化结果：`path` 用于展示与传给 git，`compareKey` 用于一切比较与作主键。 */
export interface NormalizedPath {
  /** 保留大小写与真实形态（符号链接解析成真身）：展示、记进会话 focusRoot、作 argv。 */
  path: string
  /** 归一化比较键：记录主键、锁 key、关联会话反查、去重。 */
  compareKey: string
}

/**
 * 展开开头的 `~`。
 *
 * 为什么不直接用 `os.homedir()` 拼：调用方（用户输入）可能写 `~/wt` 或 `~\wt`，
 * 而 `resolve()` 不认识 `~`，会把它当成当前目录下的字面量目录名——那就是一个完全不同的路径。
 */
function expandHome(p: string): string {
  if (p === '~') return process.env.USERPROFILE || process.env.HOME || p
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    return home ? home + p.slice(1) : p
  }
  return p
}

/**
 * 完整归一化规则（spec §6.2.1 R1-R6）。**逐条保留**，少一条都会让某个形态判不出重复。
 *
 * 输入是第 2 步的 realPath，它可能是「已存在的路径的 realpath」，也可能是
 * 「最近存在祖先的 realpath + 尚不存在的尾段原始串」。
 */
function compareKeyOf(realPath: string): string {
  // R1 分隔符统一为 /（斜杠形式不同即同一目录）
  let s = realPath.replace(/\\/g, '/')
  // R2 折叠冗余连续 /（Windows 上 `//` 是 UNC 前缀，但 UNC 已在 realpath 里规范化，这里只处理冗余段）
  s = s.replace(/\/{2,}/g, '/')
  // R3 去尾部全部 /
  s = s.replace(/\/+$/, '')
  /*
   * R6 盘符形式统一：去掉 Windows 的 `\\?\` 长路径前缀，并把盘符统一成 `c:/...`。
   * 这一步必须在 R5 小写化之前做，否则 `//?/C:` 里的 `?` 会被当成路径段。
   */
  if (s.startsWith('//?/')) s = s.slice(4)
  // R4 逐段剥离「段尾空格与段尾点」，直到稳定（`"a . ."` → `"a"`）；空段丢弃
  s = s
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => {
      let cur = seg
      // 反复剥直到稳定：`"fix . ."` 剥一次会剩 `"fix ."`，再剥才是 `"fix"`
      for (;;) {
        const next = cur.replace(/[ .]+$/, '')
        if (next === cur) break
        cur = next
      }
      return cur
    })
    .filter((seg) => seg !== '')
    .join('/')
  // 剥段尾后可能留下空串（整段都是空格/点）→ 已在上一步过滤
  /*
   * R5 盘符与大小写：win32 / darwin → 全小写；Linux 保留大小写。
   *
   * 实测支撑（spec §6.2.1）：Windows 上 `git worktree add -b b1 ../WT-Case` 成功，
   * 随后 `../wt-case` 报 already exists——git 侧与文件系统侧都大小写不敏感，
   * 而 `readdirSync` 只回 `"WT-Case"`。所以比较键必须小写，否则判不出重复。
   */
  if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase()
  // 盘符后必须有斜杠：`c:` → `c:/`（`resolve()` 对 `C:\a` 给出 `C:\a`，剥完是 `C:/a`，这里兜住裸盘符）
  if (/^[a-z]:$/.test(s)) s += '/'
  return s
}

/**
 * 归一化路径。**`path` 与 `compareKey` 是两个概念，不得只用其中一个**（spec §6.2）。
 *
 * 第 2 步用 `fs-guard.realResolve`：它对已存在路径直接 realpath，对不存在的路径
 * 「沿祖先逐级 realpath 后把尾段接回」。复用而不是重写——那里已经处理了 4096 层防御与触底回退。
 */
export function normalizeWorktreePath(p: string): NormalizedPath {
  const abs = resolve(expandHome(p))
  const real = realResolve(abs)
  return { path: real, compareKey: compareKeyOf(real) }
}

/** 只取比较键（判重、反查用）。 */
export function compareKeyOfPath(p: string): string {
  return normalizeWorktreePath(p).compareKey
}

/**
 * 磁盘分桶键：`sha1(lower(repoRoot) 归一后).slice(0,16)`。
 *
 * **不复用 `chat-store.ts` 的 `projectKey`**（spec §6.1 明确禁止）：那个的语义是「权限系统按目录
 * 区分权限模式」，与本功能无关。同算法、另起函数——共享一个标识将来改任一个都会误伤另一个。
 */
export function repoKeyOf(repoRoot: string): string {
  const norm = compareKeyOf(repoRoot)
  return createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

/**
 * 分支名 → 目录 slug（spec §6.3，严格按序）。
 *
 * 为什么必须扁平化（`feat/x` → `feat-x`）：目录名里的 `/` 会造成额外层级，破坏
 * `<repoKey>/<slug>-<shortid>` 的两层结构，也让「worktree 根下一层」的判断失效。
 * 分支名本身保留用户原样——只有目录 slug 被扁平化。
 */
export function slugifyBranch(name: string): string {
  let s = name
    // 1. Unicode 规范化：避免视觉相同、码点不同的名字生成不同 slug
    .normalize('NFC')
    // 2. 小写：Windows/macOS 路径大小写不敏感，只差大小写的两个 slug 会撞同一目录
    .toLowerCase()
    // 3. 非 [a-z0-9._-] 的连续片段 → '-'（含中文、空格、`~^:?*[\`、`@{` 等）
    .replace(/[^a-z0-9._-]+/g, '-')
    // 4. 连续 '-' 折叠；去首尾 '-' 与 '.'（git 分支名不得以 '.' 结尾、不得以 '-' 开头）
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    // 5. '..' → '.'；去掉 '\'（兜底 git 的其余 ref 规则）
    .replace(/\.{2,}/g, '.')
    .replace(/\\/g, '')
  // 6. 空（例如纯中文）→ 'worktree'
  if (!s) s = 'worktree'
  // 7. 截断到 40 个字符，再重新执行第 4 步（截断可能留下尾部 '-'）
  if (s.length > 40) s = s.slice(0, 40).replace(/[-.]+$/, '')
  if (!s) s = 'worktree'
  return s
}

/** 路径长度上限（spec §6.2.2：Windows MAX_PATH 前的安全余量）。 */
export const MAX_PATH_LEN = 180

/**
 * 路径是否在仓库内（spec §6.1 的机械校验）。
 *
 * **不得只靠「DEVA_HOME 默认在仓库外」这个约定**：那是个默认值，用户可以用 `DEVA_HOME`
 * 把它挪进仓库。一旦工作区落在仓库内，`.gitignore` 已忽略 `.deva/`，B5 的
 * `git status` 断言会**恒真**、验不出任何东西。
 */
export function isInsideRepo(repoRoot: string, worktreePath: string): boolean {
  const rel = relative(normalizeWorktreePath(repoRoot).path, normalizeWorktreePath(worktreePath).path)
  // rel 为空 = 就是仓库根本身；以 .. 开头或绝对路径 = 在外
  if (!rel) return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 只取末级目录名（显示用，不做归一化）。 */
export function baseNameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** 路径拼接（避免各处手写 `+ sep +`）。 */
export function joinPath(...parts: string[]): string {
  return join(...parts)
}

/* ───────────── worktree 根（`<root>/<repoKey>/<slug>-<shortid>`） ───────────── */

/**
 * `config.json` 里存放根的键。
 *
 * 为什么是 `config.json` 顶层而不是 `worktrees.json`（需求 §6.1）：后者是**机器状态**
 * （以路径 compareKey 为主键的记录表，文件级 `schemaVersion` 强校验），混进用户偏好会让
 * 「改一个偏好」与「改机器状态」互相牵连；而偏好要能跟 config 一起被备份 / 手改 / 版本化。
 */
export const WORKTREE_ROOT_KEY = 'worktreeRoot'

/**
 * 默认根：`<DEVA_HOME>/worktrees`。
 *
 * **只在这一处拼**（需求 §7.4 的硬要求）。别处再拼一次，改根时必然漏掉某一处，
 * 而后果是静默的：那个入口继续往旧位置建目录，用户以为根已经统一了。
 *
 * A8 用一条 grep 守着这条：在 `apps/desktop/src` 下搜「把 DEVA_HOME 与 worktrees 拼在一起」
 * 的那段源码，命中数必须恒为 1。**这也是本注释不写出那串字面量的原因** ——
 * 写出来会让 grep 命中注释，判据自己把自己弄成假红。
 */
export function defaultWorktreeRoot(): string {
  return join(getDevaHome(), 'worktrees')
}

/**
 * 当前生效的根。
 *
 * 缺键 / 空串 / 非字符串 → 默认根（需求 §6.2：**默认值不写进文件**）。
 * 这样 `DEVA_HOME` 迁移时默认根自动跟着走，而「恢复默认」就是删键。
 *
 * 返回值已归一化（`normalizeWorktreePath().path`）——展示、传给 git、拼子路径都用它。
 * 归一化在 `realResolve` 上做过「最近存在祖先的 realpath + 尚不存在的尾段」，
 * 所以根目录此刻还不存在也能得到正确形态。
 */
export function worktreeRoot(): string {
  const raw = getConfig()[WORKTREE_ROOT_KEY]
  const picked = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : defaultWorktreeRoot()
  return normalizeWorktreePath(picked).path
}

/**
 * 当前生效的根 + 默认根，**同一次调用算出**。
 *
 * 为什么不写成 `worktreeRoot()` 再单独调一次 `defaultWorktreeRoot()`：
 * 如果两次调用之间 `DEVA_HOME` 或配置变了（迁移、外部改配置），界面就会显示
 * 「当前 X、默认 Y」而 X 其实是按旧默认算出来的 —— 这种不一致只在竞态下出现，极难复现。
 * 这里一次读完 `raw`，默认值和生效值都由同一个 `raw` 推出，两者必然自洽。
 *
 * 与 `worktreeRoot()` 完全同判据：缺键 / 空串 / 非字符串 → 默认根（需求 §6.2）。
 */
export function worktreeRootView(): { root: string; defaultRoot: string; isDefault: boolean } {
  const raw = getConfig()[WORKTREE_ROOT_KEY]
  const isDefault = !(typeof raw === 'string' && raw.trim() !== '')
  const defaultRoot = normalizeWorktreePath(defaultWorktreeRoot()).path
  const root = isDefault ? defaultRoot : normalizeWorktreePath(String(raw).trim()).path
  return { root, defaultRoot, isDefault }
}

/**
 * `p` 是否在根内（含根自身）。**不得用 `startsWith`** —— 需求 §7.2 的四种形态：
 *
 * | 形态 | `startsWith` 的错 | compareKey 为什么对 |
 * |---|---|---|
 * | 大小写不同 `E:\WT` / `e:\wt` | 误判根外 | Windows/macOS 全小写化（R5） |
 * | `\\?\E:\wt\…` 长路径前缀 | 误判根外 | 剥 `//?/`（R6） |
 * | 尾斜杠 / 冗余斜杠 | 误判根外 | 折叠 `/`、去尾 `/`（R2/R3） |
 * | `E:\wt2` vs 根 `E:\wt` | **误判根内**（前缀相同） | 逐段比较，`wt2` ≠ `wt` |
 *
 * 最后一行是安全问题：`startsWith` 会把 `E:\wt2` 当成 `E:\wt` 的子目录，于是「根外创建」被放行。
 * 所以判定与 `isInsideRepo` 同构：归一化后逐段 `relative()`，看是否以 `..` 起头。
 *
 * **不数层数**（需求 Q1 定案：任意深度）。
 */
export function isInsideRoot(root: string, p: string): boolean {
  const rel = relative(normalizeWorktreePath(root).path, normalizeWorktreePath(p).path)
  if (!rel) return true // 就是根本身
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 两个 **compareKey** 之间的「在根内」判定（含根自身，任意深度）。
 *
 * 为什么不复用 `isInsideRoot`：那个函数会对入参再跑一次 `normalizeWorktreePath`，
 * 而 compareKey 是归一化的**产物**——在 Linux 上 `/tmp/a` 的 compareKey 是 `tmp/a`
 * （前导 `/` 已去掉），再拿去 `resolve()` 会被当成相对路径解析成 `<cwd>/tmp/a`，
 * 两侧基准不同就会把「同一个根」判成根外。
 *
 * 记录里的 `createdUnderRoot` 和 `compareKey` 都已经是这个形态，用它们比较必须走这里。
 */
export function isKeyInsideRoot(rootKey: string, pKey: string): boolean {
  if (pKey === rootKey) return true // 就是根本身
  // 根后必须紧跟 `/`：`tmp/wt2` 不得被 `tmp/wt` 当成子项（与 isInsideRoot 的逐段语义一致）
  return pKey.startsWith(`${rootKey}/`)
}

/**
 * 记录侧「创建时根」的比较键。
 *
 * 为什么返回 compareKey 而不是原始串（需求 §6.3）：原始串的大小写 / 尾斜杠 / `\\?\` 差异会让
 * 「同一个根」被判成两个，从而把根内误判成根外、或者反过来。
 */
export function rootKeyOf(root: string): string {
  return compareKeyOfPath(root)
}
