import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getRecord, upsertRecord, type DepsState, type WorktreeRecord } from './store'
import { publishWorktreeChanged, publishWorktreeProgress } from '../chat-bus'

/**
 * 依赖安装（spec §3.6 Step 4）：**异步、可降级、失败不回滚 worktree**。
 *
 * ## 为什么失败不回滚（A27）
 *
 * 依赖装不上，用户手里仍然有一个能用的工作区：目录在、分支在、代码完整，`pnpm install` 自己重跑就行。
 * 把整个 worktree 删掉才是灾难——用户可能已经在那里改了几个文件。
 * 所以这里的失败只把 `deps` 标成 `failed` 并写 `depsDetail`，其余一概不动。
 *
 * ## 为什么异步
 *
 * `pnpm install` 在冷缓存下能跑几分钟。同步等它，界面就一直停在「创建中」，用户以为卡死了。
 * 所以 Step 4 一启动就返回，`deps` 走状态机，进度发 `worktree:progress`。
 *
 * ## 为什么 `installing` 期间禁止删除该 worktree（R8）
 *
 * pnpm 在 Windows 上会持有大量文件句柄，此时删目录会 `EPERM` / `ENOTEMPTY`，还会留下删不干净的目录。
 * 这条守卫在 `remove.ts`（T3.1）实现；这里只负责让 `deps === 'installing'` 这个状态**可查**。
 */

/** 进度事件（走 `worktree:progress`，与锁的 `waiting-lock` 同一个通道）。 */
export interface DepsProgress {
  path: string
  /** 给界面显示的一行当前动作（命令名 / 「读取 lockfile」…）。 */
  step: string
  /** 命令已跑多久（毫秒）。界面据此显示「已用 1:23」。 */
  elapsedMs: number
}

/** 安装超时：5 分钟（spec §3.6）。 */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
/** `depsDetail` 只留最后 20 行（pnpm 报错能刷几十屏，全存下来没人看）。 */
const DETAIL_TAIL_LINES = 20

/** 检测结果：该跑什么命令。 */
export interface InstallPlan {
  /** 要执行的命令（argv[0] 是程序名）；null = 不执行。 */
  argv: string[] | null
  /** 不执行时的终态与原因。 */
  skipReason?: 'no-lockfile' | 'unsupported-language'
  /** 识别到的 lockfile 名（排查用）。 */
  lockfile?: string
}

/**
 * lockfile 检测（§3.6 的表，**按顺序先命中先生效**）。
 *
 * 顺序有意义：一个仓库里可能同时有 `pnpm-lock.yaml` 与 `package-lock.json`（历史遗留），
 * 按表的顺序取 pnpm——那是本仓自己的选择，别改成「取最新修改的」。
 */
export function detectInstallPlan(worktreePath: string): InstallPlan {
  const has = (name: string): boolean => existsSync(join(worktreePath, name))
  if (has('pnpm-lock.yaml'))
    return { argv: ['pnpm', 'install', '--frozen-lockfile'], lockfile: 'pnpm-lock.yaml' }
  if (has('package-lock.json')) return { argv: ['npm', 'ci'], lockfile: 'package-lock.json' }
  if (has('yarn.lock')) return { argv: ['yarn', 'install', '--immutable'], lockfile: 'yarn.lock' }
  // 非 JS 生态：明确标 unsupported-language，而不是含糊的 no-lockfile
  for (const f of ['Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts'])
    if (has(f)) return { argv: null, skipReason: 'unsupported-language' }
  return { argv: null, skipReason: 'no-lockfile' }
}

/**
 * `pending` 的落定：有 lockfile 且用户没勾跳过 → 进 `installing` 并启动安装；
 * 否则 → `skipped`（写 `depsDetail`）。
 *
 * 返回值表示「是否已开始安装」。调用方（create 的 Step 4）不需要等安装完成。
 */
export function startInstall(
  record: WorktreeRecord,
  opts: { skipDeps?: boolean } = {}
): { started: boolean; deps: DepsState; detail?: string } {
  // `req.skipDeps === true` 时一律 skipped，**不探测命令是否存在**（§3.6 的「必须有」）
  if (opts.skipDeps) return { started: false, ...finish(record, 'skipped', 'user-skipped') }

  const plan = detectInstallPlan(record.path)
  if (!plan.argv) return { started: false, ...finish(record, 'skipped', plan.skipReason ?? 'no-lockfile') }

  /*
   * 先落盘 `installing` 再启动子进程：反过来的话，安装极快结束时会出现
   * 「内存里还是 pending，磁盘上已是 ready」的中间态，重启清扫看到 pending 不知道该做什么。
   * 落盘失败就**不启动安装**（否则进程在跑而记录说 pending，重启后无从判断）。
   */
  if (!finish(record, 'installing').ok) return { started: false, deps: 'pending' as DepsState }
  void runInstall(record.path, plan.argv)
  return { started: true, deps: 'installing' }
}

/** 写 deps 状态（返回是否落盘成功）。 */
function finish(
  record: WorktreeRecord,
  deps: DepsState,
  detail?: string
): { ok: boolean; deps: DepsState; detail?: string } {
  const next: WorktreeRecord = {
    ...record,
    deps,
    ...(detail !== undefined ? { depsDetail: detail } : {}),
    depsUpdatedAt: Date.now()
  }
  const ok = upsertRecord(next)
  if (!ok) console.warn(`[worktree] deps 状态写入失败（${record.branch} → ${deps}）`)
  publishWorktreeChanged()
  return { ok, deps, ...(detail !== undefined ? { detail } : {}) }
}

