/**
 * 在指定源码树上打包一个验收场景并单跑一次。
 * 用法：node /tmp/run-accept.cjs <源码树根> <场景名> [场景入口文件]
 * 例：  node /tmp/run-accept.cjs /tmp/deva-base accept5 accept5.ts
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '..', '..')
const STUB = path.join(__dirname, 'stub-electron.cjs')
const [rootArg, scenario, entryFile] = process.argv.slice(2)
const ROOT = path.resolve(rootArg)
const entry = path.join(ROOT, '.deva/qa', entryFile || `${scenario}.ts`)
const outDir = path.join(os.tmpdir(), `accept-build-${path.basename(ROOT)}`)
const outfile = path.join(outDir, `${scenario}.cjs`)

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { electron: STUB },
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps/desktop/node_modules')],
    external: ['electron'],
    logLevel: 'error'
  })
  console.log(`bundle ok → ${outfile}（源码树 ${ROOT}）\n`)

  const tmp = path.join(os.tmpdir(), `accept-run-${scenario}-${Date.now()}`)
  const home = path.join(tmp, 'home')
  const appdata = path.join(tmp, 'appdata')
  const scratch = path.join(tmp, 'scratch')
  const dst = path.join(tmp, 'dst')
  for (const d of [home, appdata, scratch]) fs.mkdirSync(d, { recursive: true })
  const env = {
    ...process.env,
    TEST_HOME: home,
    TEST_APPDATA: appdata,
    TEST_TMP: tmp,
    USERPROFILE: home,
    HOME: home,
    DEVA_HOME: dst,
    QA_SCRATCH: scratch
  }
  const child = spawn(process.execPath, [outfile, scenario], { env, stdio: 'inherit' })
  child.on('close', (code) => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    process.exit(code ?? 0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
