/**
 * 品牌与数据目录护栏。
 *
 * 为什么需要它：`driver.cjs` 的**每个场景都设了 `DEVA_HOME`**，所以 52 个场景一次都没跑过
 * 「没设 DEVA_HOME 时落到 `~/.deva-plus`」这条默认路径——而真实用户走的正是这条。
 * 改掉目录名或 appId / productName 都不会让编译、类型、任何界面测试报错：
 * 程序安静地去新目录，老数据原地不动，用户看到的是「技能、配置、记忆全没了」。
 *
 * 断言（任何不符即失败）：
 *  1. 无 DEVA_HOME 时 `getDevaHome()` 的末段严格等于 `.deva-plus`；
 *  2. 有 DEVA_HOME 时等于该值（覆盖分支仍可用）；
 *  3. `electron-builder.yml` 的 appId 为 `dev.lucel.devaplus`（改了 = 系统当成另一个应用：
 *     旧版不卸载、双图标、更新装两份）；
 *  4. `electron-builder.yml` 的 productName 为 `DevaPlus`（改了 = 新旧装在不同目录，
 *     `updater.ts` 的 `/opt/DevaPlus/` 判定与 `portable.ts` 的卸载器名同时失效）。
 *
 * 取证方式是**运行时真值**，不是读源码文本：子进程里 esbuild 打包真实 `config.ts`，用 QA 的
 * electron 桩（`stub-electron.cjs`）把 `app.getPath('home')` 指向**临时目录**，并**删掉 DEVA_HOME**，
 * 再调 `getDevaHome()` 取返回值。因此：
 *  · 拿到的是真函数算出来的路径，不是我们对源码的理解；
 *  · `getDevaHome()` 内部的 `mkdirSync` 只会落在临时目录里，**真实 ~/.deva-plus 一个字节都不碰**；
 *  · 脚本结束时删掉临时目录。
 *
 * 运行：node .deva/qa/check-brand-home.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const yaml = require('js-yaml')

const QA = __dirname
const ROOT = path.resolve(QA, '..', '..')
const CONFIG = path.join(ROOT, 'apps', 'desktop', 'src', 'main', 'services', 'config.ts')
const BUILDER_YML = path.join(ROOT, 'apps', 'desktop', 'electron-builder.yml')
const STUB = path.join(QA, 'stub-electron.cjs')

/** 用户真实数据目录的末段。改它等于让老数据失联。 */
const EXPECTED_DIRNAME = '.deva-plus'
const EXPECTED_APP_ID = 'dev.lucel.devaplus'
const EXPECTED_PRODUCT_NAME = 'DevaPlus'

let fails = 0
function pass(name, detail = '') {
  console.log(`  PASS ${name}${detail ? ' :: ' + detail : ''}`)
}
function fail(name, detail) {
  fails++
  console.log(`  FAIL ${name} :: ${detail}`)
}

/**
 * 在独立子进程里取 `getDevaHome()` 的真值。
 *
 * `home` 是 `config.ts` 的模块级缓存，且 `DEVA_HOME` 只在首次调用时读取——两种情形必须在**不同进程**里取，
 * 否则第二次会命中缓存，测出来的永远是第一次的值。
 *
 * @param devaHome 传入时代表「有 DEVA_HOME」；传 null 表示**从环境里删掉**该项（默认路径分支）。
 * @param tmpHome 桩的 `app.getPath('home')`，指向临时目录。
 */
