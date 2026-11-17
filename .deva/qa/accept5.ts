/**
 * 最终验收——第五轮：整轮视角下「第 ③ 步写盘失败」是否被兜住。
 * 手法：让 config.json 不可写，但角色 md 能落盘（角色目录正常），看整轮 report 是否亮红。
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

async function main(): Promise<void> {
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  mkdirp(path.join(SRC, 'personas'))
  fs.writeFileSync(path.join(SRC, 'personas', 'role-a.md'), '---\nid: role-a\nname: A\n---\nhi')
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)

  // 让目标 config.json 不可写：用同名目录占位（personas 目录保持正常可写）
  mkdirp(DST)
  mkdirp(path.join(DST, 'config.json'))

  const r = (await runImport()) as any
  info('整轮报告', JSON.stringify({ ok: r.ok, personaEnabled: r.personaEnabled, personas: r.personas, providers: r.providers, failures: r.failures }))
  check('第③步：角色文件确实搬了', r.personas.copied.includes('role-a'), JSON.stringify(r.personas.copied))
  // 修前：这里「声称已启用」（personaEnabled 含 role-a）而磁盘上什么都没写——正是被修掉的静默失效。
  // 修后：写盘失败的角色不再进 personaEnabled，而是进 failures（带 step=personaEnabled）。
  eq('第③步：写盘失败时不再谎报已启用', r.personaEnabled, [])
  eq(
    '第③步：角色启用态写盘失败进了 failures（step=personaEnabled）',
    r.failures.filter((f: any) => f.step === 'personaEnabled').map((f: any) => [f.id, f.reason]),
    [['role-a', 'config-write-failed']]
  )
  eq(
    '第③步：报告里有 config-write-failed（这一步自己上报的，不再依赖 providers 兜住）',
    r.failures.some((f: any) => f.reason === 'config-write-failed'),
    true
  )
  info(
    '第③步 结论',
    '现在这一步自己上报失败（step=personaEnabled），不再靠 providers 的同等失败碰巧把 ok 压成 false'
  )
  eq('第③步：整轮 ok=false', r.ok, false)

  // 反证：源里没有服务商可导时，providers 不会尝试写盘，第③步的失败就完全没有声音
  const fs2 = require('fs')
  fs2.rmSync(path.join(DST, 'config.json'), { recursive: true, force: true })
  fs2.rmSync(path.join(DST, 'personas'), { recursive: true, force: true })
  mkdirp(path.join(DST, 'config.json'))
  // 源里 providers 为空 → mergeProviders 不会写盘
  const r2 = (await runImport()) as any
  info('反证报告', JSON.stringify({ ok: r2.ok, personaEnabled: r2.personaEnabled, personas: r2.personas.copied, failures: r2.failures }))
  check(
    '反证：没有服务商可导时，第③步写盘失败是否让 ok=false',
    r2.ok === false,
    `ok=${r2.ok}（若为 true，说明角色启用态静默失败：文件在、角色停用、界面说导入完成）`
  )
  process.exit(fails ? 1 : 0)
}
void main()
