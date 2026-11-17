/**
 * 最终验收——第二轮：边界与「修了但没修全」。
 *
 *   mtimesweep : copyFileSync 保留源 mtime → 1 小时宽限期对导入文件不生效（注释依据存疑）
 *   race2      : 第二次导入（copied 为空）时旧快照仍会覆盖，且补回逻辑不触发
 *   gateui     : 新闸门码（same-home / source-unreadable）在界面上显示成什么（读代码）
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport } from '../../apps/desktop/src/main/importer-gate'
import { getConfig, isConfigHeld, registerConfigIpc, setConfig } from '../../apps/desktop/src/main/services/config'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'
import { listSessions, invalidateIndex } from '../../apps/desktop/src/main/services/chat-store'
import { sweepMedia } from '../../apps/desktop/src/main/services/media-store'
import { sweepCheckpoints } from '../../apps/desktop/src/main/services/checkpoints'
import { sweepSubagents } from '../../apps/desktop/src/main/services/subagent-store'

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
function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}
function setOld(p: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(p, t, t)
}
function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).length
  } catch {
    return 0
  }
}

/* ═════════ mtimesweep：宽限期对导入文件是否生效 ═════════ */

async function scenarioMtimeSweep(): Promise<void> {
  // 源：一个会话（引用 blob A）+ 两个 blob，其中 A 被引用、B 无引用；两者 mtime 都是 3 天前
  const H_A = 'a'.repeat(64)
  const H_B = 'b'.repeat(64)
  mkdirp(path.join(SRC, 'data', 'chats'))
  mkdirp(path.join(SRC, 'data', 'media'))
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  // 会话里按 media-store 的引用格式写 "blob": "<hash>"
  writeJson(path.join(SRC, 'data', 'chats', 'sess_1.json'), {
    id: 'sess_1',
    messages: [{ role: 'user', content: [{ type: 'image', blob: H_A }] }]
  })
  fs.writeFileSync(path.join(SRC, 'data', 'media', H_A), 'A')
  fs.writeFileSync(path.join(SRC, 'data', 'media', H_B), 'B')
  setOld(path.join(SRC, 'data', 'media', H_A), 3 * 86400 * 1000)
  setOld(path.join(SRC, 'data', 'media', H_B), 3 * 86400 * 1000)

  const r = (await runImport()) as any
  info('导入报告', JSON.stringify({ ok: r.ok, assoc: r.assoc, sessions: r.sessions.copied }))
  eq('mtimesweep：两个 blob 都导入了', r.assoc.media, 2)

  const dstA = path.join(DST, 'data', 'media', H_A)
  const dstB = path.join(DST, 'data', 'media', H_B)
  const srcMtime = fs.statSync(path.join(SRC, 'data', 'media', H_A)).mtimeMs
  const dstMtime = fs.statSync(dstA).mtimeMs
  info('mtime 对比', `源=${new Date(srcMtime).toISOString()} 目标=${new Date(dstMtime).toISOString()} 差=${(Math.abs(srcMtime - dstMtime) / 1000).toFixed(0)}s`)
  check(
    'mtimesweep：导入保留了源的旧 mtime（→ 1 小时宽限期不会生效）',
    Math.abs(dstMtime - srcMtime) < 5000 && dstMtime < Date.now() - 3600 * 1000,
    `dstMtime 距今 ${((Date.now() - dstMtime) / 3600000).toFixed(1)} 小时`
  )

  // 真跑一次启动清扫
  invalidateIndex()
  const ids = listSessions().map((m) => m.id)
  info('目标会话', JSON.stringify(ids))
  await sweepMedia()
  await sweepCheckpoints(ids)
  await sweepSubagents(ids)

  check('mtimesweep：被会话引用的 blob 未被删', fs.existsSync(dstA), 'A')
  check('mtimesweep：无引用的 blob 被立刻删掉（不是等 1 小时）', !fs.existsSync(dstB), `B exists=${fs.existsSync(dstB)}`)
  info(
    'mtimesweep 结论',
    '导入文件继承源 mtime，所以「1 小时宽限期保护刚导入的附件」这条不成立；真正保护附件的是「会话先落盘 + 被引用」'
  )
}

/* ═════════ race2：第二次导入时的旧快照覆盖 ═════════ */