function probeDevaHome(devaHome, tmpHome) {
  const entry = path.join(QA, '.brand-home-entry.ts')
  const outfile = path.join(QA, '.brand-home-probe.cjs')
  fs.writeFileSync(
    entry,
    [
      `import { getDevaHome } from ${JSON.stringify(CONFIG.replace(/\\/g, '/'))}`,
      'process.stdout.write(JSON.stringify({ home: getDevaHome() }))',
      ''
    ].join('\n')
  )
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { electron: STUB },
    external: ['electron'],
    logLevel: 'warning'
  })

  const env = { ...process.env, TEST_HOME: tmpHome, TEST_APPDATA: path.join(tmpHome, 'appdata') }
  // 硬红线：必须把继承来的 DEVA_HOME 删干净，否则测的还是 driver 那套环境，等于没测默认路径。
  delete env.DEVA_HOME
  if (devaHome !== null) env.DEVA_HOME = devaHome

  try {
    const r = spawnSync(process.execPath, [outfile], { env, encoding: 'utf8' })
    const raw = (r.stdout || '').trim()
    if (r.status !== 0) return { error: `子进程退出码 ${r.status}：${(r.stderr || '').trim().split('\n')[0]}` }
    try {
      return { home: JSON.parse(raw).home }
    } catch {
      return { error: `子进程输出不是 JSON：${raw.slice(0, 200)}` }
    }
  } finally {
    for (const f of [entry, outfile]) fs.rmSync(f, { force: true })
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deva-brandhome-'))
  try {
    // ── 1. 默认路径：没有 DEVA_HOME ──────────────────────────────
    const def = probeDevaHome(null, path.join(tmp, 'home'))
    if (def.error) {
      fail('无 DEVA_HOME 时 getDevaHome() 可取值', def.error)
    } else {
      const dirname = path.basename(def.home)
      if (dirname === EXPECTED_DIRNAME) pass('无 DEVA_HOME 时落到 ~/.deva-plus', def.home)
      else fail('无 DEVA_HOME 时落到 ~/.deva-plus', `末段为 "${dirname}"，期望 "${EXPECTED_DIRNAME}"（真实用户数据在旧目录，改了会静默「数据全没」）`)
      // 取证健全性：确认这次真的只在临时目录里算，没落到真实 home。
      if (def.home.startsWith(path.join(tmp, 'home'))) pass('取证未触碰真实数据目录', `临时 home=${path.join(tmp, 'home')}`)
      else fail('取证未触碰真实数据目录', `返回值不在临时 home 下：${def.home}`)
    }

    // ── 2. 覆盖分支：设了 DEVA_HOME ─────────────────────────────
    const overridePath = path.join(tmp, 'override-home')
    const over = probeDevaHome(overridePath, path.join(tmp, 'home2'))
    if (over.error) {
      fail('有 DEVA_HOME 时覆盖生效', over.error)
    } else if (over.home === overridePath) {
      pass('有 DEVA_HOME 时覆盖生效', over.home)
    } else {
      fail('有 DEVA_HOME 时覆盖生效', `得到 "${over.home}"，期望 "${overridePath}"`)
    }

    // ── 3/4. 安装标识：appId / productName ─────────────────────
    let cfg = null
    try {
      cfg = yaml.load(fs.readFileSync(BUILDER_YML, 'utf8'))
    } catch (e) {
      fail('electron-builder.yml 可解析', String(e && e.message))
    }
    if (cfg) {
      if (cfg.appId === EXPECTED_APP_ID) pass('appId 未变', cfg.appId)
      else fail('appId 未变', `为 ${JSON.stringify(cfg.appId)}，期望 "${EXPECTED_APP_ID}"（改了 = 系统当成另一个应用：旧版不卸载、双图标、更新装两份）`)

      if (cfg.productName === EXPECTED_PRODUCT_NAME) pass('productName 未变', cfg.productName)
      else fail('productName 未变', `为 ${JSON.stringify(cfg.productName)}，期望 "${EXPECTED_PRODUCT_NAME}"（改了 = 新旧装在不同目录，updater 的 /opt/DevaPlus/ 判定与 portable 的卸载器名同时失效）`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (fails) {
    console.log(`\n品牌与数据目录校验失败：${fails} 项`)
    process.exitCode = 1
  } else {
    console.log('\n品牌与数据目录校验通过：默认 ~/.deva-plus、DEVA_HOME 覆盖、appId、productName 都没变。')
  }
}

try {
  main()
} catch (e) {
  console.error(e)
  process.exitCode = 1
}
