/**
 * 流式滚动 —— 修复验证（S1~S10）。
 *
 * 挂**真实的 `Conversation`**，用受控 messages 演出流式追加，逐条验：
 * 跟随是否稳定、上滚是否立刻脱离、补段是否锚住画面、键盘/拖条/输入框的边界。
 *
 * 判据只认 DOM 与 scrollTop 轨迹，不看源码字符串。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CASES = []
const ok = (name, fn) => CASES.push({ name, fn })
function assert(c, m) {
  if (!c) throw new Error(m)
}
async function waitFor(fn, msg, ms = 4000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`超时：${msg}`)
    await sleep(20)
  }
}

let seq = 0
const mkMsg = (role, text) => ({ id: `m${++seq}`, role, blocks: text ? [{ kind: 'text', text, id: `b${seq}` }] : [] })
function history(turns) {
  const out = []
  for (let i = 0; i < turns; i++) {
    out.push(mkMsg('user', `第 ${i + 1} 个问题：${'说明文字 '.repeat(6)}`))
    out.push(mkMsg('assistant', `第 ${i + 1} 个回答。\n\n${'这是一段比较长的正文，用来把内容撑高。'.repeat(10)}`))
  }
  return out
}

const scroller = () => document.querySelector('.cf-msgs')
const jumpBtn = () =>
  document.querySelector('.cf-jump') ||
  [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === '回到最新' || b.getAttribute('title') === '回到最新'
  )

/** 当前视野顶部那条消息的 id 与它是第几个问题。 */
function topInfo() {
  const el = scroller()
  if (!el) return null
  const vTop = el.getBoundingClientRect().top
  for (const n of el.querySelectorAll('[data-msg-id]')) {
    if (n.getBoundingClientRect().bottom > vTop + 1) {
      const txt = (n.textContent ?? '').replace(/\s+/g, ' ')
      const m = txt.match(/第 (\d+) 个/)
      return { id: n.dataset.msgId, turn: m ? Number(m[1]) : null }
    }
  }
  return null
}
/** 某条消息相对滚动容器视口顶的偏移（px）；不在 DOM 里返回 null。 */
function offsetOf(id) {
  const el = scroller()
  const n = id ? el?.querySelector(`[data-msg-id="${id}"]`) : null
  if (!el || !n) return null
  return Math.round(n.getBoundingClientRect().top - el.getBoundingClientRect().top)
}

function pos() {
  const el = scroller()
  return el
    ? {
        top: Math.round(el.scrollTop),
        h: Math.round(el.scrollHeight),
        dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        msgs: el.querySelectorAll('[data-msg-id]').length
      }
    : null
}

let msgs = []
/** 追加一拍流式正文（像 store 的 updateLastAssistant：只换 blocks，id 不变）。 */
function tick(i) {
  const last = msgs[msgs.length - 1]
  last.blocks = [{ kind: 'text', id: last.blocks[0]?.id ?? 'bx', text: `第 ${i} 段：${'流式正文内容。'.repeat(12)}` }]
  window.__setChat({ messages: [...msgs], streaming: true })
}

/** 铺 N 轮历史 + 起一轮流式，并滚到底。 */
async function setup(turns = 20) {
  window.__mountConv()
  await sleep(250)
  const el = scroller()
  msgs = history(turns)
  window.__setChat({ messages: msgs, streaming: false })
  await sleep(250)
  el.scrollTop = el.scrollHeight
  await sleep(150)
  msgs.push(mkMsg('user', '现在请写一段很长的回答'))
  msgs.push(mkMsg('assistant', ''))
  window.__setChat({ messages: [...msgs], streaming: true })
  for (let i = 1; i <= 3; i++) {
    tick(i)
    await sleep(40)
  }
  return el
}

/** 派一个真实 wheel 事件（deltaY 负 = 向上滚），然后再手动应用位移模拟浏览器默认行为。 */
function wheelUp(el, px = 120) {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -px, bubbles: true, cancelable: true }))
  el.scrollTop = Math.max(0, el.scrollTop - px)
}

