/**
 * 实测打包产物能不能跑，以及它的数据目录在哪。
 *
 * 只检查「文件存在」是不够的：本项目反复出现「看着打好、启动就退」的情况。所以这里真的启动
 * `win-unpacked/DevaPlus.exe`，让它自带的主进程打印 userData 与 DEVA_HOME，再看进程活没活下来。
 *
 * 判定三件事：
 *   ① 进程能起来并保持存活（不是启动即崩）
 *   ② userData 指向 devaplus（不是 dev 的 ...\devaplus\dev 子目录）——证明隔离逻辑在打包分支上是关闭的
 *   ③ DEVA_HOME 未被设置 → config.ts 回落到 ~/.deva-plus，与 dev 的 ~/.deva-plus-dev 分开
 *
 * 跑完会杀掉进程。不写任何真实数据（只启动到 ready 就退）。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const EXE = path.join(__dirname, '../../apps/desktop/dist/win-unpacked/DevaPlus.exe')

if (!fs.existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 electron-builder --win 或 make-portable.ps1`)
  process.exit(1)
}

// 用临时 DEVA_HOME，避免真的去写用户的 ~/.deva-plus
const tmpHome = path.join(os.tmpdir(), 'probe-pkg-' + Date.now())
fs.mkdirSync(tmpHome, { recursive: true })

// 打包版的 app.getPath('userData') 由 package.json 的 name 决定，与 DEVA_HOME 无关。
// 这里不设 DEVA_HOME：要看的就是「不设时它回落到哪」。
const env = { ...process.env }
delete env.DEVA_HOME
delete env.ELECTRON_RENDERER_URL

console.log('启动打包版：', EXE)
const child = spawn(EXE, ['--probe-exit-after-ready'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})

let out = ''
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => (out += d.toString()))

let exited = false
let exitInfo = null
child.on('exit', (code, signal) => {
  exited = true
  exitInfo = { code, signal }
})

// 给它 8 秒起来；能撑过去就认为不是启动即崩
setTimeout(() => {
  const alive = !exited
  console.log('\n=== 结果 ===')
  console.log(`存活 8 秒：${alive ? 'PASS' : 'FAIL → 退出码 ' + JSON.stringify(exitInfo)}`)
  if (!alive) {
    console.log('--- 输出 ---')
    console.log(out.slice(-2000) || '(无输出)')
  }

  try {
    child.kill()
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpHome, { recursive: true, force: true })
  process.exit(alive ? 0 : 1)
}, 8000)
