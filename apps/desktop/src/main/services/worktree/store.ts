import { readFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from '../config'
import { writeFileAtomic } from '../atomic-write'
import { compareKeyOfPath, normalizeWorktreePath } from './paths'

/**
 * `worktrees.json` 的读写。
 *
 * ## 为什么是独立文件，不是 config.json 的一个键（spec §1.2）
 *
 * config 是用户可手改、会被导入流程合并、`config:set` 走**顶层浅合并**。worktree 记录是机器状态、
 * 有生命周期、以路径作主键——放进 config 一定会被合并语义误伤（例如渲染层回写 models 时整段覆盖，
 * 把 `worktrees` 键一起带走）。所以由主进程独占一个文件，写盘走 `writeFileAtomic`。
 *
 * ## 主键是 `compareKey` 而不是 `path`
 *
 * 同一个工作区可能有多种写法（大小写、尾斜杠、段尾空格），`path` 保留用户输入的形态用于展示与
 * 传给 git，`compareKey` 用于一切比较。详见 `paths.ts` 的归一化规则。
 */

/** `deps` 五态（spec §2.2）。 */
export type DepsState = 'pending' | 'installing' | 'ready' | 'failed' | 'skipped'

/** 一条 worktree 记录（spec §1.2）。 */
export interface WorktreeRecord {
  schemaVersion: 1
  /** 绝对路径，已过 normalizeWorktreePath，保留大小写。展示、会话 focusRoot、git argv 用。 */
  path: string
  /** 归一化比较键。**记录主键**、锁 key、关联会话反查用。 */
  compareKey: string
  repoRoot: string
  repoKey: string
  /** 独占的本地分支全名（不含 refs/heads/）。创建后永不改。 */
  branch: string
  /** 40 位 SHA，创建时冻结，永不改。 */
  baseSha: string
  /** 显示用（`my/dev` / `origin/feat/x` / `HEAD (detached @ abc1234)`）。 */
  baseLabel: string
  /** 创建时主目录的分支；主目录 detached 时为 null。**永不跟随**。 */
  targetBranch: string | null
  createdAt: number
  /** creating = 创建中（崩溃恢复用）；active = 可用。 */
  phase: 'creating' | 'active'
  /**
   * Step 0 的探测结果，**失败清理的唯一准入凭据**。
   *
   * 为什么不直接假设 false：Step 0 保证拒绝已存在的情形，但崩溃恢复时 Step 0 早已不在内存里，
   * 清理算法不能依赖「Step 0 跑过了」这个隐含前提（spec §3.2）。
   */
  intent: { branchExistedAtStart: boolean; pathExistedAtStart: boolean }
  deps: DepsState
  depsDetail?: string
  depsUpdatedAt?: number
  /**
   * 「创建这条记录时，worktree 根是什么」——归一化后的 compareKey（需求 §6.3）。
   *
   * ## 为什么是可选字段，而不是升级 `schemaVersion`
   *
   * 文件级 `SCHEMA = 1` 在 `ensureLoaded()` 里做**强校验**：不匹配就整份判 `corrupt`，
   * 于是所有写操作 fail closed、用户所有 worktree 记录变成不可写。升级它等于为了一个偏好
   * 废掉全部历史记录。
   *
   * 所以这里新增**独立可选字段**：老记录没有它（`undefined`），`ensureLoaded()` 的必填校验
   * （见下方 `invalidRecord` 那段）**不得**把它列进去，否则老记录被判 invalid → 同样全盘 corrupt。
   *
   * ## 三种取值
   *
   *  - `undefined`：老记录（此字段引入前创建的）→ **跳过根校验**（需求 取舍二）。
   *    理由：删除是收尾动作，不该拦。用户清理存量目录时被「你没在根内建的所以我不能删」挡住，
   *    后果是又留下一个删不掉的目录 —— 正是本需求要解决的问题。
   *  - 字符串：创建时的根 compareKey → 创建与删除都严格校验。
   *  - 空串：不该出现；出现时按「有值但不匹配」处理（不放行），避免坏数据静默拿到豁免。
   *
   * ## 为什么存 compareKey 而不是原始串
   *
   * 原始串的大小写 / 尾斜杠 / `\\?\` 差异会让「同一个根」被判成两个，从而把根内误判成根外。
   */
  createdUnderRoot?: string
}

const FILE = 'worktrees.json'
const SCHEMA = 1

/** 内存态缓存：`compareKey` → 记录。`scope.ts` 要求同步查表，所以记录必须在内存里。 */
let cache: Map<string, WorktreeRecord> | null = null

function filePath(): string {
  return join(getDevaHome(), FILE)
}

/**
 * 载入。
 *
 * **读失败与「没有记录」必须分开**：文件不存在 = 真的还没有任何 worktree（空表正确）；
 * 文件在但解析不了 = **不知道有哪些记录**。后者绝不能当成空表——那样下一次 `upsertRecord` 写盘
 * 会把旧记录全部覆盖掉（本仓最危险的「读失败被读成不存在」）。
 *
 * 所以这里把「载入失败」记下来，`upsertRecord` 遇到它时**拒绝写盘**并返回 false，
 * 而不是拿一个空表覆盖掉一份可能还能救的文件。
 */
let loadState: 'ok' | 'absent' | 'corrupt' = 'ok'

function ensureLoaded(): Map<string, WorktreeRecord> {
  if (cache) return cache
  const map = new Map<string, WorktreeRecord>()
  try {
    const raw = readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; records?: unknown }
    const list = Array.isArray(parsed?.records) ? (parsed.records as WorktreeRecord[]) : []
    for (const rec of list) {
      // 逐条校验：坏记录跳过而不是整份报废（一份文件里有一条坏，不该让其余全部消失）
      if (!rec || typeof rec !== 'object') continue
      if (typeof rec.path !== 'string' || typeof rec.compareKey !== 'string') continue
      if (typeof rec.branch !== 'string' || typeof rec.baseSha !== 'string') continue
      if (rec.phase !== 'creating' && rec.phase !== 'active') continue
      map.set(rec.compareKey, rec)
    }
    loadState = 'ok'
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      loadState = 'absent'
    } else {
      /*
       * 内容坏 / 读不出来：保留 `loadState = 'corrupt'`，让任何写操作都 fail closed。
       * 此时 cache 仍是空 Map（调用方读列表得到空），但**写**会被拒绝——见 upsertRecord。
       */
      loadState = 'corrupt'
      console.warn('[worktree] worktrees.json 读取/解析失败，写入将被拒绝：', (e as Error)?.message ?? e)
    }
  }
  cache = map
  return cache
}

