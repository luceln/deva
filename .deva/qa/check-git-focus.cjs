#!/usr/bin/env node
/**
 * 分支 pill 刷新时机 —— CI 可跑的源码结构判据。
 *
 * 为什么需要它：行为验证（git-pill/test.ts，浏览器里驱动真实 GitWidget）需要 Chromium，
 * CI 没有这个依赖；而「用户报的 bug 是 focus 不刷新」这件事有一个**纯静态可判**的核心形状：
 *   useGitStatus 里必须注册 window focus 监听、必须清理、且回调真的调到 refresh。
 * 少了任一条，用户报的 bug 就回来了。这里把这三条变成可执行判据。
 *
 * 它**不能**证明的（每次运行都打印，别把它当行为验证）：
 *   · 回调在运行时到底有没有被触发（事件注册对不对、React 有没有真的重渲染）
 *   · 刷新后 pill 文本是否真的更新
 *   · hidden / 未聚焦时是否真的跳过
 * 这三条由 .deva/qa/git-pill（需浏览器，手动跑）覆盖，见该目录 README。
 *
 * 判据一律「先断言命中数 ≥1 再判内容」：空集合上 every() 恒真，会出假 PASS。
 */
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const REPO = path.resolve(__dirname, '..', '..')
const FILE = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'GitWidget.tsx')

const problems = []
const passes = []
function ok(name, detail) {
  passes.push(detail ? `${name} —— ${detail}` : name)
}
function bad(name, detail) {
  problems.push(detail ? `${name} —— ${detail}` : name)
}

const src = fs.readFileSync(FILE, 'utf8')
const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** 找到函数声明 useGitStatus（含函数体）。 */
function findFn(name) {
  let found = null
  const walk = (n) => {
    if (found) return
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) found = n
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return found
}

/** 某节点是否对 window 调用了 addEventListener('focus', ...)。 */
function isWindowFocusAdd(node) {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'addEventListener') return false
  const recv = callee.expression
  const isWindow =
    (ts.isIdentifier(recv) && recv.text === 'window') ||
    (ts.isPropertyAccessExpression(recv) && recv.name.text === 'window')
  if (!isWindow) return false
  const [typeArg] = node.arguments
  return Boolean(typeArg && ts.isStringLiteral(typeArg) && typeArg.text === 'focus')
}

/** 某节点是否对 window 调用了 removeEventListener('focus', ...)。 */
function isWindowFocusRemove(node) {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'removeEventListener') return false
  const recv = callee.expression
  const isWindow =
    (ts.isIdentifier(recv) && recv.text === 'window') ||
    (ts.isPropertyAccessExpression(recv) && recv.name.text === 'window')
  if (!isWindow) return false
  const [typeArg] = node.arguments
  return Boolean(typeArg && ts.isStringLiteral(typeArg) && typeArg.text === 'focus')
}

const fn = findFn('useGitStatus')

