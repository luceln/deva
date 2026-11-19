/**
 * 插话带附件 —— 浏览器内驱动**真实 Composer**。
 *
 * 判据只认 DOM 与桩记录的入参；核心是证明「回合进行中，贴进来的图确实随插话交出去了」，
 * 而不是只看到界面上有个 chip。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}

const CASES = []
const ok = (name, fn) => CASES.push({ name, fn })
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, msg, timeoutMs = 3000) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = fn()
    } catch {
      v = false
    }
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时：${msg}`)
    await sleep(25)
  }
}

/** 造一个 File（截图），交给粘贴 / 拖入路径。 */
function pngFile(name = 'shot.png') {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return new File([bytes], name, { type: 'image/png' })
}

/** 走到「回合进行中」的输入框。 */
async function mountStreaming(extra = {}) {
  window.__resetChat()
  window.__setChat({ streaming: true })
  window.__mount({ streaming: true, ...extra })
  await waitFor(() => document.querySelector('.cf-composer'), '输入框没挂上')
  await ready()
}

/**
 * 派发一次「粘贴文件」到编辑器。
 *
 * 粘贴走 Lexical 的 `PASTE_COMMAND`，它监听的是 contentEditable（`.cf-draft [contenteditable]`），
 * 不是 window——派到 window 上 Composer 根本收不到。`ClipboardEvent` 构造器不接受 clipboardData
 * （只读属性），故建好后用 defineProperty 挂上去。
 */
function pasteFile(file) {
  const rootEl = document.querySelector('.cf-composer .cf-draft [contenteditable="true"]')
  if (!rootEl) throw new Error('找不到编辑器 contentEditable')
  const dt = new DataTransfer()
  dt.items.add(file)
  const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: dt })
  rootEl.dispatchEvent(ev)
}

/**
 * 挂载后把编辑器「点亮」：Lexical 的命令在 effect 里注册，且首次 `setRootElement` 之后
 * 才真正接管 keydown/paste。首帧就派发事件会赶在它前面（实测量到过）。
 * 这里发一次无害的 input 焦点动作并等两拍，让后续事件稳定被接住。
 */
async function ready() {
  const rootEl = document.querySelector('.cf-composer .cf-draft [contenteditable="true"]')
  if (rootEl) rootEl.focus()
  await sleep(250)
}

/** 点「附加文件」并等附件进条。 */
async function pickFile(file) {
  window.deva.__pick = [
    {
      path: `C:\\tmp\\deva-pick\\${file.name}`,
      name: file.name,
      ext: file.name.split('.').pop(),
      size: 8,
      kind: 'image',
      supported: true
    }
  ]
  const btn = [...document.querySelectorAll('.cf-composer button')].find(
    (b) => b.getAttribute('aria-label') === '附加文件'
  )
  assert(btn, '找不到「附加文件」按钮')
  btn.click()
  await sleep(80)
}

/** 附件 chip 节点。 */
const chips = () => [...document.querySelectorAll('.cf-composer .cf-composer__files > *')]

/** 「发送」键（回合进行中即「插入当前轮」）。 */
const sendBtn = () => document.querySelector('.cf-composer .cf-send')

// ── 用例 ─────────────────────────────────────────────────────────

ok('回合进行中：粘贴图片能进输入框（旧行为是直接丢弃）', async () => {
  await mountStreaming()
  window.deva.__pasted.length = 0
  pasteFile(pngFile('shot.png'))
  await waitFor(() => window.deva.__pasted.length > 0, '没有走粘贴落盘链路')
  await waitFor(() => chips().length > 0, '粘贴的图没进附件条')
  eq(window.deva.__pasted[0].name, 'shot.png', '粘贴的文件名')
})

ok('回合进行中：附件条上出现「随这条插话带进去」的说明', async () => {
  const note = await waitFor(() => document.querySelector('.cf-attach__insertnote'), '没有插话附件说明')
  assert(/附件/.test(note.textContent), `说明文案不对：${note.textContent}`)
})

ok('只有附件、没有正文也能插话，且附件随请求交出', async () => {
  window.__calls.insert.length = 0
  const btn = sendBtn()
  assert(btn, '找不到发送键')
  btn.click()
  await waitFor(() => window.__calls.insert.length > 0, '没有调用 insert')
  const call = window.__calls.insert[0]
  eq(call.text, '', '正文应为空（本用例只贴图）')
  assert(
    Array.isArray(call.attachments) && call.attachments.length === 1,
    `附件应带 1 项，实际 ${JSON.stringify(call.attachments)}`
  )
  assert(typeof call.attachments[0].path === 'string' && call.attachments[0].path.length > 0, '附件应带绝对路径')
})

ok('回合进行中：点「附加文件」也能加图（不只粘贴）', async () => {
  await mountStreaming()
  await pickFile(pngFile('picked.png'))
  await waitFor(() => chips().length > 0, '选的文件没进附件条')
  window.__calls.insert.length = 0
  sendBtn().click()
  await waitFor(() => window.__calls.insert.length > 0, '没有调用 insert')
  const call = window.__calls.insert[0]
  assert(Array.isArray(call.attachments) && call.attachments.length === 1, '选的文件应随插话交出')
  assert(/picked\.png$/.test(call.attachments[0].path), `路径不对：${call.attachments[0].path}`)
})

ok('插话成功后输入框与附件条清空（不残留，也不重复发）', async () => {
  await waitFor(() => chips().length === 0, '插入后附件条没清空')
})

ok('插话失败 → 正文与附件一起放回输入框', async () => {
  await mountStreaming()
  pasteFile(pngFile('back.png'))
  await waitFor(() => chips().length > 0, '粘贴的图没进附件条')
  // 让 insert 失败（busy：回合已结束但改作下一轮也发不出去）→ 走「放回」分支
  window.__reply.insert = false
  window.__calls.insert.length = 0
  sendBtn().click()
  await waitFor(() => window.__calls.insert.length > 0, '没有调用 insert')
  // 失败后附件应回到输入框
  await waitFor(() => chips().length > 0, '插话失败后附件没放回输入框')
})

// ── 运行 ─────────────────────────────────────────────────────────

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
  const msg = `FATAL ${e && (e.stack || e.message)}`
  log(msg)
  document.title = 'DONE FATAL'
})
