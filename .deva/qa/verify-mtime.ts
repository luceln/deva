/**
 * 反向验证：P0-2 的 mtime 修复是不是真的在起作用（而不是清扫逻辑被改松了）。
 *
 * 思路：同一批数据，只改变「导入后目标文件的 mtime」这一个变量。
 *   A. 走真实导入 → 目标 mtime 应为「现在」→ 清扫不删
 *   B. 走真实导入后手工把目标 mtime 改回 60 天前 → 清扫应当删（证明清扫规则仍是按 mtime 判老）
 * 若 B 不删，说明清扫被改松了（断言被放松）；若 A 删了，说明修复无效。
 */
import * as fs from 'fs'
import * as path from 'path'

import { runImport } from '../../apps/desktop/src/main/importer'
import { registerConfigIpc } from '../../apps/desktop/src/main/services/config'
import { sweepCheckpoints } from '../../apps/desktop/src/main/services/checkpoints'

const HOME = process.env.TEST_HOME as string
const DST = process.env.DEVA_HOME as string
const SRC = path.join(HOME, '.deva')
const MODE = process.argv[2] || 'fresh' // fresh | stale

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

async function main(): Promise<void> {
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  writeJson(path.join(SRC, 'data', 'chats', 's-old.json'), { id: 's-old', title: 'x', messages: [], updatedAt: Date.now() })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // 源：3 个 checkpoint blob，mtime 60 天前
  const srcCk = path.join(SRC, 'data', 'checkpoints', 's-old')
  mkdirp(srcCk)
  const oldSec = Date.now() / 1000 - 60 * 24 * 3600
  for (const n of ['aaaa', 'bbbb', 'cccc']) {
    const f = path.join(srcCk, n)
    fs.writeFileSync(f, `content-${n}`)
    fs.utimesSync(f, oldSec, oldSec)
  }
  info('源 mtime（60 天前）', new Date(oldSec * 1000).toISOString())

  const r: any = await runImport()
  info('导入报告', JSON.stringify({ ok: r.ok, assoc: r.assoc }))

  const dstCk = path.join(DST, 'data', 'checkpoints', 's-old')
  const imported = fs.readdirSync(dstCk).sort()
  eq('导入：3 个 blob 都到位', imported, ['aaaa', 'bbbb', 'cccc'])

  // 关键观测：导入后目标 mtime 是「现在」还是「源的老时间」
  const dstMtimeMs = fs.statSync(path.join(dstCk, 'aaaa')).mtimeMs
  const ageHours = (Date.now() - dstMtimeMs) / 3600000
  info('导入后目标 blob 的年龄', `${ageHours.toFixed(2)} 小时`)
  check(
    `[${MODE}] 导入后 mtime 被刷新成「现在」（修复生效的直接证据）`,
    ageHours < 1,
    `age=${ageHours.toFixed(2)}h（若 ≈1440h 说明仍是源 mtime）`
  )

  if (MODE === 'stale') {
    // 把 mtime 打回 60 天前，其它一切不变
    const oldDate = new Date(Date.now() - 60 * 24 * 3600 * 1000)
    for (const n of imported) fs.utimesSync(path.join(dstCk, n), oldDate, oldDate)
    info('已把目标 mtime 手工改回 60 天前', oldDate.toISOString())
  }

  // 跑启动清扫（liveIds 含 s-old，排除「会话不存在」这一干扰因子）
  await sweepCheckpoints(['s-old'])
  const left = (() => {
    try {
      return fs.readdirSync(dstCk).sort()
    } catch {
      return []
    }
  })()
  info('清扫后剩余', JSON.stringify(left))

  if (MODE === 'fresh') {
    eq('清扫：mtime 为「现在」→ 一个都不删（修复目标）', left, ['aaaa', 'bbbb', 'cccc'])
  } else {
    eq('清扫：mtime 人为改回 60 天前 → 全被删（证明清扫仍按 mtime 判老，没被改松）', left, [])
  }
  process.exit(fails ? 1 : 0)
}
void main()
