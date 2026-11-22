#!/usr/bin/env node
/**
 * 插话（回合进行中插入消息）支持附件的渲染层判据。
 *
 * ## 为什么需要
 *
 * 用户要的是一句很实在的话：「主会话在执行过程中，我插话不能输入图片，烦死了，我想截图让你看还不行」。
 * 这个需求的失效方式**全都很安静**：
 *   · 输入框在 `streaming` 时把粘贴 / 选文件 / 拖入直接 return —— 用户贴了没反应，没有任何报错；
 *   · `insert` 的请求体里漏了 `attachments` —— chip 显示得好好的，模型却只收到文字；
 *   · 插话失败（`reason: 'idle'`）回退成普通发送时漏传附件 —— 图凭空消失；
 *   · 退回 / 撤回时只还回正文、不还回附件 —— 用户贴的截图没了，只能重新截。
 *
 * 编译、类型、人眼都看不出来，只能靠判据守。
 *
 * ## 判据
 *
 *   A1 `insert` 的接口签名接受 `attachments`
 *   A2 `window.deva.chat.insert(...)` 的请求体里带 attachments（且只有正文空、附件非空也算有效）
 *   A3 插话失败改走普通发送（`reason === 'idle'`）时，附件一并传下去
 *   A4 `Composer` 的 `insertNow` 把待发附件交给 `onInsert`
 *   A5 `pickFiles` / `onPaste` / 拖入 drop **不再**在 streaming 时拦截
 *   A6 `restoreToComposer` 接受附件，并把它们并回草稿
 *   A7 `withdrawInserts` 的返回类型带 attachments，且调用点把附件传回 restoreToComposer
 *   A8 回合进行中有待发附件时，界面有一句说明（`cf.insert.withAttachments`），且中英词条都在
 *
 * 它**不能**证明：图真的进了模型请求（那要看主进程，见 `chat-turns.ts` 的 `insertMessage`），
 * 也不证明粘贴在看得到的界面里工作（要浏览器）。故本脚本只挡「代码层面又退回去了」。
 */
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '..', '..')
const CHAT = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'store', 'chat.tsx')
const COMPOSER = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'Composer.tsx')
// 词条不再从 `messages.ts` 的文本里抠：二开词条已搬到 `i18n/fork.ts`（由 messages.ts 深合并），
// 扫文本会在拆分后静默失效。改读运行时值，见 lib/i18n-source。
const { readI18n, checkKeys } = require('./lib/i18n-source.cjs')

const passes = []
const problems = []
const ok = (n, d) => passes.push(d ? `${n} —— ${d}` : n)
const bad = (n, d) => problems.push(d ? `${n} —— ${d}` : n)

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const chat = read(CHAT)
const comp = read(COMPOSER)
for (const [p, v] of [
  [CHAT, chat],
  [COMPOSER, comp]
]) {
  if (v === null) bad('A0 读得到源码', p)
}

/** i18n 词条（运行时值）。读失败给 null，依赖它的检查会如实报红而不是静默跳过。 */
let i18n = null
try {
  i18n = readI18n()
} catch (e) {
  bad('A0 读得到 i18n 词条', String(e && e.message))
}

/** 取一段文本中 `needle` 之后 `span` 字符的窗口。 */
const around = (text, needle, span = 900) => {
  const i = text.indexOf(needle)
  return i === -1 ? null : text.slice(i, i + span)
}

