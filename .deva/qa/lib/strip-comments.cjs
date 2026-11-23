/**
 * 判据脚本共用：把源码文本里的注释剥掉，再用于断言。
 *
 * ## 为什么必须有
 *
 * 判据都是「源码里出现了某段字符串 → 通过」。而注释里**天然会提到**类名、函数名、字段名
 * ——尤其是修复类注释（「原来写的是 `res.message ?? t(...)`」「用 .cf-setrow__note--warn
 * 而不是 .cf-badge」）。于是一条跨行宽松正则（`[^<]*`、`[\s\S]{0,400}`）就能从注释里的
 * 词一路吞到代码里的词，把「实现已经改错」判成绿。
 *
 * 实测过的两个真实假绿：
 *   · `check-worktree-fields` 的 G1：把 `disabled={!view.mergeGate.mayMerge}` 改成
 *     `disabled={false}` 并把正确表达式挪进注释，仍然 11 PASS。
 *   · `check-backup-pane-buttons` 的兜底正则从注释里的 `.cf-setrow__note--warn` 起匹配。
 *
 * 剥注释本质上是「让断言只看到会被编译的东西」。它不追求完整 JS 词法分析
 * （字符串里的 `//` 会被正文占位保护住，见下），只覆盖注释这一种确实存在的干扰。

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释，**保留字符串字面量与换行**。
 *
 * 为什么不能简单 `.replace(/\/\/.*$/gm, '')`：那会把
 *   const u = 'https://example.com'      → const u = 'https:
 * 一起削掉，而 URL / 正则 / JSX 文本里到处都是 `//`。削错之后原本能匹配的断言会变红，
 * 是另一种错（假红），同样不可接受。
 *
 * 所以走一个小状态机：单引号 / 双引号 / 模板字符串里不认注释；
 * 注释内容替换成等长空格（保留列位置，报告里指认行号时不会错位），
 * 块注释里的换行保留（行数不变，`split('\n')` 之后的索引仍然对得上）。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // 当前所在：'code' | "'" | '"' | '`' | 'regex'
  let state = 'code'
  /** 上一个有意义的（非空白）代码字符，用来判断 `/` 是正则起点还是除号。 */
  let prevSig = ''
  /**
   * 是否在正则的字符类 `[...]` 内。
   *
   * 类内的 `/` 不结束正则（`/[a\/b]/`）。不跟踪这个标志，
   * 遇到 `.replace(/[\s\\/:*?"<>|]+/g,'-')` 这类写法就会把 `[` 后的第一个 `/` 当结束符，
   * 状态机跑偏后整段注释漏剥。
   */
  let inClass = false
  /** 上一个完整的标识符（`return` / `typeof` 这类关键字后缀要回看它才能判对）。 */
  let prevWord = ''
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]

    if (state === 'code') {
      if (c === '/' && next === '/') {
        // 行注释：削到行尾（不含换行）
        while (i < n && src[i] !== '\n') {
          out += ' '
          i += 1
        }
        continue
      }
      if (c === '/' && next === '*') {
        // 块注释：一直削到闭合标记，换行原样保留
        out += '  '
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += src[i] === '\n' ? '\n' : ' '
          i += 1
        }
        if (i < n) {
          out += '  '
          i += 2
        }
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c
        out += c
        i += 1
        continue
      }
      /*
       * 正则字面量：`/ipcMain\.handle\('chat:.../g` 这种情况里含 `'` 与 `(`。
       *
       * 不识别它的话，那个 `'` 会被当成字符串起点，状态机一头扎进「字符串」里再也不出来，
       * 后面所有注释都不再被剥掉（实测：一个判据脚本从第 430 行起整段漏剥，于是我自己
       * 注释里举例的旧正则被当成真实断言，元判据误报）。这就是这个状态机最脆弱的地方。
       *
       * 判据：`/` 出现在「不能是除号」的位置才是正则起点。粗略但够用 —— 看上一个
       * 有意义的字符是不是 `)`、`]`、标识符/数字结尾；若是，则这多半是除法。
       */
      if (c === '/' && isRegexStart(prevSig, prevWord)) {
        state = 'regex'
        inClass = false
        out += c
        i += 1
        continue
      }
      out += c
      if (!/\s/.test(c)) {
        /*
         * 维护 `prevWord`：标识符字符就累积，遇到非标识符就清空。
         * 这样 `/` 前面若是 `return` 整个词，`prevWord` 就是 'return'（不是单字符 'n'）。
         */
        if (/[A-Za-z0-9_$]/.test(c)) {
          if (prevSig === '' || /[A-Za-z0-9_$]/.test(prevSig)) prevWord += c
          else prevWord = c
        } else {
          prevWord = ''
        }
        prevSig = c
      }
      i += 1
      continue
    }

    if (state === 'regex') {
      // 正则内部：`\x` 转义整体跳过；字符类 `[...]` 内的 `/` 不算结束
      if (c === '\\') {
        out += c + (src[i + 1] ?? '')
        i += 2
        continue
      }
      /*
       * 字符类：`/[\s\/]+/` 里那个 `/` 是**类内**的斜杠，不是正则结束符。
       *
       * 不认它的话状态机会在这里提前收工、回到 code，接着把后面的 `"` 当成字符串起点，
       * 一头扎进「字符串」里再也不出来 —— 其后所有注释都不再被剥。
       * 实测：`NewSessionDialog.tsx` 17 个块注释只剥掉 4 个（截断点在 `.replace(/[\s\\/:*?"<>|]+/g,'-')`）。
       * 这是本轮最硬的假绿源：本轮多条判据的自保机制全押在这个库上。
       */
      if (c === '[') {
        inClass = true
        out += c
        i += 1
        continue
      }
      if (c === ']' && inClass) {
        inClass = false
        out += c
        i += 1
        continue
      }
      if (c === '/' && !inClass) {
        state = 'code'
        out += c
        prevSig = '/'
        i += 1
        continue
      }
      // 正则不能跨行；遇到换行说明不是正则（比如除号误判），回到 code
      if (c === '\n') {
        state = 'code'
        inClass = false
        out += c
        i += 1
        continue
      }
      out += c
      i += 1
      continue
    }

    // 字符串内部：处理转义与结束引号
    if (c === '\\') {
      out += c + (src[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === state) {
      state = 'code'
      out += c
      prevSig = c
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * `/` 出现在这里是不是正则字面量的起点。
 *
 * 依据是「除号左边一定是一个值」：`)`、`]`、标识符、数字之后跟着的 `/` 是除法；
 * 行首或 `(`、`,`、`=`、`:`、`!`、`&`、`|`、`?`、`{`、`;`、`return` 之后则是正则。
 */
/**
 * `... { path } = ...` 这类不换行——判据全靠它。
 *
 * ## 为什么还需要「前一个完整标识符」
 *
 * `prevSig` 只是**上一个字符**。`return /'/`、`typeof /x/`、`case /re/` 这些写法里
 * 前一个字符是标识符末字符（`n`、`f`、`e`），按「标识符结尾 = 除号」会误判成正则外的除法，
 * 于是那个 `'` 被当字符串起点，后续注释整段漏剥。
 *
 * 所以除了 prevSig，还要看**前一个完整标识符**是不是这些关键字 —— 它们是运算符位置，
 * 后面必是正则而非除法。
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await',
  'instanceof', 'do', 'else', 'Throw', 'throw'
])

/**
 * 判断 `/` 是否为正则起点。
 *
 * @param prevSig 上一个有意义的字符
 * @param prevWord 上一个完整的标识符（可为空串）
 */
function isRegexStart(prevSig, prevWord = '') {
  if (prevSig === '') return true
  if (REGEX_AFTER_KEYWORD.has(prevWord)) return true
  if (/[A-Za-z0-9_$)\]'"`]/.test(prevSig)) return false
  return true
}

/** 剥注释 + 把连续空白压成一个空格（跨行宽松匹配时用，等价于原脚本的 `replace(/\s+/g,' ')`）。 */
function stripCommentsFlat(src) {
  return stripComments(src).replace(/\s+/g, ' ')
}

/**
 * 只取第一处匹配的**那一行**（剥注释之后）。
 *
 * 这是替代「跨行宽松正则」的主要手段：先定位到含某个唯一锚点的那一行，
 * 再在这一行里断言内容。跨行 `[\s\S]{0,400}` 恰恰是假绿的载体 ——
 * 它允许断言从注释跳到代码、或从 A 组件跳到 B 组件。
 */
function lineWith(src, ...needles) {
  const code = stripComments(src)
  return code.split('\n').find((l) => needles.every((x) => l.includes(x))) ?? null
}

/**
 * 从 `from`（指向 `{` 的位置）起按花括号配平，返回含外层花括号的整段。
 *
 * 用来把「一个组件 / 一个函数」的边界切出来，替代 `[\s\S]{0,N}` 那种长度窗口 ——
 * 窗口的 N 永远调不准：组件长了就够不到，窗口开大了又会跨到隔壁组件去。
 * 配不平（到文件尾还没闭合）返回 null —— 那说明源码本身是坏的，不该当成「找到了」。
 */
function sliceBraced(text, from) {
  if (text[from] !== '{') return null
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/** 同 sliceBraced，但按方括号配平 —— 用来切出一个数组/集合字面量的边界。 */
function sliceBracket(text, from) {
  if (text[from] !== '[') return null
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '[') depth += 1
    else if (text[i] === ']') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

module.exports = { stripComments, stripCommentsFlat, lineWith, sliceBraced, sliceBracket }