/** 落盘。返回是否成功（写盘失败不得静默，见 §1.2）。 */
function persist(map: Map<string, WorktreeRecord>): boolean {
  try {
    const body = { schemaVersion: SCHEMA, records: [...map.values()] }
    writeFileAtomic(filePath(), JSON.stringify(body, null, 2))
    return true
  } catch (e) {
    console.warn('[worktree] worktrees.json 落盘失败：', (e as Error)?.message ?? e)
    return false
  }
}

/** 全部记录（按 createdAt 升序，创建早的在前）。只读，返回副本数组。 */
export function listRecords(): WorktreeRecord[] {
  return [...ensureLoaded().values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** 按路径取记录（内部先归一化，用 compareKey 查）。 */
export function getRecord(path: string): WorktreeRecord | null {
  if (typeof path !== 'string' || !path) return null
  try {
    return ensureLoaded().get(compareKeyOfPath(path)) ?? null
  } catch {
    // 归一化失败（畸形路径）：当作没有这条记录，不抛给调用方
    return null
  }
}

/** 按 compareKey 取（调用方已经有键时免得再归一化一次）。 */
export function getRecordByKey(compareKey: string): WorktreeRecord | null {
  return ensureLoaded().get(compareKey) ?? null
}

/**
 * 写入或更新一条记录。**返回落盘是否成功。**
 *
 * 调用方必须检查：创建流程里 `false` 要走清理（否则内存有记录、磁盘没有，重启后 worktree 变孤儿登记）。
 *
 * 载入状态为 `corrupt` 时**拒绝写入并返回 false**：此时我们不知道磁盘上有哪些记录，
 * 写入等于用内存里的（可能只有一个）新记录覆盖掉一份还能修的文件。
 */
export function upsertRecord(rec: WorktreeRecord): boolean {
  const map = ensureLoaded()
  if (loadState === 'corrupt') {
    console.warn('[worktree] worktrees.json 载入失败过，拒绝写入以免覆盖既有记录')
    return false
  }
  // 归一化一遍再存：调用方传进来的 path 可能没归一化过，compareKey 必须与 path 一致
  const norm = normalizeWorktreePath(rec.path)
  const fixed: WorktreeRecord = { ...rec, path: norm.path, compareKey: norm.compareKey }
  map.set(fixed.compareKey, fixed)
  return persist(map)
}

/** 删除一条记录。返回落盘是否成功。 */
export function removeRecord(path: string): boolean {
  const map = ensureLoaded()
  if (loadState === 'corrupt') return false
  let key: string
  try {
    key = compareKeyOfPath(path)
  } catch {
    return false
  }
  if (!map.has(key)) return true // 本来就没有：幂等，不算失败
  map.delete(key)
  return persist(map)
}

/** 某个仓库（主目录）下的全部记录。 */
export function findRecordByRepo(repoRoot: string): WorktreeRecord[] {
  if (typeof repoRoot !== 'string' || !repoRoot) return []
  let key: string
  try {
    key = compareKeyOfPath(repoRoot)
  } catch {
    return []
  }
  return [...ensureLoaded().values()].filter((r) => {
    try {
      return compareKeyOfPath(r.repoRoot) === key
    } catch {
      return false
    }
  })
}

/**
 * 仅供测试：清掉内存缓存，让下一次调用重新读盘。
 *
 * 生产代码不需要（记录在进程生命周期内是稳定的），但测试要在同一进程里模拟「重启后重读」。
 */
export function reloadRecordsForTest(): void {
  cache = null
  loadState = 'ok'
}

/** 载入状态（排查用：`corrupt` 说明文件坏过、写入被拒绝）。 */
export function getStoreLoadState(): 'ok' | 'absent' | 'corrupt' {
  ensureLoaded()
  return loadState
}