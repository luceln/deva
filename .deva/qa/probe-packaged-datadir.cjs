/**
 * 让打包版自己报告 userData 与 DEVA_HOME。
 *
 * `probe-packaged.cjs` 只证明「进程能活」，这个证明「它用的是哪个数据目录」——两者都是
 * 「装完能不能正常用」的必要条件，混成一个脚本就分不清是哪一步出的问题。
 *
 * 做法：不注入任何代码（打包版是 asar，改不了），改用 Electron 的 `--inspect` 太重，
 * 于是走另一条：**看它启动后实际创建/读取哪个目录**。
 * Windows 上 userData 目录名由 package.json 的 name 决定，进程一启动 Chromium 就会往里写
 * `Local State`、`Cache` 等。所以：
 *
 *   ① 启动打包版，等它 ready
 *   ② 检查 %APPDATA%\devaplus 与 %APPDATA%\devaplus\dev 哪个的 mtime 变了
 *   ③ 期望：devaplus 变了、devaplus\dev 没变（隔离在打包分支上必须关闭）
 *
 * 这个判据不需要读它的内存，也不需要它配合打印。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const EXE = path.join(__dirname, '../../apps/desktop/dist/win-unpacked/DevaPlus.exe')
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const PROD_DIR = path.join(APPDATA, 'devaplus')
const DEV_DIR = path.join(APPDATA, 'devaplus', 'dev')

if (!fs.existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(1)
}

/** 目录及其直接子项的最近 mtime（不存在返回 0）。 */
function stamp(dir) {
  try {
    const st = fs.statSync(dir)
    let max = st.mtimeMs
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      try {
        max = Math.max(max, fs.statSync(path.join(dir, e.name)).mtimeMs)
      } catch {
        /* 有的条目读不到，忽略 */
      }
    }
    return max
  } catch {
    return 0
  }
}

const beforeProd = stamp(PROD_DIR)
const beforeDev = stamp(DEV_DIR)
console.log(`观测前 mtime：prod=${beforeProd} dev=${beforeDev}`)

const env = { ...process.env }
delete env.DEVA_HOME
delete env.ELECTRON_RENDERER_URL

const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => (out += d.toString()))

setTimeout(() => {
  const afterProd = stamp(PROD_DIR)
  const afterDev = stamp(DEV_DIR)
  try {
    child.kill()
  } catch {
    /* ignore */
  }

  const prodTouched = afterProd > beforeProd
  const devTouched = afterDev > beforeDev

  console.log(`观测后 mtime：prod=${afterProd} dev=${afterDev}`)
  console.log('\n=== 结果 ===')
  console.log(`打包版写入 devaplus（发布目录）：${prodTouched ? 'PASS' : 'FAIL（没动 → 可能用的是别的目录）'}`)
  console.log(`打包版没写 devaplus\\dev（dev 子目录）：${devTouched ? 'FAIL（写进去了 → 隔离在打包分支上没关掉）' : 'PASS'}`)

  if (!prodTouched && out.trim()) {
    console.log('--- 进程输出 ---')
    console.log(out.slice(-1500))
  }
  process.exit(prodTouched && !devTouched ? 0 : 1)
}, 9000)