async function scenarioRace2(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), {
    models: { providers: [{ id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [] }], activeModelId: 'imp-a:m1' }
  })
  writeJson(path.join(DST, 'config.json'), {
    models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null }
  })
  getConfig()
  registerConfigIpc(
    () => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any
  )
  const handlers: Map<string, Function> = (require('electron') as any).__test.ipcHandlers

  // 第 1 轮：正常导入
  const r1 = (await runImport()) as any
  const before = readJson(path.join(DST, 'config.json')).models.providers.map((p: any) => p.id).sort()
  info('第 1 轮后 providers', JSON.stringify(before))
  eq('race2：第 1 轮导入成功', [...r1.providers.copied].sort(), ['imp-a'])

  // 第 2 轮：本轮 copied 必然为空（都已存在）；此时渲染层手里若是**导入前的旧快照**，整段回写
  let midResult: any = null
  const r2 = (await runImport(async (p) => {
    if (p.step === 'sessions' && !midResult) {
      // 旧快照：只有 local-x，没有 imp-a
      midResult = await handlers.get('config:set')!({}, {
        models: { providers: [{ id: 'local-x', name: 'X', apiHost: 'https://x.invalid', models: [] }], activeModelId: null }
      })
    }
  })) as any
  info('第 2 轮 copied', JSON.stringify({ providers: r2.providers.copied, personas: r2.personas.copied }))
  check('race2：第 2 轮确实零新增（所以补回逻辑不触发）', r2.providers.copied.length === 0, String(r2.providers.copied.length))

  const after = readJson(path.join(DST, 'config.json')).models.providers.map((p: any) => p.id).sort()
  info('第 2 轮后 providers', JSON.stringify(after))
  check(
    'race2：旧快照覆盖后，导入的服务商仍在（补回逻辑是否兜住）',
    after.includes('imp-a'),
    `实际=${JSON.stringify(after)} 期望包含 imp-a`
  )
  if (!after.includes('imp-a')) {
    info(
      'race2 说明',
      '补回条件 `held.length && report.providers.copied.length` 在「本轮零新增」时不成立，所以旧快照的覆盖没被纠正'
    )
  }
  eq('race2：本轮 ok 仍为 true（界面不会亮红）', r2.ok, true)
  eq('race2：held 已解开', isConfigHeld(), false)

  // activeModelId 的取舍：导入设了 imp-a:m1，但被用户旧快照的 null 覆盖
  const cfgAfter = readJson(path.join(DST, 'config.json'))
  info('race2 最终 activeModelId', JSON.stringify(cfgAfter.models.activeModelId))
  check(
    'race2：activeModelId 未被旧快照清空（若被清空，用户导完还要重挑一次模型）',
    cfgAfter.models.activeModelId === 'imp-a:m1',
    `actual=${JSON.stringify(cfgAfter.models.activeModelId)}`
  )
}

/* ═════════ gateui：新闸门码在界面上显示什么（读代码） ═════════ */

async function scenarioGateUi(): Promise<void> {
  const pane = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/renderer/src/redesign/ImportPane.tsx'), 'utf8')
  const msgs = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/renderer/src/i18n/messages.ts'), 'utf8')

  // 闸门提示是怎么选文案的
  const m = pane.match(/\{gate\.code === '([a-z-]+)' \? t\('([^']+)'\) : t\('([^']+)'\)\}/)
  info('闸门文案选择逻辑', m ? m[0] : '（没匹配到，需人工看）')
  check('gateui：闸门只对 source-running 单独处理', !!m && m[1] === 'source-running', m?.[1] ?? '')

  // 新码有没有专属文案
  for (const code of ['same-home', 'source-unreadable']) {
    const inPane = pane.includes(`'${code}'`) || pane.includes(`"${code}"`)
    check(`gateui：界面里引用了闸门码 ${code}`, inPane, `ImportPane.tsx 是否出现 ${code}`)
  }
  check('gateui：界面未使用 gate.message（主进程的精确文案）', !/gate\.message/.test(pane), '')
  // i18n 里有没有这两个码的键
  for (const k of ['gateSameHome', 'gateUnreadable', 'gateSamehome', 'gateNoPermissions']) {
    if (msgs.includes(k)) info(`gateui：i18n 里有 ${k}`, '')
  }
  info(
    'gateui 结论',
    "界面把「非 source-running」一律当成 gateNoSource（『没有找到原版数据目录』），same-home 与 source-unreadable 会显示成误导文案"
  )

  // 失败清单有无截断上限
  const failureBlock = pane.slice(pane.indexOf('failures.length > 0'), pane.indexOf('failureHint'))
  info('失败清单渲染片段长度', String(failureBlock.length))
  check('gateui：失败清单逐条渲染（存在 failures.map）', /failures\.map\(/.test(failureBlock), '')
  check('gateui：失败清单没有像 detail 那样的 LIMIT', !/failures\.slice\(/.test(pane), '')
  const detailLimit = pane.match(/const DETAIL_LIMIT = (\d+)/)
  info('gateui：跳过明细的截断阈值', detailLimit?.[1] ?? '（无）')
}

/* ═════════ 入口 ═════════ */
const S: Record<string, () => Promise<void>> = {
  mtimesweep: scenarioMtimeSweep,
  race2: scenarioRace2,
  gateui: scenarioGateUi
}
async function main(): Promise<void> {
  const name = process.argv[2] || 'mtimesweep'
  const fn = S[name]
  if (!fn) {
    console.log(`FAIL 未知场景 ${name}`)
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