// ═══════════════════════════════════════════════════════════════
// S1 流式输出中不上滚：稳定跟随到底
// ═══════════════════════════════════════════════════════════════
ok('S1 流式输出中持续不上滚 → 稳定跟随到底', async () => {
  await setup(20)
  const trace = []
  for (let i = 4; i <= 24; i++) {
    tick(i)
    await sleep(40)
    trace.push(pos())
  }
  const maxDist = Math.max(...trace.map((p) => p.dist))
  log(`  S1 dist 轨迹：${trace.map((p) => p.dist).join(',')}`)
  assert(maxDist <= 2, `全程应贴底（dist<=2），实测最大 dist=${maxDist}`)
})

// ═══════════════════════════════════════════════════════════════
// S2 上滚 → 立即停止跟随
// ═══════════════════════════════════════════════════════════════
ok('S2 流式输出中上滚 → 立即停止跟随（位置不动、不跳变）', async () => {
  const el = await setup(20)
  const before = pos()
  wheelUp(el, 200)
  await sleep(200)
  const afterUp = pos()
  log(`  S2 上滚前 ${JSON.stringify(before)} → 上滚后 ${JSON.stringify(afterUp)}`)
  assert(afterUp.top < before.top, '上滚后 scrollTop 应变小')
  // 继续输出，位置必须纹丝不动
  const settle = pos()
  for (let i = 4; i <= 14; i++) {
    tick(i)
    await sleep(40)
  }
  const after = pos()
  log(`  S2 继续输出 10 拍后 ${JSON.stringify(after)}（基准 top=${settle.top}）`)
  assert(
    Math.abs(after.top - settle.top) <= 2,
    `上滚后位置应纹丝不动（基准 ${settle.top}），实测 ${after.top}`
  )
  assert(jumpBtn(), '上滚后应出现「回到最新」按钮')
})

// ═══════════════════════════════════════════════════════════════
// S3 上滚后继续输出：位置不动
// ═══════════════════════════════════════════════════════════════
ok('S3 上滚后继续输出 → 位置纹丝不动（dist 只增不减）', async () => {
  const el = await setup(20)
  wheelUp(el, 300)
  await sleep(150)
  const base = pos()
  const dists = []
  for (let i = 4; i <= 18; i++) {
    tick(i)
    await sleep(40)
    dists.push(pos().dist)
  }
  log(`  S3 dist 轨迹：${base.dist} → ${dists.join(',')}`)
  assert(
    dists.every((d) => d >= base.dist - 2),
    '未贴底时继续输出，距底距离只应增大（内容在下方变长），不该被拽回'
  )
  assert(Math.abs(pos().top - base.top) <= 2, `top 应不动：${base.top} → ${pos().top}`)
})

// ═══════════════════════════════════════════════════════════════
// S4 自己滚回底部 → 恢复跟随
// ═══════════════════════════════════════════════════════════════
ok('S4 上滚后自己滚回底部 → 恢复跟随', async () => {
  const el = await setup(20)
  wheelUp(el, 300)
  await sleep(150)
  // 自己滚回最底
  el.scrollTop = el.scrollHeight
  await sleep(150)
  const base = pos()
  log(`  S4 滚回底部后 ${JSON.stringify(base)}`)
  assert(base.dist <= 2, '应已贴底')
  for (let i = 4; i <= 12; i++) {
    tick(i)
    await sleep(40)
  }
  const after = pos()
  log(`  S4 再输出 9 拍后 ${JSON.stringify(after)}`)
  assert(after.dist <= 2, `应恢复跟随（dist<=2），实测 ${after.dist}`)
})

// ═══════════════════════════════════════════════════════════════
// S5 点「回到最新」→ 回到底并恢复跟随
// ═══════════════════════════════════════════════════════════════
ok('S5 点「回到最新」→ 回到底并恢复跟随', async () => {
  const el = await setup(20)
  wheelUp(el, 400)
  await sleep(150)
  const btn = await waitFor(jumpBtn, '没有「回到最新」按钮')
  btn.click()
  await sleep(500) // 平滑滚动
  const afterClick = pos()
  log(`  S5 点按钮后 ${JSON.stringify(afterClick)}`)
  assert(afterClick.dist <= 2, `应已回到底（dist<=2），实测 ${afterClick.dist}`)
  for (let i = 4; i <= 10; i++) {
    tick(i)
    await sleep(40)
  }
  assert(pos().dist <= 2, '应恢复跟随')
})

