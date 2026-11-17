/**
 * 最终验收 runner：每个场景一个独立进程（被测模块有 config/secrets/home 模块级缓存）。
 * samehome 场景需要把 DEVA_HOME 指到「原版目录」，单独处理。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const DIST = path.join(QA, 'dist')
const STUB = path.join(QA, 'stub-electron.cjs')
const REAL_HOME = path.join(os.homedir(), '.deva')
const TMP_ROOT = path.join(os.tmpdir(), 'deva-accept')

const ALL = ['failchannels', 'race', 'samehome', 'samenested', 'idem', 'ignored', 'activekeep', 'activedangling', 'legacy']
const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const list = args.filter((a) => !a.startsWith('--'))

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(QA, 'accept.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'accept.cjs'),
    alias: { electron: STUB },
    external: ['electron'],
    logLevel: 'warning'
  })
  console.log('bundle ok → dist/accept.cjs')
}

function runOne(name) {
  return new Promise((resolve) => {
    const root = path.join(TMP_ROOT, `${name}-${Date.now()}`)
    const home = path.join(root, 'home')
    const appdata = path.join(root, 'appdata')
    const scratch = path.join(root, 'scratch')
    // samehome：目标与原版目录重合，验证闸门的 same-home 拒绝
    const dst = name === 'samehome' ? path.join(home, '.deva') : name === 'samenested' ? path.join(home, '.deva', 'data') : path.join(root, 'dst')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appdata, { recursive: true })
    fs.mkdirSync(scratch, { recursive: true })

    const env = {
      ...process.env,
      TEST_HOME: home,
      TEST_APPDATA: appdata,
      TEST_TMP: root,
      USERPROFILE: home,
      HOME: home,
      DEVA_HOME: dst,
      QA_REAL: REAL_HOME,
      QA_SCRATCH: scratch
    }
    const child = spawn(process.execPath, [path.join(DIST, 'accept.cjs'), name], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
      process.stdout.write(String(d))
    })
    child.stderr.on('data', (d) => {
      out += String(d)
      process.stderr.write(String(d))
    })
    child.on('close', (code) => {
      if (!KEEP) {
        try {
          fs.rmSync(root, { recursive: true, force: true })
        } catch {}
      }
      resolve({ name, code, out })
    })
  })
}

async function main() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  await build()
  const results = []
  for (const n of list.length ? list : ALL) results.push(await runOne(n))
  console.log('\n================ 验收汇总 ================')
  let bad = 0
  for (const r of results) {
    const failLines = r.out
      .split('\n')
      .filter((l) => l.startsWith('FAIL '))
      .map((l) => l.slice(5))
    const passCount = r.out.split('\n').filter((l) => l.startsWith('PASS ')).length
    if (r.code !== 0) bad++
    console.log(`${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.name.padEnd(14)} pass=${String(passCount).padStart(3)} fail=${failLines.length} exit=${r.code}`)
    for (const f of failLines) console.log(`        ✗ ${f}`)
  }
  console.log(`\n共 ${results.length} 个验收场景，${bad} 个有失败。`)
  try {
    if (!KEEP) fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
