/**
 * 真机截图：`WorktreeRootSetting` 在真实 Electron 窗口里的渲染。
 *
 * ## 为什么不用等价 HTML
 *
 * 「界面」成员用等价 HTML + 产品 CSS 量过（图标/徽标 vs 按钮中心 0.00px、输入框 34px 高、
 * `outline: none`），但 HTML 里没有真实 Electron 的默认焦点环、没有真实的
 * `--fg-muted` / `--fg` 级联、也没有真实 DPI。这里直接在真窗口里截 + 用 CDP 量。
 *
 * ## 做法
 *
 * 1. 用 `--remote-debugging-port` 启动**真实应用**（`out/main/index.js`）
 * 2. 通过 CDP 连到渲染层页面（真实 React 树，不是手搭的）
 * 3. 定位到「设置 › 工作区」，`querySelector` 拿到根目录区块那个 `.cf-set`
 * 4. 用 `Page.captureScreenshot` 的 `clip` 只截该区块（浅色 + `data-theme=dark` 两张）
 * 5. 同一次里用 `Runtime.evaluate` 量：徽标文案、路径颜色、输入框 outline、按钮高度、对齐
 *
 * 隔离完全沿用 run-real.cjs：`DEVA_HOME` 指临时目录、appData/userData 指临时目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(REPO, 'apps', 'desktop', 'out', 'main', 'index.js')
const OUT_DIR = process.env.QA_SHOT_DIR || path.join(QA, 'shots')

const ROOT = process.env.QA_ROOT || path.join(os.tmpdir(), `deva-shot-${Date.now()}`)
const DEVA_HOME = path.join(ROOT, 'deva-home')
const PORT = 9_000 + Math.floor(Math.random() * 900)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
  return res.json()
}

/** 极简 CDP 客户端（够用即可，不引第三方依赖）。Node 22+ 自带全局 WebSocket。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  return { ready, send, close: () => ws.close() }
}

/** 轮询等一个表达式变真（真实渲染有异步）。 */
async function waitFor(cdp, expr, timeoutMs = 25_000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.result?.value) return true
    await sleep(400)
  }
  throw new Error(`等待超时：${label}`)
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate 异常：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`)
  return r.result?.value
}

async function main() {
  fs.mkdirSync(DEVA_HOME, { recursive: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  if (!fs.existsSync(MAIN)) {
    console.error(`缺少构建产物：${MAIN}（先 pnpm -C apps/desktop build）`)
    process.exit(3)
  }

  const env = {
    ...process.env,
    DEVA_HOME,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  console.log(`临时根: ${ROOT}`)
  console.log(`启动真实应用（CDP 端口 ${PORT}）…`)
  const child = spawn(
    ELECTRON,
    [MAIN, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(ROOT, 'appdata')}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/GPU|gpu_|sandbox|DevTools|Fontconfig|libva|Vulkan|d3d11|angle|Network service|disk_cache/i.test(s)) {
      process.stderr.write(s)
    }
  })

  let cdp = null
  try {
    // 等 CDP 起来
    let targets = null
    for (let i = 0; i < 40; i++) {
      try {
        const list = await cdpJson('/json/list')
        const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
        if (page) {
          targets = page
          break
        }
      } catch {}
      await sleep(500)
    }
    if (!targets) throw new Error('CDP 里找不到渲染层页面')
    console.log(`连上页面：${targets.url}`)

    cdp = connect(targets.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 等 React 树渲染完（侧栏出现即算启动完）
    await waitFor(cdp, `!!document.querySelector('.cf-navbtn')`, 30_000, '侧栏渲染')

    // ── 进入 设置 › 工作区 ──
    await evaluate(
      cdp,
      `(() => {
        const btns = [...document.querySelectorAll('button, [role=button], a')];
        const s = btns.find((b) => (b.title || b.getAttribute('aria-label') || '').match(/设置|Settings/i));
        if (!s) return 'no-settings-button';
        s.click();
        return 'clicked';
      })()`
    )
    await waitFor(cdp, `!!document.querySelector('.cf-nav__item')`, 15_000, '设置页渲染')

    const navResult = await evaluate(
      cdp,
      `(() => {
        const items = [...document.querySelectorAll('.cf-nav__item')];
        const w = items.find((x) => /工作区|Worktree/i.test(x.textContent || ''));
        if (!w) return { ok: false, labels: items.map((x) => (x.textContent || '').trim()) };
        w.click();
        return { ok: true, label: (w.textContent || '').trim() };
      })()`
    )
    console.log('导航到工作区:', JSON.stringify(navResult))
    if (!navResult?.ok) throw new Error(`找不到「工作区」导航项：${JSON.stringify(navResult)}`)

    // 等根目录区块出现（组件里用 .cf-set，标题含「根目录」）
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.cf-set')].some((e) => /根目录|Root/i.test(e.textContent || ''))`,
      20_000,
      '根目录区块渲染'
    )

    // ── 量尺寸与颜色（浅色） ──
    const measure = await evaluate(
      cdp,
      `(() => {
        const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
        if (!block) return { error: 'block-not-found' };
        const cs = (el) => el ? getComputedStyle(el) : null;
        const badge = [...block.querySelectorAll('*')].find((e) => /^(默认|Default|已修改|Modified)$/.test((e.textContent || '').trim()));
        const pathEl = [...block.querySelectorAll('*')].find((e) => {
          const t = (e.textContent || '').trim();
          return e.children.length === 0 && /[\\\\/]/.test(t) && t.length > 6;
        });
        const btns = [...block.querySelectorAll('.btn')];
        const btnSm = block.querySelector('.btn--sm');
        const input = block.querySelector('input');
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cy: b.y + b.height / 2 }; };
        return {
          blockRect: r(block),
          badgeText: badge ? (badge.textContent || '').trim() : null,
          badgeRect: r(badge),
          badgeColor: badge ? cs(badge).color : null,
          pathText: pathEl ? (pathEl.textContent || '').trim().slice(0, 120) : null,
          pathColor: pathEl ? cs(pathEl).color : null,
          btnCount: btns.length,
          btnSmHeight: btnSm ? cs(btnSm).height : null,
          btnSmRect: r(btnSm),
          btnLabels: btns.map((b) => (b.textContent || '').trim()),
          inputPresent: !!input,
          inputOutline: input ? cs(input).outline : null,
          inputOutlineColor: input ? cs(input).outlineColor : null,
          inputBoxShadow: input ? cs(input).boxShadow : null,
          inputHeight: input ? cs(input).height : null,
          theme: document.documentElement.getAttribute('data-theme'),
          bodyBg: cs(document.body).backgroundColor
        };
      })()`
    )
    console.log('浅色测量:', JSON.stringify(measure, null, 2))

    // ── 截浅色 ──
    const blockRect = measure.blockRect
    const pad = 8
    const clipLight = {
      x: Math.max(0, blockRect.x - pad),
      y: Math.max(0, blockRect.y - pad),
      width: Math.round(blockRect.w + pad * 2),
      height: Math.round(blockRect.h + pad * 2),
      scale: 2
    }
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: clipLight, captureBeyondViewport: true })
    const fileLight = path.join(OUT_DIR, 'worktree-root-light.png')
    fs.writeFileSync(fileLight, Buffer.from(shot.data, 'base64'))
    console.log(`浅色截图: ${fileLight}`)

    // ── 切深色，再量再截 ──
    await evaluate(cdp, `document.documentElement.setAttribute('data-theme','dark'); true`)
    await sleep(600)
    const measureDark = await evaluate(
      cdp,
      `(() => {
        const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
        const cs = (el) => el ? getComputedStyle(el) : null;
        const badge = [...block.querySelectorAll('*')].find((e) => /^(默认|Default|已修改|Modified)$/.test((e.textContent || '').trim()));
        const pathEl = [...block.querySelectorAll('*')].find((e) => {
          const t = (e.textContent || '').trim();
          return e.children.length === 0 && /[\\\\/]/.test(t) && t.length > 6;
        });
        const btnSm = block.querySelector('.btn--sm');
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cy: b.y + b.height / 2 }; };
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          bodyBg: cs(document.body).backgroundColor,
          badgeColor: badge ? cs(badge).color : null,
          badgeRect: r(badge),
          badgeBg: badge ? cs(badge).backgroundColor : null,
          pathColor: pathEl ? cs(pathEl).color : null,
          btnSmHeight: btnSm ? cs(btnSm).height : null,
          btnSmRect: r(btnSm)
        };
      })()`
    )
    console.log('深色测量:', JSON.stringify(measureDark, null, 2))
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: clipLight, captureBeyondViewport: true })
    const fileDark = path.join(OUT_DIR, 'worktree-root-dark.png')
    fs.writeFileSync(fileDark, Buffer.from(shot.data, 'base64'))
    console.log(`深色截图: ${fileDark}`)

    // ── 编辑态：点「更改」，量输入框焦点环 ──
    const editResult = await evaluate(
      cdp,
      `(() => {
        const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
        const b = [...block.querySelectorAll('.btn')].find((x) => /更改|Change/i.test(x.textContent || ''));
        if (!b) return { ok: false, labels: [...block.querySelectorAll('.btn')].map((x) => (x.textContent || '').trim()) };
        b.click();
        return { ok: true };
      })()`
    )
    console.log('点「更改」:', JSON.stringify(editResult))
    if (editResult?.ok) {
      await sleep(500)
      const focusMeasure = await evaluate(
        cdp,
        `(() => {
          const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
          const input = block && block.querySelector('input');
          if (!input) return { error: 'no-input' };
          input.focus();
          const cs = getComputedStyle(input);
          const focused = document.activeElement === input;
          const r = (el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; };
          return {
            focused,
            outline: cs.outline,
            outlineColor: cs.outlineColor,
            outlineWidth: cs.outlineWidth,
            outlineStyle: cs.outlineStyle,
            boxShadow: cs.boxShadow,
            borderColor: cs.borderColor,
            height: cs.height,
            rect: r(input),
            badgeNow: (() => {
              const bd = [...block.querySelectorAll('*')].find((e) => /^(默认|Default|已修改|Modified)$/.test((e.textContent || '').trim()));
              return bd ? (bd.textContent || '').trim() : null;
            })()
          };
        })()`
      )
      console.log('输入框聚焦测量:', JSON.stringify(focusMeasure, null, 2))
      // 编辑态也截一张
      const blockRect2 = await evaluate(
        cdp,
        `(() => {
          const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
          const b = block.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        })()`
      )
      shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: Math.max(0, blockRect2.x - pad),
          y: Math.max(0, blockRect2.y - pad),
          width: Math.round(blockRect2.w + pad * 2),
          height: Math.round(blockRect2.h + pad * 2),
          scale: 2
        },
        captureBeyondViewport: true
      })
      const fileEdit = path.join(OUT_DIR, 'worktree-root-edit-focus-dark.png')
      fs.writeFileSync(fileEdit, Buffer.from(shot.data, 'base64'))
      console.log(`编辑态（深色，输入框聚焦）截图: ${fileEdit}`)

      // 结果落盘给报告引用
      fs.writeFileSync(
        path.join(OUT_DIR, 'measure.json'),
        JSON.stringify({ light: measure, dark: measureDark, focus: focusMeasure }, null, 2)
      )

      // ── 自定义态：验「路径颜色 var(--fg)」与徽标「已修改」──
      /*
       * 前面两张都是**默认态**，路径色两边当然一样（都是 --fg-muted）。
       * 任务书要的「颜色差异」是默认态 vs 自定义态，所以这里真的设一个自定义根，
       * 让组件重新 load，再量一遍颜色。
       */
      await evaluate(cdp, `document.documentElement.setAttribute('data-theme','light'); true`)
      const setRes = await evaluate(
        cdp,
        `(async () => {
          const p = ${JSON.stringify(path.join(ROOT, 'custom-root'))};
          const r = await window.deva.worktree.setRoot(p);
          return r;
        })()`
      )
      console.log('设自定义根:', JSON.stringify(setRes))
      if (setRes && setRes.ok) {
        // 让组件重新拉 root()：切走再切回工作区
        await evaluate(
          cdp,
          `(() => {
            const items = [...document.querySelectorAll('.cf-nav__item')];
            const g = items.find((x) => /通用|General/i.test(x.textContent || ''));
            if (g) g.click();
            return true;
          })()`
        )
        await sleep(500)
        await evaluate(
          cdp,
          `(() => {
            const items = [...document.querySelectorAll('.cf-nav__item')];
            const w = items.find((x) => /工作区|Worktree/i.test(x.textContent || ''));
            if (w) w.click();
            return true;
          })()`
        )
        await waitFor(
          cdp,
          `[...document.querySelectorAll('.cf-set')].some((e) => /根目录|Root/i.test(e.textContent || ''))`,
          15_000,
          '自定义态根目录区块'
        )
        await sleep(500)
        const measureCustom = await evaluate(
          cdp,
          `(() => {
            const block = [...document.querySelectorAll('.cf-set')].find((e) => /根目录|Root/i.test(e.textContent || ''));
            const cs = (el) => el ? getComputedStyle(el) : null;
            const badge = [...block.querySelectorAll('*')].find((e) => /^(默认|Default|已修改|Modified)$/.test((e.textContent || '').trim()));
            const pathEl = [...block.querySelectorAll('*')].find((e) => {
              const t = (e.textContent || '').trim();
              return e.children.length === 0 && /[\\\\/]/.test(t) && t.length > 6;
            });
            const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cy: b.y + b.height / 2 }; };
            return {
              theme: document.documentElement.getAttribute('data-theme'),
              badgeText: badge ? (badge.textContent || '').trim() : null,
              badgeColor: badge ? cs(badge).color : null,
              badgeRect: r(badge),
              pathText: pathEl ? (pathEl.textContent || '').trim().slice(0, 140) : null,
              pathColor: pathEl ? cs(pathEl).color : null,
              btnSmHeight: block.querySelector('.btn--sm') ? cs(block.querySelector('.btn--sm')).height : null,
              btnSmRect: r(block.querySelector('.btn--sm')),
              blockRect: r(block),
              // 「恢复默认」在自定义态应当可点（默认态是 disabled）
              resetDisabled: (() => {
                const b = [...block.querySelectorAll('.btn')].find((x) => /恢复默认|Restore/i.test(x.textContent || ''));
                return b ? b.disabled : null;
              })()
            };
          })()`
        )
        console.log('自定义态测量:', JSON.stringify(measureCustom, null, 2))
        const cRect = measureCustom.blockRect
        shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: Math.max(0, cRect.x - pad),
            y: Math.max(0, cRect.y - pad),
            width: Math.round(cRect.w + pad * 2),
            height: Math.round(cRect.h + pad * 2),
            scale: 2
          },
          captureBeyondViewport: true
        })
        const fileCustom = path.join(OUT_DIR, 'worktree-root-custom-light.png')
        fs.writeFileSync(fileCustom, Buffer.from(shot.data, 'base64'))
        console.log(`自定义态（浅色）截图: ${fileCustom}`)

        const prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'measure.json'), 'utf8'))
        prev.custom = measureCustom
        fs.writeFileSync(path.join(OUT_DIR, 'measure.json'), JSON.stringify(prev, null, 2))
      }
    }
  } finally {
    try {
      cdp?.close()
    } catch {}
    try {
      child.kill()
    } catch {}
    await sleep(800)
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

main()
  .then(() => {
    console.log('\n截图完成')
    process.exit(0)
  })
  .catch((e) => {
    console.error('\n截图失败:', e.message)
    process.exit(1)
  })