/**
 * A11/A28 真机 DOM 探针：根外徽标与引导句在**真实 Electron 窗口**里到底渲不渲染。
 *
 * ## 为什么还要这一份（真机主进程那份不够吗）
 *
 * `run-real.cjs` 的 `inside-root` 阶段证明了主进程在三种记录下给的字段是对的
 * （`true` / `false` / 不给）。但那只到 IPC 边界为止：
 * 「字段对了、`WorktreePane` 却没渲染出来」这类问题它一点都拦不住——
 * 例如 `view.insideRoot === false && null`、或者渲染被 `.cf-wt` 容器裁掉。
 * 所以这里推到最后一厘米：真实 React 树里 `document.querySelector` 出那个徽标。
 *
 * ## 三态都要在真窗口里走一遍
 *
 * 主进程靠「不给字段」表达无法判断。渲染层只要写成真值判断，
 * `undefined` 就会掉进根外分支，把所有历史记录误标——而开发机上几乎都是新记录，
 * 只看「有徽标」永远发现不了。这里三态各渲一次，`undefined` 那态**必须没有徽标**。
 *
 * ## 隔离
 *
 * 完全沿用 `run-real.cjs` / `shot.cjs`：`DEVA_HOME` 与 appData/userData 全指临时目录，
 * 结束时只删自己建的那一个临时根。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(REPO, 'apps', 'desktop', 'out', 'main', 'index.js')

const ROOT = process.env.QA_ROOT || path.join(os.tmpdir(), `deva-domroot-${Date.now()}`)
const DEVA_HOME = path.join(ROOT, 'deva-home')
const PORT = 9_500 + Math.floor(Math.random() * 400)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
let passes = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    passes++
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`)
  } else {
    fails++
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}
const info = (label, value) => console.log(`INFO ${label} :: ${value}`)

async function cdpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
  return res.json()
}

/** 最小 CDP 客户端（Node 22+ 自带 WebSocket，用 addEventListener 而非 ws.on） */
function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error(`CDP socket error: ${e?.message ?? e}`)))
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
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
  return {
    ready,
    send(method, params = {}) {
      const myId = ++id
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject })
        ws.send(JSON.stringify({ id: myId, method, params }))
      })
    },
    close() {
      try {
        ws.close()
      } catch {}
    }
  }
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) {
    throw new Error(`evaluate 抛异常：${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description ?? '')}`)
  }
  return res.result?.value
}

async function waitFor(cdp, expr, timeoutMs = 25_000, label = expr) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expr)) return true
    await sleep(250)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 写入三态夹具。
 *
 * 关键：`store.ts` 的 `ensureLoaded()` 在模块首次使用时把 worktrees.json 读进内存，
 * 所以在**启动 Electron 之前**必须写好；中途改文件应用看不见。
 *
 * 另一条同样关键：光写 worktrees.json 不够 —— `listWorktrees()` 对每条记录都要去
 * `git worktree list --porcelain` 里找它，找不到就不出卡片（只进 `unmanaged` 反向）。
 * 所以三个目录必须真的是 `git worktree add` 出来的，否则界面是空态，
 * 所有 DOM 断言都变成「没跑」而不是「通过」。第一版就栽在这里。
 */
function seedFor(state, paths) {
  fs.rmSync(DEVA_HOME, { recursive: true, force: true })
  fs.mkdirSync(DEVA_HOME, { recursive: true })

  const rec = (p, branch, createdUnderRoot) => ({
    path: p,
    compareKey: path.relative(DEVA_HOME, p).replace(/\\/g, '/').toLowerCase(),
    branch,
    baseSha: '0000000000000000000000000000000000000000',
    phase: 'active',
    repoRoot: REPO,
    baseBranch: 'dev',
    createdAt: Date.now(),
    ...(createdUnderRoot === undefined ? {} : { createdUnderRoot })
  })

  const records = [
    rec(paths.inside, 'probe-inside', paths.rootDir),
    rec(paths.outside, 'probe-outside', paths.rootDir),
    // 老记录：字段整个缺席，主进程应表达「无法判断」
    rec(paths.legacy, 'probe-legacy')
  ]
  fs.writeFileSync(path.join(DEVA_HOME, 'worktrees.json'), JSON.stringify({ schemaVersion: 1, records }, null, 2))
  info(`夹具(${state})`, `inside=${paths.inside} outside=${paths.outside} legacy=${paths.legacy}（无 createdUnderRoot）`)
}

