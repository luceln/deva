/**
 * A27 真实安装路径的**可控**验证：用一个本地 `file:` 依赖让 `npm install` 真跑一遍，
 * 不联网、不下载、几秒内结束。
 *
 * 为什么值得单独验：此前只验了「检测规则」与「失败不回滚」，**没验过 `installing → ready` 这条真实链路**。
 * 少了它，「装成功」这条路径可能一直是坏的而没人知道（比如子进程 exit 0 但被误判成失败）。
 *
 * 造法：
 *   1. 临时目录里做一个「假包」`pkg-local`，只有一个 package.json；
 *   2. main 仓库里放 package.json + package-lock.json，dependency 指向 `file:../pkg-local`；
 *      lockfile 是 `npm install --package-lock-only` 生成的（npm 自己算的，不是我手写的假格式）；
 *   3. 走 `detectInstallPlan` → 应当命中 `npm ci`；`npm ci` 对 file: 依赖不联网。
 *
 * 只在 `A27_REAL=1` 时跑（默认跳过）：它真的会 spawn npm，CI 上慢一点、且依赖 npm 存在。
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface RealInstallResult {
  /** 环境是否具备（npm 在不在）。不具备时 skipped=true，不算失败。 */
  skipped: boolean
  /** 是否真的走到了 ready。 */
  ok: boolean
  /** 命中的命令（应含 `npm ci`）。 */
  command: string
  /** 失败时的现场。 */
  detail: string
  /** 装完后 node_modules 里有没有那个依赖（真装上的证据）。 */
  depPresent: boolean
}

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1' },
    timeout: 120_000
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * 造一个用 `file:` 依赖、能在几秒内 `npm ci` 完成的仓库。
 *
 * 返回 null 表示环境不具备（npm 不可用 / npm 版本不认这个 lockfile 格式）：调用方按 skipped 处理。
 */
export function makeTinyInstallableRepo(root: string): string | null {
  // probe 的 cwd 必须是已存在的目录（root 还没建，拿它当 cwd 会 spawn 失败而不是「npm 不可用」）
  fs.mkdirSync(root, { recursive: true })
  const probe = run('npm', ['--version'], root)
  if (probe.code !== 0) return null

  // 假包：没有任何依赖，install 时只需把它链进 node_modules
  const pkg = path.join(root, '..', 'pkg-local')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'pkg-local', version: '1.0.0', main: 'index.js' }, null, 2)
  )
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 42\n')

  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'tiny-repo', version: '1.0.0', private: true, dependencies: { 'pkg-local': 'file:../pkg-local' } },
      null,
      2
    )
  )
  // 真让 npm 生成 lockfile（不手写格式：格式一错就变成测「我的假数据」而不是测 npm）
  const gen = run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], root)
  if (gen.code !== 0) return null
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) return null
  return root
}

/** 检查装完后的现场：node_modules 里有没有那个依赖。 */
export function depInstalled(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, 'node_modules', 'pkg-local', 'package.json'))
}

/** 跑一次 `npm ci`（与 deps.ts 里同一条命令），返回是否 exit 0。 */
export function runNpmCi(repoRoot: string): { ok: boolean; detail: string } {
  const r = run('npm', ['ci', '--no-audit', '--no-fund'], repoRoot)
  return { ok: r.code === 0, detail: r.code === 0 ? '' : `exit-${r.code}\n${r.out.slice(-2000)}` }
}