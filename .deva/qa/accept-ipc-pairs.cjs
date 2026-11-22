/**
 * 独立验收：preload 声明的 IPC 通道 ↔ 主进程 handler 的双向核对。
 *
 * 合并最容易造成的静默失效：preload 里那行还在（界面能编译、能调），但主进程 handler 被上游改写时删了
 * → 运行时 "No handler registered"。反过来 handler 在、preload 没暴露 → 界面某功能直接消失。
 *
 * 用法：node .deva/qa/accept-ipc-pairs.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'src')
let fails = 0
const ok = (l, c, d) => {
  if (c) console.log(`PASS ${l}${d ? ' :: ' + d : ''}`)
  else { fails++; console.log(`FAIL ${l}${d ? ' :: ' + d : ''}`) }
}
const info = (l, v) => console.log(`INFO ${l} :: ${v}`)

function walk(dir, out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, it.name)
    if (it.isDirectory()) { if (it.name !== 'node_modules') walk(f, out); continue }
    if (/\.(ts|tsx)$/.test(it.name)) out.push(f)
  }
  return out
}

const files = walk(ROOT)
info('扫描文件数', String(files.length))

/*
 * preload 里 invoke/send 的通道名。
 *
 * **必须扫整个 `preload/` 目录，不能只读 `index.ts`**：二开通道已经拆到 `import.ts` /
 * `worktree.ts` 等文件里（拆分本身是为了减少上游合并冲突）。只读 index.ts 会静默漏掉这些，
 * 于是「preload 能调、主进程没实现」这类最危险的漂移在拆分后**再也查不出来**——
 * 脚本仍然 exit 0，但它已经没在看那部分了。
 */
const PRELOAD_DIR = path.join(ROOT, 'preload')
const preloadFiles = fs
  .readdirSync(PRELOAD_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => path.join(PRELOAD_DIR, f))
const invoked = new Set()
for (const f of preloadFiles) {
  const preloadSrc = fs.readFileSync(f, 'utf8')
  for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) invoked.add(m[1])
  for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*`([^`$]+)`/g)) invoked.add(m[1])
}
info('preload 文件数', String(preloadFiles.length) + ' ' + preloadFiles.map((f) => path.basename(f)).join(', '))
info('preload 声明的通道数', String(invoked.size))

// 主进程 handler 注册的通道名
const handled = new Set()
for (const f of files) {
  if (!f.includes(path.sep + 'main' + path.sep)) continue
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/ipcMain\.(?:handle|handleOnce|on)\(\s*'([^']+)'/g)) handled.add(m[1])
}
info('主进程注册的通道数', String(handled.size))

const missingHandler = [...invoked].filter((c) => !handled.has(c)).sort()
const unexposed = [...handled].filter((c) => !invoked.has(c)).sort()

info('preload 有、主进程没有 handler', String(missingHandler.length) + ' ' + JSON.stringify(missingHandler.slice(0, 30)))
info('主进程有、preload 没暴露', String(unexposed.length) + ' ' + JSON.stringify(unexposed.slice(0, 30)))

ok('没有「preload 能调但主进程没实现」的通道', missingHandler.length === 0, JSON.stringify(missingHandler))

/*
 * 「主进程注册了、preload 没暴露」= 用户点不到、模型也调不到的死通道。
 *
 * 这类问题曾经只记 INFO 不判失败，代价很具体：`chat:member-worktree-return-original`
 * 主进程写了 24 行完整逻辑（含目录身份校验），preload 里一行都没有，界面上那个
 * 「返回原目录」按钮的 onReturnToOriginal 永远是 undefined —— 功能整个不存在，
 * 而所有检查全绿。它混在上面那两个历史例外里被静默放过了。
 *
 * 但也不能一律判失败：有些通道本来就不该出现在 preload 里
 * （`config:get-sync` 由 preload 通过其它方式取、`app:get-platform` 同理）。
 * 所以：**历史例外白名单 + 新增即失败**。白名单只允许缩小，加新条目要在下面写明理由。
 */
const UNEXPOSED_ALLOWED = new Map([
  ['app:get-platform', 'preload 自己用 process.platform，不需要经 IPC'],
  ['config:get-sync', 'preload 的 config.getSync 走别的桥（同步取值），不经 invoke']
])

const unexposedNew = unexposed.filter((c) => !UNEXPOSED_ALLOWED.has(c))
const unexposedAllowed = unexposed.filter((c) => UNEXPOSED_ALLOWED.has(c))
// 白名单里已经不需要豁免的（通道删了或补上 preload 了）：提示清理，但不判失败
const staleAllow = [...UNEXPOSED_ALLOWED.keys()].filter((c) => !unexposed.includes(c))

info('豁免的悬空通道', String(unexposedAllowed.length) + ' ' + JSON.stringify(unexposedAllowed))
if (staleAllow.length)
  info('白名单可清理（这些通道已不再悬空）', JSON.stringify(staleAllow))

ok(
  '没有「主进程注册了但 preload 没暴露」的新增死通道',
  unexposedNew.length === 0,
  unexposedNew.length
    ? JSON.stringify(unexposedNew) +
      ' —— 要么在 preload 里暴露它，要么从主进程摘掉；确属设计如此就加进 UNEXPOSED_ALLOWED 并写理由'
    : ''
)

console.log(`=== 结束：FAIL ${fails} ===`)
process.exit(fails > 0 ? 1 : 0)