// ═══════════════════════════════════════════════════════════════
// S6 上滚到接近顶部（触发补段）→ 位置保持（核心）
// ═══════════════════════════════════════════════════════════════
ok('S6 上滚触发补段（底部同时在长）→ 补偿只跟上方插入量（核心）', async () => {
  const el = await setup(20)
  /*
   * 这一版把「上方插入量」单独量出来，这是唯一能区分两种落位算法的基准：
   *
   *  上方插入量 = 锚点元素的 offsetTop 在补段前后的变化（它上方只多了补进来的那 10 轮）
   *  总增高     = scrollHeight 的变化（上方插入 + 底部新增）
   *
   *  - 元素锚点：scrollTop 位移 ≈ **上方插入量**
   *  - 距底距离：scrollTop 位移 ≈ **总增高**（把底部那份也算进补偿，画面被往下推）
   *
   * 上一版拿「总增高」当基准，而补段与追加在同一批更新里完成、两者数值又接近，所以测不出差别。
   */
  el.scrollTop = 1200
  await sleep(300)
  const before = pos()
  const anchorId = topInfo()?.id
  const offsetTopOf = (id) => {
    const n = id ? el.querySelector(`[data-msg-id="${id}"]`) : null
    if (!n) return null
    // offsetTop 相对 .cf-msgs__inner（offsetParent），上方插进内容它就变大。
    return Math.round(n.getBoundingClientRect().top - el.querySelector('.cf-msgs__inner').getBoundingClientRect().top)
  }
  const aBefore = offsetTopOf(anchorId)
  log(`  S6 补段前 ${JSON.stringify(before)} 锚点=${anchorId} offsetTop=${aBefore}`)

  // 滚进门槛 + 底部同时追加一大块
  el.scrollTop = 40
  msgs.push(mkMsg('assistant', 'S6 追加的一大段内容。'.repeat(120)))
  window.__setChat({ messages: [...msgs], streaming: true })
  await sleep(450)

  const after = pos()
  const aAfter = offsetTopOf(anchorId)
  const moved = after.top - 40
  const grew = after.h - before.h
  const insertedAbove = aAfter !== null && aBefore !== null ? aAfter - aBefore : null
  log(`  S6 补段后 ${JSON.stringify(after)}（视野顶部=${JSON.stringify(topInfo())}）`)
  log(`  S6 锚点 offsetTop：${aBefore} → ${aAfter}（上方插入 ${insertedAbove}px）`)
  log(`  S6 位移=${moved}px；总增高=${grew}px；上方插入=${insertedAbove}px`)
  log(`  S6 差值：位移-上方插入=${insertedAbove !== null ? moved - insertedAbove : '?'}px（元素锚点应≈0）`)
  log(`  S6 差值：位移-总增高=${moved - grew}px（距底距离版本会≈0，且方向偏下）`)

  assert(after.msgs > before.msgs, `应补进更早的消息：${before.msgs} → ${after.msgs}`)
  assert(insertedAbove !== null && insertedAbove > 100, `应真的补进内容：上方插入 ${insertedAbove}px`)
  assert(
    Math.abs(moved - insertedAbove) <= 3,
    `补偿应只跟上方插入量：位移 ${moved} vs 上方插入 ${insertedAbove}`
  )
})

