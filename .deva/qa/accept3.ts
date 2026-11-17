/**
 * 最终验收——第三轮：界面逻辑 + 报告契约的边角。
 *
 *   allfail   : allFailures() 去重在「五步都填 failed」后是否还对（含记忆重复推入）
 *   unknownid : 兜底失败条目 id 为空字符串时界面显示什么
 *   bigfail   : 失败条目很多时失败清单会不会截断/卡住（读代码 + 生成大报告）
 */
import * as fs from 'fs'
import * as path from 'path'

import { runImport } from '../../apps/desktop/src/main/importer'
import { registerConfigIpc } from '../../apps/desktop/src/main/services/config'

const HOME = process.env.TEST_HOME as string
const DST = process.env.DEVA_HOME as string
const SRC = path.join(HOME, '.deva')

let fails = 0
const pass = (n: string, d = ''): void => console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n: string, d = ''): void => {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const info = (n: string, d = ''): void => console.log(`INFO ${n}${d ? ` :: ${d}` : ''}`)
const check = (n: string, c: boolean, d = ''): boolean => (c ? pass(n, d) : fail(n, d), c)
const eq = (n: string, a: unknown, e: unknown): boolean => {
  const A = JSON.stringify(a)
  const E = JSON.stringify(e)
  return check(n, A === E, A === E ? A : `实际=${A} 期望=${E}`)
}
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}
function writeJson(p: string, v: unknown): void {
  mkdirp(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}
function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}

/** 把 ImportPane 的 allFailures 原样搬过来（读代码 vs 实际报告形状）。 */
function allFailures(report: any): Array<{ step: string; id: string; reason: string }> {
  const seen = new Set<string>()
  const out: Array<{ step: string; id: string; reason: string }> = []
  for (const f of [...report.memories.failed, ...report.failures]) {
    const k = `${f.step}:${f.id}:${f.reason}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

/** 记忆失败是否被双计：记忆既进 memories.failed，又 push 进 report.failures（importer.ts:120）。 */
async function scenarioAllFail(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  // 造一条必被拒写的记忆：单条超 300 字（tooLong）
  writeJson(path.join(SRC, 'memory.json'), {
    version: 1,
    entries: [
      { id: 'm_long1', content: 'x'.repeat(400) },
      { id: 'm_ok1', content: '正常条目' }
    ]
  })
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)
  const r = (await runImport()) as any
  info('记忆失败', JSON.stringify(r.memories.failed))
  info('report.failures', JSON.stringify(r.failures))
  eq('allfail：记忆失败进了 memories.failed', r.memories.failed.length, 1)
  eq('allfail：同一条也被推进了 report.failures（双份）', r.failures.length, r.memories.failed.length)
  const deduped = allFailures(r)
  eq('allfail：界面 allFailures 去重后只剩 1 条', deduped.length, 1)
  eq('allfail：去重后内容正确', deduped[0]?.reason, 'tooLong')

  // 两处都有的情况下，若 step/id/reason 有任何不同，就会显示两遍
  const r2 = { ...r, failures: [...r.failures, { step: 'unknown', id: '', reason: 'boom' }] }
  const d2 = allFailures(r2)
  eq('allfail：未知步骤失败也能进清单', d2.length, 2)
  const unknown = d2.find((f) => f.step === 'unknown')
  eq('unknownid：兜底失败条目 id 为空字符串', unknown?.id, '')
  info('unknownid 界面显示', `ImportPane 用 \`{f.id || '—'}\` → 显示为「—」`)
}

/* ═════════ bigfail：大量失败条目的渲染代价（读代码） ═════════ */
async function scenarioBigFail(): Promise<void> {
  const pane = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/renderer/src/redesign/ImportPane.tsx'), 'utf8')
  // 失败清单渲染：有无 key、有无截断
  const block = pane.slice(pane.indexOf('failures.length > 0'), pane.indexOf('failureHint'))
  check('bigfail：失败清单有 key（f.step:id:i）', /key=\{`\$\{f\.step\}:\$\{f\.id\}:\$\{i\}`\}/.test(block), '')
  check('bigfail：失败清单无 slice 截断', !/\.slice\(/.test(block), block.includes('.slice(') ? '有 slice' : '')
  check('bigfail：失败清单无虚拟滚动（全量渲染）', !/Virtual/i.test(block), '')
  const css = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/renderer/src/redesign/redesign.css'), 'utf8')
  const failsCss = css.slice(css.indexOf('cf-imp__fails'), css.indexOf('cf-imp__fails') + 400)
  info('bigfail：失败区 CSS', failsCss.split('\n').filter((l) => l.includes('overflow') || l.includes('max-height')).join(' ') || '（无 max-height / overflow 限制）')
  info(
    'bigfail 结论',
    '失败清单全量渲染、无上限也无滚动容器。单个会话目录里几百个文件失败时会一次性铺开整屏（不是卡死，但体验差）'
  )
}

/* ═════════ 入口 ═════════ */
const S: Record<string, () => Promise<void>> = { allfail: scenarioAllFail, bigfail: scenarioBigFail }
async function main(): Promise<void> {
  const name = process.argv[2] || 'allfail'
  const fn = S[name]
  if (!fn) {
    console.log('FAIL 未知场景')
    process.exit(2)
  }
  console.log(`=== 验收场景 ${name} ===`)
  try {
    await fn()
  } catch (e) {
    fail(`${name} 抛异常`, (e as Error)?.stack?.split('\n').slice(0, 6).join(' / ') ?? String(e))
  }
  console.log(`=== ${name} 结束：FAIL ${fails} ===`)
  process.exit(fails ? 1 : 0)
}
void main()