/** 取最后 N 行（`depsDetail` 用）。 */
function tailLines(text: string, n = DETAIL_TAIL_LINES): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

/**
 * 真正跑安装。**不抛错**：所有失败都折成 `failed` + `depsDetail`。
 *
 * 从 store 重新取记录而不是用传进来的对象：安装跑几分钟，期间记录可能被别的操作改过
 * （比如用户点了「重试」或记录被删），拿旧对象回写会把那些改动覆盖掉。
 */
async function runInstall(path: string, argv: string[]): Promise<void> {
  const startedAt = Date.now()
  const emit = (step: string): void => {
    publishDepsProgress({ path, step, elapsedMs: Date.now() - startedAt })
  }
  emit(argv.join(' '))

  const result = await spawnAndWait(argv, path, () => emit(argv.join(' ')))

  // 记录可能已被删除（用户在中途删了工作区）：不再回写
  const rec = getRecord(path)
  if (!rec) return
  // 状态已被别人改过（例如启动清扫把 installing 改成 failed）：不覆盖
  if (rec.deps !== 'installing') return

  if (result.ok) finish(rec, 'ready')
  else finish(rec, 'failed', tailLines(result.detail))
}

/** 进度事件的节流出口（spec 要求复用 importer-ipc 的做法：100ms + 换步骤立即发）。 */
let lastProgressAt = 0
let progressTimer: NodeJS.Timeout | null = null
let pendingProgress: DepsProgress | null = null

function publishDepsProgress(p: DepsProgress): void {
  const THROTTLE = 100
  const flush = (): void => {
    if (progressTimer) {
      clearTimeout(progressTimer)
      progressTimer = null
    }
    if (!pendingProgress) return
    const payload = pendingProgress
    pendingProgress = null
    lastProgressAt = Date.now()
    publishWorktreeProgress({ phase: 'install-deps', ...payload })
  }
  pendingProgress = p
  if (Date.now() - lastProgressAt >= THROTTLE) flush()
  else if (!progressTimer) {
    progressTimer = setTimeout(flush, THROTTLE)
    progressTimer.unref?.()
  }
}

interface SpawnResult {
  ok: boolean
  detail: string
}

/**
 * 跑命令并等它结束。
 *
 * 超时杀**整棵树**：`pnpm` 会派生子进程（postinstall 脚本），只杀父进程会留下孤儿继续写
 * `node_modules`，而记录已经变成 `failed`——用户重试时两个进程抢同一个目录。
 */
function spawnAndWait(argv: string[], cwd: string, onTick: () => void): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    let out = ''
    let timedOut = false
    let settled = false
    const done = (r: SpawnResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd,
        // Windows 上 pnpm/npm 是 .cmd，必须 shell 才能找到（与 tools.ts 的 run_command 同一处理）
        shell: process.platform === 'win32',
        windowsHide: true,
        env: { ...process.env, CI: '1' },
        // posix 建进程组，超时时杀整组（见 killTree）
        detached: process.platform !== 'win32'
      })
    } catch (e) {
      done({ ok: false, detail: `spawn-failed: ${(e as Error)?.message ?? String(e)}` })
      return
    }

    const tick = setInterval(onTick, 1000)
    tick.unref?.()

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, INSTALL_TIMEOUT_MS)
    timer.unref?.()

    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
      if (out.length > 200_000) out = out.slice(-100_000) // 只留尾部，别把内存吃掉
    })
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString()
      if (out.length > 200_000) out = out.slice(-100_000)
    })
    child.on('error', (e) => {
      clearInterval(tick)
      clearTimeout(timer)
      done({ ok: false, detail: `spawn-error: ${e.message}` })
    })
    child.on('close', (code) => {
      clearInterval(tick)
      clearTimeout(timer)
      if (timedOut) done({ ok: false, detail: `timeout\n${tailLines(out)}` })
      else if (code === 0) done({ ok: true, detail: '' })
      else done({ ok: false, detail: `exit-${code}\n${tailLines(out)}` })
    })
  })
}

/**
 * 杀整棵进程树。
 *
 * Windows：`taskkill /T /F`（`/T` 带走子进程）；先 taskkill 再 `child.kill()`——
 * 顺序反了会让子进程的父链断掉，`/T` 就找不到它们。
 * posix：`detached` 建了进程组，杀 `-pid` 整组。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      tk.once('exit', () => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      })
      tk.once('error', () => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 「重试安装」/「重新安装」/「安装依赖」：三种入口都从当前状态进 `installing`（§2.2 的转移表）。
 *
 * 禁止 `ready → skipped`：安装过就不能装作没装。这里因此不接受 `skipDeps`——
 * 跳过只发生在创建时的 `pending`。
 */
export function retryInstall(path: string): { ok: boolean; reason?: string; deps?: DepsState } {
  const rec = getRecord(path)
  if (!rec) return { ok: false, reason: 'not-found' }
  if (rec.deps === 'installing') return { ok: false, reason: 'already-installing' }
  const plan = detectInstallPlan(rec.path)
  if (!plan.argv) return { ok: false, reason: plan.skipReason ?? 'no-lockfile' }
  if (!finish(rec, 'installing').ok) return { ok: false, reason: 'write-failed' }
  void runInstall(rec.path, plan.argv)
  return { ok: true, deps: 'installing' }
}