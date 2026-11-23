/**
 * 剥注释库的反向验证：四种「以前会整段漏剥」的形状，断言注释内容不得漏进输出。
 *
 * 为什么单独存一份：`strip-comments.cjs` 是本轮多条判据的自保基础，
 * 它一旦漏剥，判据就会把注释里的字样当成真实代码（假绿）。
 * 这四种形状都是实测踩出来、且都能让旧状态机跑偏的。
 *
 * 用法：node .deva/qa/check-strip-comments.cjs
 */
const path = require('path')
const { stripComments } = require('./lib/strip-comments.cjs')

const CASES = [
  {
    name: '字符类含斜杠（真实源码片段：NewSessionDialog 的 slugify）',
    /*
     * 用真实文件里的那一段，而不是手写复刻 —— 手写时很容易把 `\\/` 写成 `\/`，
     * 那样根本复现不出 bug（我第一版就是这么写的，退回修复后判据照样 PASS）。
     *
     * 原始代码是：`x.replace(/[\s\\/:*?"<>|]+/g, '-')`
     * 类内的 `/` 若被当正则结束符，随后的 `"` 会开一个字符串一路吃到下一个 `"`，
     * 中间的块注释就不再被剥 —— 这正是 `NewSessionDialog.tsx` 曾经 17 个只剥掉 4 个的原因。
     */
    src: [
      'const a = 1',
      '/* 注释A */',
      'const s = name.replace(/[\\s\\\\/:*?"<>|]+/g, "-")',
      '/* 注释B */',
      'const b = 2'
    ].join('\n'),
    mustVanish: ['注释A', '注释B'],
    mustKeep: ['[\\s\\\\/:*?"<>|]']
  },
  {
    name: 'return 后紧跟正则（return /\'/）',
    src: "function f(){ return /'/ }\n/* 注释C */\nconst c=3;",
    mustVanish: ['注释C'],
    mustKeep: ["return /'/"]
  },
  {
    name: 'typeof 后紧跟正则',
    src: 'const t = typeof /x/;\n/* 注释D */\nconst d=4;',
    mustVanish: ['注释D'],
    mustKeep: ['typeof /x/']
  },
  {
    name: '普通块注释',
    src: 'const a=1;\n/* 注释E */\nconst b=2;',
    mustVanish: ['注释E'],
    mustKeep: []
  },
  {
    name: '行注释',
    src: 'const a=1; // 注释F\nconst b=2;',
    mustVanish: ['注释F'],
    mustKeep: []
  },
  {
    name: '字符串里的 /* 不是注释（glob 模式）',
    src: "const p = 'src/**/*.{ts,tsx}'\nconst b=2;",
    mustVanish: [],
    /* 字符串里的 /* 必须保留，不能被当注释吃掉 */
    mustKeep: ["'src/**/*.{ts,tsx}'"]
  }
]

let fail = 0
for (const c of CASES) {
  const out = stripComments(c.src)
  const leaked = c.mustVanish.filter((m) => out.includes(m))
  const lost = c.mustKeep.filter((m) => !out.includes(m))
  const ok = leaked.length === 0 && lost.length === 0
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}`)
  if (leaked.length) console.log(`   漏剥（注释内容出现在输出里）：${JSON.stringify(leaked)}`)
  if (lost.length) console.log(`   误吃（代码被当注释剥掉）：${JSON.stringify(lost)}`)
}

console.log(`\n==RESULT== ${CASES.length - fail} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
