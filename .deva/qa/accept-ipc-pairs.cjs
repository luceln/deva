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

// unexposed 不一定是错（主进程内部用 on() 收事件 / 渲染层用别的桥），只报告不判失败
console.log(`=== 结束：FAIL ${fails} ===`)
process.exit(fails > 0 ? 1 : 0)