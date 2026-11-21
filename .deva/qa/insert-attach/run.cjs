/**
 * 插话带附件 —— 在真 Chromium 里跑 `page.html`，把 6 条用例的结果变成**退出码**。
 *
 * 为什么需要这个文件
 * ----------------
 * `build.cjs` 产出的 `page.html` 只能靠人打开看 `document.title`（`DONE 6/6`）和 `window.__logs`。
 * 人工验收挡不住回归：第 6 条用例守的是「插话失败/回合被停时，附件必须回到输入框」——
 * 这是二开 50e2868 的验收点，也是「插话带的图不能凭空消失」的唯一运行时落点。
 * `check-insert-attachments.cjs` 只是**形状检查**（签名 + 子串），`restoreToComposer` 里加一句
 * `if (attachments) return` 就能让形状检查照样 19/0 全绿而功能已经废了。实测：
 * 加那句短路后，只有本文件的第 6 条用例会红。
 *
 * 所以这个脚本的价值只有一个：**让那条断言自动执行**。
 *
 * 跑法
 * ----
 *   node .deva/qa/insert-attach/run.cjs
 *
 * 浏览器来源（按优先级）：
 *   1. `DEVA_CHROME_PATH` 环境变量 —— 指向已有的 Chrome / Edge / Chromium 可执行文件
 *   2. puppeteer 自带的 Chromium（装了完整版 `puppeteer` 且下载成功时可用）
 *   3. 常见系统安装路径（Linux `/usr/bin/google-chrome` 等 / Windows / macOS）
 *
 * 注意 CI 上不用装浏览器：`ubuntu-latest`（24.04）镜像预装 Google Chrome，
 * 版本与 puppeteer 要求的 Chrome for Testing 一致，候选链第 3 步就能命中。
 *
 * ## 退出码：三种结果必须能分开
 *
 * 「浏览器装不上、用例根本没跑」和「用例跑了、代码真有 bug」是完全不同的两件事。
 * 都 exit 1 会让人以为是代码坏了，白查半天；反过来若环境问题被算成通过，就是假绿。
 * 所以：
 *
 * | 退出码 | 含义 | 该找谁 |
 * |---|---|---|
 * | 0 | 6 条全过 | — |
 * | 1 | **用例真的失败了**（有 FAIL） | 改代码 |
 * | 2 | **环境问题，用例未执行**（找不到/起不来浏览器、页面没渲染） | 改 CI 或本机环境 |
 *
 * 退出码 2 的所有输出都以 `ENV` 开头，workflow 会把它转成 `::error::` 并写明「不是代码问题」。
 */
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const PAGE = path.join(QA, 'page.html')

/** 退出码：用例失败 vs 环境问题。 */
const EXIT_FAIL = 1
const EXIT_ENV = 2

/** 打印环境问题并给退出码 2。必须在浏览器已关闭之后调用，避免进程残留。 */
function reportEnv(msg) {
  console.error(`\nENV 插话带附件用例未执行：${msg}`)
  console.error('ENV 这是环境问题，不是代码问题——用例一条都没跑，不能据此判断功能好坏。')
  process.exit(EXIT_ENV)
}

/**
 * 找浏览器：`DEVA_CHROME_PATH` → puppeteer 自带 Chromium → 各平台常见安装路径。
 *
 * 用 `puppeteer`（不是 `puppeteer-core`）：前者自带 Chromium，CI 上装一次就能跑；
 * 后者要求外部提供浏览器，在干净的 runner 上会直接失败。本地若已有系统 Chrome，
 * 走第 3 步即可，不必等 puppeteer 下载。
 */
async function findBrowser() {
  const env = process.env.DEVA_CHROME_PATH
  if (env) {
    if (!fs.existsSync(env)) {
      reportEnv(`DEVA_CHROME_PATH 指向的文件不存在：${env}`)
    }
    return { exe: env, from: 'DEVA_CHROME_PATH' }
  }
  // puppeteer 自带 Chromium（v22+ 的 executablePath 是异步的）
  try {
    const puppeteer = require('puppeteer')
    const p = await puppeteer.executablePath()
    if (p && fs.existsSync(p)) return { exe: p, from: 'puppeteer 自带' }
  } catch {
    /* 没装完整版 puppeteer 或浏览器没下载，继续找系统浏览器 */
  }
  const candidates = [
    // Linux（GitHub Actions 的 ubuntu-latest 镜像预装 /usr/bin/google-chrome）
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ]
  for (const c of candidates) if (fs.existsSync(c)) return { exe: c, from: '系统安装' }
  return null
}

