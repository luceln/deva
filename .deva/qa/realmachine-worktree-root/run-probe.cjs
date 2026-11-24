/**
 * 跑 `probe-reject.ts`：定位「根落在仓库内」校验是否真的触发。
 *
 * 复用 run-real.cjs 的隔离方式与临时根（QA_ROOT 传入），但**不重建 deva-home**，
 * 直接沿用上一轮主脚本造好的 `worktrees.json`，这样能确认「记录已就位时 setRoot 会不会拒绝」。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const DIST = path.join(QA, 'dist')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

const ROOT = process.env.QA_ROOT
if (!ROOT) {
  console.error('需要 QA_ROOT（沿用之前造好的临时根）')
  process.exit(2)
}
const RESULT = path.join(ROOT, 'probe-result.txt')

async function main() {
  fs.mkdirSync(DIST, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(QA, 'probe-reject.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'probe-reject.cjs'),
    external: ['electron'],
    logLevel: 'warning'
  })
  fs.writeFileSync(RESULT, '')
  const env = {
    ...process.env,
    DEVA_HOME: path.join(ROOT, 'deva-home'),
    QA_RESULT: RESULT,
    QA_ROOT: ROOT,
    QA_REPO_ROOT: REPO,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  const child = spawn(ELECTRON, [path.join(DIST, 'probe-reject.cjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += String(d)
    process.stdout.write(String(d))
  })
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/GPU|gpu_|sandbox|DevTools|Fontconfig|libva|Vulkan|d3d11|angle|Network service|disk_cache/i.test(s)) {
      process.stderr.write(s)
    }
  })
  child.on('close', (code) => {
    console.log(`\n--- probe 退出码 ${code} ---`)
    const txt = fs.existsSync(RESULT) ? fs.readFileSync(RESULT, 'utf8') : ''
    if (!txt.trim()) console.log('（结果为空：Electron 没跑到脚本）')
    process.exit(code === 0 ? 0 : 1)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})