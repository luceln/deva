import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'fs'
import { join } from 'path'

/**
 * 导入互斥锁（`import.lock`）的读写与判活。
 *
 * 单独成模块的原因：`importer-gate`（`import:probe` 用它判「现在是不是正在导」）与 `importer`（真正抢锁）都要
 * 这套逻辑，而 gate ← importer 已有单向依赖，放进任一边都会绕成环。
 *
 * ⚠️ 核心不变式：**锁文件存在 ≠ 正在导入**。进程被强杀 / 断电 / Electron 崩溃时 `releaseLock` 的 finally 不执行，
 * 锁会留在盘上。若把「文件存在」当作忙碌，用户会被永久挡住，而且既找不到也不会想到去删 `~/.deva-plus/import.lock`
 * ——比直接报错更隐蔽。所以判活只能靠锁里写的 pid：进程还在才算占用。
 */

export const LOCK_FILE = 'import.lock'

/** 抢锁结果：拿到 fd，或被告知锁被一个活着的进程占着（带路径用于报错文案）。 */
export type LockResult = { fd: number } | { busy: string }

/** 读锁文件里的 pid；读不到 / 不是正整数 → null（视为没有有效的占用者）。 */
export function readLockPid(lock: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 该 pid 的进程是否还活着。`kill(pid, 0)` 不发信号、只做存在性检查，是跨平台标准做法：
 * Windows 上对不存在的进程抛 ESRCH，活着的进程返回成功；EPERM 表示进程存在但无权操作 → 也算活着。
 *
 * ⚠️ **pid 复用**：操作系统会把 pid 回收给新进程，极端情况下那个号已被别的进程占用，于是「陈旧锁」被误判成
 * 「还活着」，用户继续被挡住。这是有意的取舍：误判的代价是「用户需手动删一次锁文件」，而反过来的误判
 * （把正在跑的导入当成陈旧）会造成两次导入交叉写——宁可保守。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在，只是没权限给它发信号
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 锁是否被一个活着的进程占着（残留锁 / 没有锁 → false）。 */
export function isLockLive(home: string): boolean {
  const pid = readLockPid(join(home, LOCK_FILE))
  return pid !== null && isPidAlive(pid)
}

/**
 * 本进程是否有一轮导入正在跑（模块内单例）。与 lock 放一起，避免 importer ←→ gate 绕成环：
 * gate（import:probe）要判「现在是不是正在导」，importer（真正执行）要设/清这个状态。
 *
 * 注意它只是**进程内**的快速判定；跨进程（另一个窗口在导）要靠 isLockLive。
 */
let runningInProcess = false

export function markRunning(on: boolean): void {
  runningInProcess = on
}

/** 现在是否有导入在跑：本进程正在跑，或锁被另一个活着的进程占着。残留锁一律视为「没在导入」。 */
export function isImporting(home: string): boolean {
  return runningInProcess || isLockLive(home)
}

/**
 * 本进程内是否已有一轮导入在跑（不含跨进程）。
 *
 * runImport 开头的快速拒绝要用它而不是 isImporting：跨进程的情形必须走 acquireLock，
 * 那条路径才会给出「另一个窗口在导 + 锁文件完整路径」，用户照着删得掉；这里只挡同进程重入。
 */
export function isRunningInProcess(): boolean {
  return runningInProcess
}

/**
 * 抢锁：`'wx'` = O_EXCL，已存在即失败（不做「先查再建」，那中间有竞态窗口）。
 * 锁已存在时判活：占锁进程还活着 → busy；已死 / pid 读不出来 → 陈旧锁，删掉重抢一次。
 *
 * 只重试一次是有意的：若这期间别人先抢到，就该如实拒绝，而不是循环等。
 */
export function acquireLock(home: string): LockResult {
  const lock = join(home, LOCK_FILE)
  const open = (): LockResult => {
    try {
      const fd = openSync(lock, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } catch {
        /* 写 pid 失败不影响互斥语义，只是失去判活能力（下次会被当成陈旧锁） */
      }
      return { fd }
    } catch {
      // 任何失败都算没抢到：调用方据此报忙碌，绝不假装成功
      return { busy: lock }
    }
  }
  const first = open()
  if ('fd' in first) return first

  if (isLockLive(home)) return { busy: lock }
  // 陈旧锁（占锁进程已不存在，或 pid 读不出来）：清掉再抢。
  // pid 读不出来也按陈旧处理——本应用先写 pid 才开始干活；若它其实刚被别人建好、pid 还没落盘，
  // 下面的重抢会因 EEXIST 失败，天然安全。
  try {
    rmSync(lock, { force: true })
  } catch {
    return { busy: lock }
  }
  return open()
}

/** 释放锁：先关 fd 再删文件。返回是否删除成功（删不掉时调用方仍应继续收尾，只记日志）。 */
export function releaseLock(home: string, fd: number): void {
  try {
    closeSync(fd)
  } catch {
    /* 已关闭 */
  }
  try {
    rmSync(join(home, LOCK_FILE), { force: true })
  } catch {
    /* 删不掉：下次抢锁会判活，陈旧锁会被自动清理，不会永久阻塞 */
  }
}