if (chat !== null && comp !== null && i18n !== null) {
  // ── A1：接口签名接受 attachments ──
  if (!/insert:\s*\(text:\s*string,\s*attachments\?:/.test(chat)) {
    bad('A1 insert 接口签名接受 attachments', '没有 `insert: (text: string, attachments?: ...)`')
  } else {
    ok('A1 insert 接口签名接受 attachments', '')
  }

  // ── A2：请求体带 attachments ──
  const insReq = around(chat, 'window.deva.chat.insert({', 700)
  if (!insReq) bad('A2 chat.insert 请求体带 attachments', '找不到调用')
  else if (!/attachments:\s*atts\.length|attachments:\s*atts(?![\w$])/.test(insReq)) {
    bad('A2 chat.insert 请求体带 attachments', '请求体里没有 attachments')
  } else {
    ok('A2 chat.insert 请求体带 attachments', 'attachments: atts.length ? ... : undefined')
  }
  // 只有附件、没有正文也要能插话
  if (!/if\s*\(!body\s*&&\s*atts\.length\s*===\s*0\)\s*return false/.test(chat)) {
    bad('A2 只有附件也能插话', '仍按「正文非空」卡着（!body 直接 return false）')
  } else {
    ok('A2 只有附件也能插话', '')
  }

  // ── A3：idle 回退带附件 ──
  const idle = around(chat, "r.reason === 'idle'", 200)
  if (!idle) bad('A3 idle 回退带附件', '找不到 idle 分支')
  else if (!/send\(body,\s*atts\)/.test(idle)) {
    bad('A3 idle 回退带附件', `实际：${idle.split('\n')[0].trim()}`)
  } else {
    ok('A3 idle 回退带附件', 'send(body, atts)')
  }

  // ── A4：insertNow 把附件交给 onInsert ──
  const insNow = around(comp, 'const insertNow', 1200)
  if (!insNow) bad('A4 insertNow 传附件给 onInsert', '找不到 insertNow')
  else if (!/onInsert\(full,\s*(?:toSendAttachments\()?atts\)?/.test(insNow)) {
    bad('A4 insertNow 传附件给 onInsert', 'onInsert 没带附件')
  } else if (!/atts\s*=\s*(?:sendable\(\)|pending\.filter\(\(p\)\s*=>\s*p\.supported\))/.test(insNow)) {
    bad('A4 insertNow 取受支持的附件', '没有 sendable() 或 pending.filter(supported)')
  } else {
    ok('A4 insertNow 传附件给 onInsert', 'onInsert(full, atts)')
  }

  // ── A5：三个入口都不再在 streaming 时拦截 ──
  const pick = around(comp, 'const pickFiles', 300)
  if (!pick) bad('A5 pickFiles 不再被 streaming 挡住', '找不到 pickFiles')
  else if (/if\s*\(streaming\)\s*return/.test(pick)) {
    bad('A5 pickFiles 不再被 streaming 挡住', '仍有 `if (streaming) return`')
  } else ok('A5 pickFiles 不再被 streaming 挡住', '')

  const paste = around(comp, 'const onPaste', 400)
  if (!paste) bad('A5 onPaste 不再被 streaming 挡住', '找不到 onPaste')
  else if (/if\s*\(!streaming\)\s*void ingest/.test(paste)) {
    bad('A5 onPaste 不再被 streaming 挡住', '仍有 `if (!streaming) void ingest(files)`')
  } else if (!/void ingest\(files\)/.test(paste)) {
    bad('A5 onPaste 不再被 streaming 挡住', '没有调用 ingest')
  } else ok('A5 onPaste 不再被 streaming 挡住', '')

  const drop = around(comp, 'const onDrop', 400)
  if (!drop) bad('A5 拖入不再被 streaming 挡住', '找不到 onDrop')
  else if (/!streamingRef\.current|streamingRef\.current\s*\?/.test(drop) || /streamingRef\.current/.test(around(comp, 'const onDragOver', 300) ?? '')) {
    bad('A5 拖入不再被 streaming 挡住', '仍有 streamingRef 判断')
  } else if (!/void ingestRef\.current\(files\)/.test(drop)) {
    bad('A5 拖入不再被 streaming 挡住', '没有调用 ingestRef')
  } else ok('A5 拖入不再被 streaming 挡住', '')

  // ── A6：restoreToComposer 接受附件 ──
  // 附件类型已从 `string[]` 升级为结构化的 `SendAttachment[]`（InsertAttachment 一路传下来），
  // 且现在带默认值 `= []`。判据只要求「有这个参数且是附件数组」，不锁死具体类型名与默认值写法。
  if (
    !/export function restoreToComposer\(\s*sessionId: string,\s*text: string,\s*attachments\??\s*:\s*\w+\[\]\s*(?:=\s*\[\])?\s*\)/.test(
      comp
    )
  ) {
    bad('A6 restoreToComposer 接受附件', '签名里没有 attachments')
  } else if (
    // 「并回草稿」的实现在上游结构升级后换成了 `mergePicked(back, cur)`（按 path 去重、back 在前），
    // 与旧 `mergeDraftAttachments` 语义相同。两者都算满足；关键是不能一个都没有。
    !/mergePicked\(|mergeDraftAttachments\(/.test(around(comp, 'export function restoreToComposer', 1200) ?? '')
  ) {
    bad('A6 restoreToComposer 接受附件', '没有把附件并回草稿')
  } else {
    ok('A6 restoreToComposer 接受附件', '')
  }

  // ── A7：withdraw 返回附件、调用点传回 ──
  if (!/withdrawInserts:\s*\(\)\s*=>\s*Promise<\{ text: string; attachments: \w+\[\] \}>/.test(chat)) {
    bad('A7 withdrawInserts 返回附件', '返回类型仍只有 text')
  } else {
    ok('A7 withdrawInserts 返回附件', '')
  }
  const wd = around(comp, 'void withdrawInserts()', 300)
  if (!wd) bad('A7 撤回时把附件传回输入框', '找不到 withdrawInserts 调用点')
  else if (!/restoreToComposer\(sessionId,\s*back\.text,\s*back\.attachments\)/.test(wd)) {
    bad('A7 撤回时把附件传回输入框', 'restoreToComposer 没带附件')
  } else {
    ok('A7 撤回时把附件传回输入框', 'restoreToComposer(sessionId, back.text, back.attachments)')
  }
  // 退回事件也带附件
  // 实际写法是 `cb(sid, ev.text, ev.attachments)`（上游把 attachments 定为必填，不再需要 `?? []`）。
  if (!/cb\(sid,\s*ev\.text,\s*ev\.attachments(\s*\?\?\s*\[\])?\s*\)/.test(chat)) {
    bad('A7 inserts_returned 事件把附件交给订阅者', '回调没带 ev.attachments')
  } else {
    ok('A7 inserts_returned 事件把附件交给订阅者', '')
  }

  // ── A8：界面上有一句说明，中英都在 ──
  if (!/t\('cf\.insert\.withAttachments'\)/.test(comp)) {
    bad('A8 界面说明「附件随这条插话带进去」', 'Composer 里没有用 cf.insert.withAttachments')
  } else {
    ok('A8 界面说明「附件随这条插话带进去」', '')
  }
  // 读运行时值：每个语言都必须有 `cf.insert.withAttachments` 且非空。
  // （原实现扫文本找 `withAttachments: '…'` 两处，词条搬到 fork.ts 后会一处也找不到。）
  const r = checkKeys(['cf.insert.withAttachments'])
  if (!r.ok) bad('A8 withAttachments 中英各一条且非空', r.detail)
  else ok('A8 withAttachments 中英各一条且非空', r.detail)
}

/*
 * ── 运行时部分：驱动真实的 Composer 纯函数 ──
 *
 * 上面那些静态判据只能证明「代码形状对」。这一节 bundle 真实 `Composer.tsx`，
 * 拿 `mergeDraftAttachments` / `pickedOfPath` / `toSendAttachments` 跑数据，
 * 证明「退回的附件真的回到了输入框那份列表里、且能原样变成发送参数」。
 */
async function runtime() {
  if (typeof globalThis.window === 'undefined') globalThis.window = { deva: { platform: 'win32' } }
  const outDir = path.join(__dirname, 'dist')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `check-insatt-${Date.now()}.cjs`)
  await esbuild.build({
    entryPoints: [COMPOSER],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')],
    plugins: [
      {
        name: 'noop-css',
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, () => ({ path: 'noop.css', namespace: 'noop' }))
          b.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({ contents: '' }))
        }
      }
    ]
  })
  const mod = require(out)
  fs.rmSync(out, { force: true })

  const { mergeDraftAttachments, pickedOfPath, toSendAttachments } = mod
  for (const [n, f] of [
    ['mergeDraftAttachments', mergeDraftAttachments],
    ['pickedOfPath', pickedOfPath],
    ['toSendAttachments', toSendAttachments]
  ]) {
    if (typeof f !== 'function') {
      bad('R0 导出 ' + n, 'Composer.tsx 没导出该函数')
      return
    }
  }

  const run = (name, fn) => {
    try {
      fn()
      ok(name)
    } catch (e) {
      bad(name, e.message)
    }
  }
  const eqv = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
  }

  run('R1 退回的附件并回草稿，排在已有之后', () => {
    const cur = [{ path: 'C:\\a.png', name: 'a.png', ext: 'png', size: 1, kind: 'image', supported: true }]
    const out = mergeDraftAttachments(cur, ['C:\\b.png'])
    eqv(out.length, 2, '应有两项')
    eqv(out[0].path, 'C:\\a.png', '原有项应在前')
    eqv(out[1].path, 'C:\\b.png', '退回项应在后')
  })

  run('R2 同一路径去重（不产生两个一模一样的 chip）', () => {
    const cur = [{ path: 'C:\\a.png', name: 'a.png', ext: 'png', size: 1, kind: 'image', supported: true }]
    const out = mergeDraftAttachments(cur, ['C:\\a.png', 'C:\\a.png'])
    eqv(out.length, 1, '重复路径应只留一份')
  })

  run('R3 空路径数组 → 原样返回（无附件时不动草稿）', () => {
    const cur = [{ path: 'C:\\a.png', name: 'a.png', ext: 'png', size: 1, kind: 'image', supported: true }]
    const out = mergeDraftAttachments(cur, [])
    eqv(out.length, 1, '不应变化')
  })

  run('R4 pickedOfPath 兜底：图片按扩展名认成 image 且可选', () => {
    const p = pickedOfPath('C:\\tmp\\shot.png')
    eqv(p.kind, 'image', 'png 应是 image')
    eqv(p.supported, true, '兜底不把图判成不支持（否则图就丢了）')
    eqv(p.name, 'shot.png', 'name 取最后一段')
  })

  run('R5 toSendAttachments：图片带 size，文件夹不带', () => {
    const img = pickedOfPath('C:\\tmp\\shot.png')
    const folder = { path: 'C:\\tmp\\dir', name: 'dir', ext: '', size: 0, kind: 'folder', supported: true }
    const out = toSendAttachments([img, folder])
    eqv(out.length, 2, '两项')
    eqv(out[0].path, 'C:\\tmp\\shot.png', '路径原样传递')
    if (!('size' in out[0])) throw new Error('图片应带 size')
    if ('size' in out[1]) throw new Error('文件夹不该带 size')
  })
}

runtime()
  .catch((e) => bad('R 运行时', String(e && (e.stack || e.message))))
  .finally(() => {
    for (const p of passes) console.log(`PASS ${p}`)
    for (const p of problems) console.log(`FAIL ${p}`)
    console.log(`\n共 ${passes.length} PASS / ${problems.length} FAIL`)
    process.exit(problems.length === 0 ? 0 : 1)
  })