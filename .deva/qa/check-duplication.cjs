/**
 * 重复代码判据：**只拦新增的重复**，存量重复不拦。
 *
 * ── 为什么是「只拦新增」 ───────────────────────────────
 * 本仓有 41 处存量重复（97k 行源码里 832 行、0.86%）。jscpd 官方点名的坑是：
 * 阈值设成「有重复就失败」，第一次跑就全红，然后所有人把这条 linter 关掉。
 * 所以这里用 `--baseline`：跑出一份「已知重复」的指纹清单，之后**只报清单里没有的**。
 *
 * ── 为什么做成 wrapper 而不是直接在 CI 里调 jscpd ────────
 * 1. **配置里不能写 `exitCode`。** 实测（jscpd 5.4.3）：`.jscpd.json` 里写 `"exitCode": 1`
 *    会让 `--fail-on-new-clones` 失效——存量 41 处重复也判 exit 1，等于回到「一上线全红」。
 *    这条坑只能靠 wrapper 固化下来，写在注释里没人看。
 * 2. **要能输出「新增了哪几处」**，而不只是退出码。CI 日志里得直接看到是哪个文件哪一段。
 * 3. **baseline 更新要有明确入口**（`--update-baseline`），不能让人随手重跑覆盖存量基线。
 * 4. 与 `.deva/qa/` 下其他判据同一形状：自检 + 反向验证 + 可读结论。
 *
 * ── 反向验证（改这里之前先跑一遍） ─────────────────────
 * 复制一个 60+ token 的代码块到另一个源文件，必须 exit 1 并点名那段；删掉后必须回到 exit 0。
 * 实测记录：把 `backup-ipc.ts` 的 `throttle()`（23-67 行，221 tokens）复制到 `services/git.ts`，
 * 输出 `found 1 new clones not in the baseline` 并点出 `git.ts:1047-1091`。
 *
 * ── 用法 ─────────────────────────────────────────────
 *   node .deva/qa/check-duplication.cjs                   # 判据模式（CI 用这个）
 *   node .deva/qa/check-duplication.cjs --update-baseline # 有意清理存量后重写基线
 *   node .deva/qa/check-duplication.cjs --list            # 只列出当前全部重复，不判失败
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..', '..')
const CONFIG = path.join(ROOT, '.jscpd.json')
const BASELINE = path.join(ROOT, '.jscpd-baseline.json')
const SCAN_PATHS = ['apps/desktop/src']

function runJscpd(extraArgs, reporters) {
  // 优先用 lockfile 里的本地依赖（`pnpm install --frozen-lockfile` 会装好，版本即 5.4.3）。
  // 本地没有时才退回 `npx --yes jscpd@5.4.3`：能跑，但会现场联网下载，
  // 在 CI/离线环境里是不可接受的回退路径，所以版本必须显式钉住，不能用 latest。
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'jscpd.CMD' : 'jscpd')
  const cmd = fs.existsSync(local) ? local : 'npx'
  const args = fs.existsSync(local)
    ? [...SCAN_PATHS, '--config', CONFIG, ...extraArgs]
    : ['--yes', 'jscpd@5.4.3', ...SCAN_PATHS, '--config', CONFIG, ...extraArgs]
  if (reporters) args.push('--reporters', reporters)
  if (!fs.existsSync(local)) {
    console.log('提示：本地没有 jscpd，改用 npx 现场下载（离线环境会失败，请先 pnpm install）')
  }
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, JSCPD_NO_TIPS: '1', npm_config_loglevel: 'error' },
  })
}

function main() {
  const argv = process.argv.slice(2)

  for (const f of [CONFIG, BASELINE]) {
    if (!fs.existsSync(f)) {
      console.log(`结论：FAIL —— 缺少 ${path.relative(ROOT, f)}`)
      console.log('第一次使用请先跑：node .deva/qa/check-duplication.cjs --update-baseline')
      process.exit(1)
    }
  }

  if (argv.includes('--update-baseline')) {
    const r = runJscpd(['--baseline', BASELINE, '--update-baseline'])
    process.stdout.write(r.stdout || '')
    if (r.status !== 0) console.error(r.stderr || '')
    console.log(`\n基线已重写：${path.relative(ROOT, BASELINE)}`)
    console.log('注意：重写会把当前所有重复都记为「已知」，包括这段时间新引入的。只在有意清理存量时用。')
    process.exit(0)
  }

  if (argv.includes('--list')) {
    const r = runJscpd([], 'console-full')
    process.stdout.write(r.stdout || '')
    if (r.status !== 0) console.error(r.stderr || '')
    process.exit(0)
  }

  // 判据模式
  const r = runJscpd(['--baseline', BASELINE, '--fail-on-new-clones'])
  const out = `${r.stdout || ''}${r.stderr || ''}`
  // 检出进度行（silent 已压掉大部分，这里再滤一遍 npm 噪声）
  const noise = /npm warn|^Using config|^\s*$/
  const lines = out.split(/\r?\n/).filter((l) => !noise.test(l))
  process.stdout.write(lines.join('\n') + '\n')

  if (r.status === 0) {
    console.log('\n结论：PASS —— 没有新增重复（存量重复不拦）')
    process.exit(0)
  }

  console.log(`\n结论：FAIL —— 引入了新的重复代码（jscpd exit ${r.status}）`)
  console.log('怎么修：抽成共用函数 / 常量，或确认是有意重复时在源码里加')
  console.log('  /* jscpd:ignore-start */ … /* jscpd:ignore-end */')
  console.log('确认无误且有意保留，再用 --update-baseline 把它记入基线。')
  process.exit(1)
}

main()