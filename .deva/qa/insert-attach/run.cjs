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
 *   2. puppeteer 自带的 Chromium（装了完整版 `puppeteer` 时可用）
 *   3. 常见系统安装路径（Windows / macOS / Linux 各试一遍）
 *
 * 退出码：0 = 6 条全过；1 = 有失败或页面没跑起来。CI 与本地都按退出码判定。
 */
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const PAGE = path.join(QA, 'page.html')

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
    if (!fs.existsSync(env)) throw new Error(`DEVA_CHROME_PATH 指向的文件不存在：${env}`)
    return env
  }
  // puppeteer 自带 Chromium（v22+ 的 executablePath 是异步的）
  try {
    const puppeteer = require('puppeteer')
    const p = await puppeteer.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch {
    /* 没装完整版 puppeteer 或浏览器没下载，继续找系统浏览器 */
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

async function main() {
  if (!fs.existsSync(PAGE)) {
    console.error(`没有 ${path.relative(REPO, PAGE)}：先跑 node .deva/qa/insert-attach/build.cjs`)
    process.exit(1)
  }

  const puppeteer = require('puppeteer')
  const exe = await findBrowser()
  if (!exe) {
    console.error(
      '找不到可用的 Chrome / Chromium。设 DEVA_CHROME_PATH 指过去，或安装完整版 puppeteer（自带 Chromium）。'
    )
    process.exit(1)
  }
  console.log(`  browser: ${exe}`)

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    // --no-sandbox 是 CI（容器内 root）跑 Chromium 必需的；--disable-dev-shm-usage 防 /dev/shm 太小
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })

  let code = 1
  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 300))
    })

    await page.goto('file:///' + PAGE.split(path.sep).join('/'), { waitUntil: 'load', timeout: 60000 })

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

    if (!finished) {
      console.log(`\n插话带附件：页面没跑完（title=${JSON.stringify(title)}）`)
      code = 1
    } else if (fail.length) {
      console.log(`\n插话带附件：${pass.length}/${total} 通过，${fail.length} 条失败`)
      for (const f of fail) console.log(`  ✗ ${f}`)
      code = 1
    } else if (total === 0) {
      // 一条用例都没跑 = 测试脚本自己没起来（例如 bundle 崩了），不能算通过
      console.log('\n插话带附件：一条用例都没执行（测试脚本没跑起来）')
      code = 1
    } else {
      console.log(`\n插话带附件：${pass.length}/${total} 全部通过`)
      code = 0
    }
  } finally {
    await browser.close()
  }
  process.exit(code)
}

main().catch((e) => {
  console.error('插话带附件：运行失败 —', e && e.message)
  process.exit(1)
})