// ═══════════════════════════════════════════════════════════════
// S7 键盘 PageUp / ArrowUp 上滚 → 同 S2
// ═══════════════════════════════════════════════════════════════
ok('S7 键盘 PageUp / ArrowUp 上滚 → 同 S2（立即脱离）', async () => {
  const el = await setup(20)
  // 先在贴底态下按 PageUp：光标已在最底，这一次按键本身不产生位移，
  // 但「用户想往上看」的意图必须被认下来（这正是 dist===0 不能当作「想回到底部」的场景）。
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  await sleep(150)
  assert(jumpBtn(), 'PageUp 后应立刻脱离跟随（出现「回到最新」按钮）')
  const base = pos()
  // 脱离之后继续输出：位置必须不动（与 S2 同一判据）
  for (let i = 4; i <= 12; i++) {
    tick(i)
    await sleep(40)
  }
  const after = pos()
  log(`  S7 PageUp 后 ${JSON.stringify(base)} → 输出 9 拍后 ${JSON.stringify(after)}`)
  // 关键：脱离状态必须保持住（按钮还在），且位置没被拽走
  assert(jumpBtn(), 'PageUp 脱离后继续输出，仍应保持脱离（按钮还在）')
  assert(Math.abs(after.top - base.top) <= 2, `位置应不动：${base.top} → ${after.top}`)

  // ArrowUp 同效
  const el2 = await setup(20)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await sleep(150)
  assert(jumpBtn(), 'ArrowUp 后也应脱离跟随')
  log(`  S7 ArrowUp 后 ${JSON.stringify(pos())}`)
  void el2
})

// ═══════════════════════════════════════════════════════════════
// S8 拖滚动条上移 → 同 S2（兜底路径）
// ═══════════════════════════════════════════════════════════════
ok('S8 拖滚动条上移 → 同 S2（兜底路径：方向判断）', async () => {
  const el = await setup(20)
  // 拖滚动条不走 wheel/touch/key，只有 scroll 事件
  el.scrollTop = Math.max(0, el.scrollTop - 500)
  await sleep(150)
  const base = pos()
  for (let i = 4; i <= 10; i++) {
    tick(i)
    await sleep(40)
  }
  const after = pos()
  log(`  S8 拖条后 ${JSON.stringify(base)} → 输出后 ${JSON.stringify(after)}`)
  assert(after.dist > 10, `拖条上移后应脱离跟随，实测 ${after.dist}`)
})

// ═══════════════════════════════════════════════════════════════
// S9 在输入框里按 ArrowUp → 不触发脱离
// ═══════════════════════════════════════════════════════════════
ok('S9 在输入框里按 ArrowUp → 不触发脱离（那是编辑文字）', async () => {
  await setup(20)
  const box = document.querySelector('.cf-composer .cf-draft [contenteditable="true"]')
  assert(box, '找不到输入框')
  box.focus()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await sleep(120)
  const base = pos()
  for (let i = 4; i <= 10; i++) {
    tick(i)
    await sleep(40)
  }
  const after = pos()
  log(`  S9 输入框 ArrowUp 后 ${JSON.stringify(base)} → 输出后 ${JSON.stringify(after)}`)
  assert(after.dist <= 2, `输入框里按 ArrowUp 不该脱离跟随（应仍贴底），实测 dist=${after.dist}`)
})

// ═══════════════════════════════════════════════════════════════
// S10 高度变化（滚动条出现/消失）不跳变
// ═══════════════════════════════════════════════════════════════
ok('S10 内容高度大幅变化 → 贴底时不跳变', async () => {
  const el = await setup(20)
  const base = pos()
  // 追加一大段内容（模拟一次大 chunk）
  const last = msgs[msgs.length - 1]
  last.blocks = [{ kind: 'text', id: 'big', text: '一大段内容。'.repeat(200) }]
  window.__setChat({ messages: [...msgs], streaming: true })
  await sleep(150)
  const after = pos()
  log(`  S10 大 chunk 前 ${JSON.stringify(base)} → 后 ${JSON.stringify(after)}`)
  assert(after.dist <= 2, `贴底态下大 chunk 后仍应贴底，实测 ${after.dist}`)
})

// ── 运行 ────────────────────────────────────────────────────────
async function main() {
  let pass = 0
  const fails = []
  for (const c of CASES) {
    try {
      await c.fn()
      pass++
      log(`PASS ${c.name}`)
    } catch (e) {
      fails.push(`${c.name} → ${e.message}`)
      log(`FAIL ${c.name} → ${e.message}`)
    }
  }
  log(`==RESULT== ${pass}/${CASES.length} PASS`)
  for (const f of fails) log(`  ✗ ${f}`)
  document.title = `DONE ${pass}/${CASES.length}`
}

main().catch((e) => {
  log(`FATAL ${e && (e.stack || e.message)}`)
  document.title = 'DONE FATAL'
})