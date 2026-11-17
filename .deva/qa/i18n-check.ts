/**
 * i18n 覆盖检查（不需要 GUI）：ImportPane 用到的每个 key 在 zh-CN / en 字典里是否都存在、是否非空。
 * 也顺带检查进度事件的每个 step 都有文案。
 */
import { messages } from '../../apps/desktop/src/renderer/src/i18n/messages'
import * as fs from 'fs'
import * as path from 'path'

let fails = 0
const say = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

const SRC = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/renderer/src/redesign/ImportPane.tsx'), 'utf8')
const keys = new Set<string>()
for (const m of SRC.matchAll(/t\('([^']+)'\)/g)) keys.add(m[1])
for (const m of SRC.matchAll(/t\(`([^`]+)`\)/g)) {
  // 模板串：settings.import.steps.${...} / settings.import.assoc.${k}
  const t = m[1]
  if (t.includes('steps.')) {
    for (const s of ['providers', 'personas', 'personaEnabled', 'memories', 'skills', 'sessions', 'assoc', 'cache', 'done'])
      keys.add(t.replace(/\$\{[^}]+\}/g, s))
  } else if (t.includes('assoc.')) {
    for (const s of ['media', 'checkpoints', 'subagents', 'toolResults']) keys.add(t.replace(/\$\{[^}]+\}/g, s))
  }
}
// FAILURE_REASON_KEY 里的三条
for (const k of ['settings.import.reason.budget', 'settings.import.reason.full', 'settings.import.reason.tooLong']) keys.add(k)

const resolve = (tree: any, key: string): unknown => {
  let cur = tree
  for (const p of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(p in cur)) return undefined
    cur = cur[p]
  }
  return cur
}

for (const locale of ['zh-CN', 'en'] as const) {
  const missing: string[] = []
  const empty: string[] = []
  for (const k of [...keys].sort()) {
    const v = resolve((messages as any)[locale], k)
    if (v === undefined) missing.push(k)
    else if (typeof v === 'string' && !v.trim()) empty.push(k)
  }
  say(missing.length === 0, `${locale}：ImportPane 引用的 ${keys.size} 个 key 都存在`, missing.join(','))
  say(empty.length === 0, `${locale}：没有空文案`, empty.join(','))
}

// 两个语言字典的 key 集合必须一致（否则切语言会露出 key）
const flat = (tree: any, prefix = '', out: string[] = []): string[] => {
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === 'string') out.push(prefix + k)
    else flat(v, `${prefix}${k}.`, out)
  }
  return out
}
const zh = new Set(flat((messages as any)['zh-CN']))
const en = new Set(flat((messages as any)['en']))
const onlyZh = [...zh].filter((k) => !en.has(k))
const onlyEn = [...en].filter((k) => !zh.has(k))
say(onlyZh.length === 0, 'zh 多出的 key 在 en 里缺失', onlyZh.slice(0, 20).join(','))
say(onlyEn.length === 0, 'en 多出的 key 在 zh 里缺失', onlyEn.slice(0, 20).join(','))

console.log(`=== i18n 检查结束：FAIL ${fails} 条 ===`)
process.exit(fails ? 1 : 0)
