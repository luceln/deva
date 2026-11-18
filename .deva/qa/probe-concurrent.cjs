/**
 * 探测：dev 与打包版能不能**同时跑**。
 *
 * 之前的 probe-dev-isolation.cjs 只证明「两个分支的 userData / DEVA_HOME 取值不同」，
 * 但用户真正要的是「我开着 dev 的时候，能不能再打开装好的二开版，而且两个都在」。这两件事不等价：
 * userData 不同不代表单实例锁不冲突——锁的键就是 userData，只有键真的不同才可能同时持锁。
 *
 * 所以这里直接跑两个 Electron 进程，各自按 index.ts 的逻辑设置 userData，然后都去
 * `requestSingleInstanceLock()`，打印自己拿到没拿到。三种组合都要覆盖：
 *
 *   ① 两个都是 dev（同 userData）      → 后一个必须拿不到锁（这才是锁还在生效的证据）
 *   ② 一个 dev 一个打包（不同 userData）→ 两个都要拿到锁（这才是隔离生效的证据）
 *   ③ 两个都是打包（同 userData）      → 后一个必须拿不到锁（发布版行为没有被改动）
 *
 * ① 和 ③ 是反证：如果只测 ② 拿到锁，那可能只是锁整体坏了，而不是隔离生效。
 *
 * 用法：node .deva/qa/probe-concurrent.cjs
 */
const { spawn } = require('child_process')
const { join } = require('path')
const fs = require('fs')
const path = require('path')

const ELECTRON = join(__dirname, '../../node_modules/electron/dist/electron.exe')
const APP_DIR = join(__dirname, 'probe-concurrent-app')

/** 子进程用的最小 Electron 应用：设 userData → 抢锁 → 报结果 → 退。 */
function writeChildApp() {
  fs.mkdirSync(APP_DIR, { recursive: true })
  fs.writeFileSync(
    join(APP_DIR, 'package.json'),
    JSON.stringify({ name: 'probe-concurrent', version: '0.0.0', main: 'main.cjs' })
  )
  fs.writeFileSync(
    join(APP_DIR, 'main.cjs'),
    `const { app } = require('electron')
const { join } = require('path')
// 与 index.ts 的 isolateDevData 同逻辑
const effDev = process.env.PROBE_PACKAGED === '1' ? false : !app.isPackaged
if (effDev) {
  app.setPath('userData', join(app.getPath('userData'), 'dev'))
  if (!process.env.DEVA_HOME?.trim())
    process.env.DEVA_HOME = join(app.getPath('home'), '.deva-plus-dev')
}
const got = app.requestSingleInstanceLock()
console.log('---PROBE---')
console.log('role=' + (process.env.PROBE_ROLE || '?'))
console.log('effectiveDev=' + effDev)
console.log('userData=' + app.getPath('userData'))
console.log('gotLock=' + got)
console.log('---END---')
if (!got) { app.quit() } else { setTimeout(() => { app.releaseSingleInstanceLock(); app.quit() }, 6000) }
`
  )
}

function runChild({ role, packaged }) {
  return new Promise((resolve) => {
    const env = { ...process.env, PROBE_ROLE: role }
    if (packaged) env.PROBE_PACKAGED = '1'
    else delete env.PROBE_PACKAGED
    // 每个进程用独立 DEVA_HOME，避免探针互相影响数据目录；userData 一律不设，由 app 自己按构造决定
    env.DEVA_HOME = join(appDataHome(), 'probe-concurrent', role)
    const child = spawn(ELECTRON, [APP_DIR], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, 20000)
    child.on('close', () => {
      clearTimeout(timer)
      const grab = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] ?? ''
      resolve({
        role,
        packaged,
        gotLock: grab('gotLock'),
        userData: grab('userData'),
        effectiveDev: grab('effectiveDev')
      })
    })
  })
}

function appDataHome() {
  return process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
}

async function pair(first, second) {
  // 第一个在后台起，等它真的持锁之后再起第二个（否则两个都可能在对方之前拿到锁，测不出东西）
  const a = runChild(first)
  await new Promise((r) => setTimeout(r, 2500))
  const b = await runChild(second)
  const ra = await a
  return [ra, b]
}

function report(name, expect, [a, b]) {
  const ok = a.gotLock === 'true' && b.gotLock === expect
  console.log(`\n=== ${name} ===`)
  for (const r of [a, b]) {
    console.log(
      `  ${r.role.padEnd(8)} dev=${String(r.effectiveDev).padEnd(5)} gotLock=${String(r.gotLock).padEnd(5)} userData=${r.userData}`
    )
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  期望第二个 gotLock=${expect}`)
  return ok
}

async function main() {
  writeChildApp()
  const results = []
  results.push(
    report('① dev + dev（同 userData，锁必须仍然生效）', 'false', await pair(
      { role: 'dev-a', packaged: false },
      { role: 'dev-b', packaged: false }
    ))
  )
  results.push(
    report('② dev + 打包（不同 userData，两个都要能开）', 'true', await pair(
      { role: 'dev', packaged: false },
      { role: 'prod', packaged: true }
    ))
  )
  results.push(
    report('③ 打包 + 打包（同 userData，锁必须仍然生效）', 'false', await pair(
      { role: 'prod-a', packaged: true },
      { role: 'prod-b', packaged: true }
    ))
  )
  fs.rmSync(APP_DIR, { recursive: true, force: true })
  const bad = results.filter((x) => !x).length
  console.log(`\n${bad === 0 ? '全部通过' : `${bad} 组不符合预期`}`)
  process.exit(bad === 0 ? 0 : 1)
}

main()