// ── F1 存在 useGitStatus ────────────────────────────────────────
if (!fn || !fn.body) {
  bad('F1 useGitStatus 存在', '没找到函数声明，后面所有判据都无从谈起')
} else {
  ok('F1 useGitStatus 存在')

  const adds = []
  const removes = []
  const effects = []
  const walk = (n) => {
    if (isWindowFocusAdd(n)) adds.push(n)
    if (isWindowFocusRemove(n)) removes.push(n)
    if (ts.isCallExpression(n)) {
      const c = n.expression
      if (ts.isIdentifier(c) && c.text === 'useEffect') effects.push(n)
    }
    ts.forEachChild(n, walk)
  }
  walk(fn.body)

  // ── F2 注册了 focus 监听 ─────────────────────────────────────
  if (adds.length === 0) {
    bad('F2 注册 window focus 监听', 'useGitStatus 里没有 window.addEventListener(\'focus\', …) —— 用户报的 bug 就是这个')
  } else if (adds.length > 1) {
    bad('F2 注册 window focus 监听', `注册了 ${adds.length} 处，只应 1 处（多注册会重复拉取）`)
  } else {
    ok('F2 注册 window focus 监听', '1 处')
  }

  // ── F3 同一 useEffect 里清理 ─────────────────────────────────
  if (adds.length === 1) {
    // 找包含该 add 的最近一层 useEffect 回调
    let owner = null
    const findOwner = (n, chain) => {
      if (n === adds[0]) {
        owner = chain[chain.length - 1] || null
        return
      }
      const next = ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useEffect'
        ? [...chain, n]
        : chain
      ts.forEachChild(n, (c) => findOwner(c, next))
    }
    findOwner(fn.body, [])

    if (!owner) {
      bad('F3 在 useEffect 内注册', 'focus 监听不在任何 useEffect 里 —— 每次渲染都会注册一份，泄漏')
    } else {
      ok('F3 在 useEffect 内注册')
      // 该 useEffect 回调必须返回一个含 remove 的清理函数
      const cb = owner.arguments[0]
      let hasReturnRemove = false
      const scanReturn = (n) => {
        if (ts.isReturnStatement(n) && n.expression) {
          const scan = (m) => {
            if (isWindowFocusRemove(m)) hasReturnRemove = true
            ts.forEachChild(m, scan)
          }
          scan(n.expression)
        }
        ts.forEachChild(n, scanReturn)
      }
      if (cb) scanReturn(cb)
      if (!hasReturnRemove) {
        bad('F4 useEffect 返回清理函数', '没在 return 里 removeEventListener(\'focus\') —— 组件卸载后监听残留')
      } else {
        ok('F4 useEffect 返回清理函数', 'return 内含 removeEventListener(\'focus\')')
      }
    }
  }

  // ── F5 回调真的调到 refresh ──────────────────────────────────
  if (adds.length === 1) {
    // add 的第二个参数是回调（可能是标识符，指向同函数内定义的 const）
    const handler = adds[0].arguments[1]
    let handlerNode = handler
    if (handler && ts.isIdentifier(handler)) {
      const name = handler.text
      const findDecl = (n) => {
        if (handlerNode && !ts.isIdentifier(handlerNode)) return
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
          handlerNode = n.initializer || handlerNode
        }
        ts.forEachChild(n, findDecl)
      }
      findDecl(fn.body)
    }
    let callsRefresh = false
    if (handlerNode && !ts.isIdentifier(handlerNode)) {
      const scan = (n) => {
        if (ts.isCallExpression(n)) {
          const c = n.expression
          // refreshRef.current() 或 refresh()
          if (ts.isPropertyAccessExpression(c) && c.name.text === 'current') callsRefresh = true
          if (ts.isIdentifier(c) && (c.text === 'refresh' || c.text === 'refreshRef')) callsRefresh = true
        }
        ts.forEachChild(n, scan)
      }
      scan(handlerNode)
    }
    if (!callsRefresh) {
      bad('F5 回调调用 refresh', 'focus 回调里没调到 refresh / refreshRef.current —— 监听了但不刷新，等于没修')
    } else {
      ok('F5 回调调用 refresh')
    }
  }

  // ── F6 没有改成轮询 ──────────────────────────────────────────
  let hasInterval = false
  const scanInterval = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression
      if (ts.isIdentifier(c) && (c.text === 'setInterval' || c.text === 'setTimeout')) hasInterval = true
    }
    ts.forEachChild(n, scanInterval)
  }
  scanInterval(fn.body)
  if (hasInterval) {
    bad('F6 未引入轮询', 'useGitStatus 里出现 setInterval / setTimeout —— 注释写明不轮询（每次 status 都 spawn git 进程）')
  } else {
    ok('F6 未引入轮询')
  }

  // ── F7 注释与实现一致（必查第五类）────────────────────────────
  const docComment = fn.getFullText(sf).slice(0, fn.getStart(sf) - fn.getFullText(sf).length + 1)
  const leading = src.slice(Math.max(0, src.indexOf('function useGitStatus') - 900), src.indexOf('function useGitStatus'))
  const commentBlock = (leading.match(/\/\*\*[\s\S]*?\*\//g) || []).pop() || ''
  void docComment
  if (!commentBlock) {
    bad('F7 注释存在', 'useGitStatus 上方没有文档注释')
  } else if (!/焦点|focus/i.test(commentBlock)) {
    bad('F7 注释写明焦点刷新', '文档注释没提到「焦点/focus」—— 实现加了 focus 刷新，注释却没更新（本仓必查第五类：注释与实现不符）')
  } else if (/只在「挂载 \/ 开菜单 \/ 每次写操作后」/.test(commentBlock)) {
    bad('F7 注释写明焦点刷新', '注释仍是旧的三时机表述，与实现不符')
  } else {
    ok('F7 注释写明焦点刷新', '文档注释提到焦点，且不含旧的三时机表述')
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────
for (const p of passes) console.log(`  PASS ${p}`)
for (const p of problems) console.log(`  FAIL ${p}`)
console.log(`\n${passes.length} PASS / ${problems.length} FAIL`)
console.log(
  '\n边界：本判据只查源码形状（注册、清理、调到 refresh、未轮询、注释一致），' +
    '证明不了「运行时 focus 真的触发刷新、pill 文本真的更新、hidden 时真的跳过」。' +
    '那三条见 .deva/qa/git-pill（需浏览器，手动跑）：node .deva/qa/git-pill/build.cjs 后打开 page.html。'
)
if (problems.length > 0) process.exit(1)
console.log('分支 pill 刷新时机：源码形状合规。')