/** 用真实 git worktree add 造三个检出，返回它们的路径 */
function makeWorktrees() {
  const rootDir = path.join(ROOT, 'worktrees')
  fs.mkdirSync(rootDir, { recursive: true })
  const inside = path.join(rootDir, 'probe-inside')
  const legacy = path.join(rootDir, 'probe-legacy')
  const outside = path.join(ROOT, 'elsewhere', 'probe-outside')
  fs.mkdirSync(path.dirname(outside), { recursive: true })

  const run = (args) => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
    return r.stdout
  }
  // detached：不占分支名，跑完直接 remove
  for (const [dir, label] of [
    [inside, 'probe-inside'],
    [legacy, 'probe-legacy'],
    [outside, 'probe-outside']
  ]) {
    fs.rmSync(dir, { recursive: true, force: true })
    run(['worktree', 'add', '--detach', dir, 'HEAD'])
    info(`git worktree add OK（${label}）`, dir)
  }
  return { rootDir, inside, outside, legacy }
}

function cleanupWorktrees(paths) {
  for (const p of [paths.inside, paths.outside, paths.legacy]) {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', p], { cwd: REPO, encoding: 'utf8' })
    } catch {}
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {}
  }
  try {
    spawnSync('git', ['worktree', 'prune'], { cwd: REPO, encoding: 'utf8' })
  } catch {}
}