async function main() {
  if (!fs.existsSync(PAGE)) {
    reportEnv(`没有 ${path.relative(REPO, PAGE)}——先跑 node .deva/qa/insert-attach/build.cjs`)
  }

  /*
   * 界面语言：默认 zh-CN。
   *
   * 断言本身不依赖具体文案（test.ts 从词条表取当前 locale 的期望值），所以这个值只决定
   * 「这次跑哪个语言」。设 DEVA_TEST_LOCALE=en 可以验证英文环境也过——CI 上专门跑一遍，
   * 因为 GitHub runner 的系统语言是 en-US，历史 bug 正是「只在中文系统成立」。
   */
  const testLocale = process.env.DEVA_TEST_LOCALE || 'zh-CN'

  const puppeteer = require('puppeteer')
  const found = await findBrowser()
  if (!found) {
    reportEnv(
      '找不到任何 Chrome / Chromium。三种办法：设 DEVA_CHROME_PATH 指向浏览器可执行文件；' +
        '或 `pnpm exec puppeteer browsers install chrome` 下载 puppeteer 自带的；' +
        '或装系统浏览器（apt install google-chrome-stable / chromium）。'
    )
  }
  console.log(`  browser: ${found.exe}（来自 ${found.from}）`)
  console.log(`  locale: ${testLocale}`)

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: found.exe,
      headless: true,
      // --no-sandbox 是 CI（容器内 root）跑 Chromium 必需的；--disable-dev-shm-usage 防 /dev/shm 太小
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--lang=${testLocale}`]
    })
  } catch (e) {
    // 启动不了 = 环境问题（缺系统库、沙箱、权限），不是用例失败
    reportEnv(`浏览器启动失败：${(e && e.message ? e.message : String(e)).slice(0, 500)}`)
  }

  let code
  let envIssue = null
  try {
    const page = await browser.newPage()
    // 浏览器 locale 的两层都设：--lang 影响 Chrome 自身（含 navigator.language），
    // Accept-Language 影响 file:// 之外的内容协商。页面里还会再桩一次（deva-stub.js），
    // 因为 --lang 依赖 Chrome 装了对应语言包，不保证生效。
    await page.setExtraHTTPHeaders({ 'Accept-Language': testLocale })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 300))
    })

    const url =
      'file:///' + PAGE.split(path.sep).join('/') + `?locale=${encodeURIComponent(testLocale)}`
    await page.goto(url, { waitUntil: 'load', timeout: 60000 })

    /*
     * 等 title 变成 `DONE x/y`。用例本身是异步的（挂载 → 粘贴 → 等附件条），
     * 用 waitForFunction 而不是 sleep：慢机器上也不会假红。
     */
    let finished = true
    try {
      await page.waitForFunction(() => /^DONE \d+\/\d+$/.test(document.title), { timeout: 180000 })
    } catch {
      finished = false
    }

    const title = await page.title()
    const logs = await page.evaluate(() => window.__logs || [])
    const pass = logs.filter((l) => l.startsWith('PASS '))
    const fail = logs.filter((l) => l.startsWith('FAIL '))
    const total = pass.length + fail.length

    for (const l of logs) console.log(`  ${l}`)
    if (pageErrors.length) {
      console.log('  页面报错：')
      for (const e of pageErrors.slice(0, 10)) console.log(`    ${e}`)
    }

    if (fail.length) {
      // 有 FAIL = 用例真的红了，无论跑没跑完
      console.log(`\n插话带附件：${pass.length}/${total} 通过，${fail.length} 条失败`)
      for (const f of fail) console.log(`  ✗ ${f}`)
      code = EXIT_FAIL
    } else if (total === 0) {
      // 一条都没执行 = 测试脚本自己没起来（bundle 崩了 / 页面没渲染），这不是「通过」
      envIssue =
        `一条用例都没执行（title=${JSON.stringify(title)}）` +
        (pageErrors.length ? `；页面首条报错：${pageErrors[0]}` : '')
    } else if (!finished) {
      // 跑了几条但没跑完（卡住 / 崩溃），不能算通过，也不是明确的用例失败
      envIssue = `页面没跑完（title=${JSON.stringify(title)}，已执行 ${total} 条）`
    } else {
      console.log(`\n插话带附件：${pass.length}/${total} 全部通过`)
      code = 0
    }
  } finally {
    await browser.close()
  }

  // 环境问题在浏览器关掉之后再报，避免进程残留
  if (envIssue) reportEnv(envIssue)
  process.exit(code)
}

main().catch((e) => {
  // 没预料到的异常（脚本自身 bug、依赖缺失等）也归环境，避免冒充「用例失败」
  reportEnv(`运行失败：${(e && e.message ? e.message : String(e)).slice(0, 500)}`)
})