/** 起一轮真机，进「工作区」页，回报三条卡片各自的徽标/引导句状态 */
async function probeOnce(state, paths) {
  seedFor(state, paths)

  const env = { ...process.env, DEVA_HOME, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
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
  const result = { badges: [], notes: [], text: '', raw: [] }
  try {
    let page = null
    for (let i = 0; i < 60; i++) {
      try {
        const list = await cdpJson('/json/list')
        const hit = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
        if (hit) {
          page = hit
          break
        }
      } catch {}
      await sleep(500)
    }
    if (!page) throw new Error('CDP 里找不到渲染层页面')

    cdp = connect(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 等 React 树起来
    await waitFor(cdp, `!!document.querySelector('.cf-navbtn')`, 30_000, '侧栏渲染')

    // 进「设置 › 工作区」
    const clicked = await evaluate(
      cdp,
      `(() => {
        const s = [...document.querySelectorAll('button, [role=button], a')]
          .find((b) => (b.title || b.getAttribute('aria-label') || '').match(/设置|Settings/i));
        if (!s) return 'no-settings-button';
        s.click();
        return 'clicked';
      })()`
    )
    if (clicked !== 'clicked') throw new Error(`找不到设置入口：${clicked}`)

    // 设置是 modal，进来后默认在「通用」；要点左侧导航切到「工作区」才会有 WorktreePane
    await waitFor(cdp, `!!document.querySelector('.cf-nav__item')`, 20_000, '设置导航')
    const navHit = await evaluate(
      cdp,
      `(() => {
        const items = [...document.querySelectorAll('.cf-nav__item')];
        const w = items.find((el) => /工作区|Worktree/i.test(el.textContent || ''));
        if (!w) return 'no-worktree-nav:' + items.map((i) => (i.textContent || '').trim()).join('|');
        w.click();
        return 'clicked';
      })()`
    )
    if (navHit !== 'clicked') throw new Error(`切不到工作区分区：${navHit}`)

    // 等工作区页渲染出卡片
    await waitFor(cdp, `!!document.querySelector('.cf-wt')`, 25_000, '工作区页容器')
    /*
     * 等**加载完成**：`.cf-wt` 在 loading 时也会渲染，`.cf-wt__list` 也是（只是没子节点）。
     * 真正的完成信号是三者之一：有卡片 / 出空态 / 出错。
     * 只等容器会出现「读到中间态 → 断言 0 张 → 假红」。
     */
    await waitFor(
      cdp,
      `(() => {
        const list = document.querySelector('.cf-wt__list');
        return !!list && (list.children.length > 0 || !!document.querySelector('.cf-wt__empty') || !!document.querySelector('.cf-wt__err'));
      })()`,
      30_000,
      '工作区列表加载完成（有卡片或空态）'
    )

    /*
     * 逐张卡片取：徽标是否在、引导句是否在。
     * 不按卡片顺序硬编码期望，改成按分支名（`probe-inside` / `probe-outside` / `probe-legacy`）
     * 找对应卡片 —— 主进程返回顺序不等于界面渲染顺序。
     */
    const snap = await evaluate(
      cdp,
      `(() => {
        const list = document.querySelector('.cf-wt__list');
        const out = [];
        const cards = list ? [...list.children] : [];
        for (const el of cards) {
          const txt = (el.innerText || '').replace(/\\s+/g, ' ');
          const branch = ['probe-inside', 'probe-outside', 'probe-legacy'].find((b) => txt.includes(b));
          if (!branch) continue;
          const badge = el.querySelector('.cf-wt__badge');
          const note = el.querySelector('.cf-wt__note');
          out.push({
            branch,
            badge: !!badge,
            note: !!note,
            badgeText: badge ? (badge.textContent || '').trim() : '',
            noteText: note ? (note.textContent || '').trim() : ''
          });
        }
        const pane = document.querySelector('.cf-wt');
        return {
          cards: out,
          listFound: !!list,
          listChildren: cards.length,
          paneText: pane ? pane.innerText.replace(/\\s+/g, ' ').slice(0, 600) : ''
        };
      })()`
    )
    info('DOM 状态', JSON.stringify({ listFound: snap?.listFound, listChildren: snap?.listChildren }))
    info('面板文字', snap?.paneText ?? '')

    result.raw = snap?.cards ?? []
    for (const c of result.raw) {
      if (c.badge) result.badges.push(c.branch)
      if (c.note) result.notes.push(c.branch)
    }
    result.text = JSON.stringify(result.raw)
  } finally {
    try {
      cdp?.close()
    } catch {}
    child.kill('SIGKILL')
    await sleep(800)
  }
  return result
}

async function main() {
  if (!fs.existsSync(MAIN)) {
    console.error(`缺少构建产物：${MAIN}（先 pnpm build）`)
    process.exit(3)
  }
  fs.mkdirSync(ROOT, { recursive: true })
  info('临时根', ROOT)
  info('DEVA_HOME', DEVA_HOME)

  const paths = makeWorktrees()
  try {
    const r = await probeOnce('threestate', paths)
    info('卡片快照', r.text)

    check('D0. 三条夹具卡片都渲染出来（否则下面等于没跑）', r.raw.length === 3, `实际=${r.raw.length} 张 ${r.text}`)

    const has = (b) => r.raw.find((c) => c.branch === b)
    const inside = has('probe-inside')
    const outside = has('probe-outside')
    const legacy = has('probe-legacy')

    check('D1. 根内记录：不显示徽标', inside !== undefined && inside.badge === false, JSON.stringify(inside))
    check('D2. 根内记录：不显示引导句', inside !== undefined && inside.note === false, JSON.stringify(inside))

    check('D3. 根外记录：**显示**徽标', outside !== undefined && outside.badge === true, JSON.stringify(outside))
    check('D4. 根外记录：**显示**引导句', outside !== undefined && outside.note === true, JSON.stringify(outside))
    check(
      'D5. 根外徽标文案是「不在当前根内」',
      outside !== undefined && /不在当前根内|Outside current root/.test(outside.badgeText),
      `badgeText=${JSON.stringify(outside?.badgeText)}`
    )
    check(
      'D6. 引导句说明不能新建且给出改根出路',
      outside !== undefined && /此处不能新建/.test(outside.noteText) && /改根目录/.test(outside.noteText),
      `noteText=${JSON.stringify(outside?.noteText)}`
    )

    /* 第三态：老记录。这一态是本轮全部风险所在 */
    check(
      'D7. 老记录（无 createdUnderRoot）：**不显示**徽标 —— 写 !insideRoot 会在这里失败',
      legacy !== undefined && legacy.badge === false,
      JSON.stringify(legacy)
    )
    check('D8. 老记录：**不显示**引导句', legacy !== undefined && legacy.note === false, JSON.stringify(legacy))

    /* 措辞禁忌：不得用「非法 / 无效」 */
    const allText = r.raw.map((c) => `${c.badgeText}${c.noteText}`).join(' ')
    check('D9. 文案不含「非法 / 无效」措辞', !/非法|无效/.test(allText), allText)
  } finally {
    cleanupWorktrees(paths)
  }

  console.log(`\n===== 汇总：PASS=${passes} FAIL=${fails} =====`)
  return fails === 0 ? 0 : 1
}

main()
  .then((code) => {
    if (!process.env.QA_KEEP) {
      try {
        fs.rmSync(ROOT, { recursive: true, force: true })
        console.log(`已清理临时目录: ${ROOT}`)
      } catch (e) {
        console.log(`清理失败（请手动删）: ${ROOT} —— ${e.message}`)
      }
    } else {
      console.log(`（QA_KEEP=1，保留 ${ROOT}）`)
    }
    process.exit(code)
  })
  .catch((e) => {
    console.error(e)
    process.exit(3)
  })
