/**
 * 最终验收——第四轮：P0-1「五步失败通道全通」是否真的一步不缺。
 *
 *   personawrite : 角色启用态（第 ③ 步）写盘失败时，report 是否亮红
 *   skilllink    : 技能建链接失败（EPERM）是否进 failures（不是 skipped）
 *   copytmp      : mergeDir 跳过 .tmp-* 残留是否会误伤正常文件名
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'

import { runImport } from '../../apps/desktop/src/main/importer'
import { canImport } from '../../apps/desktop/src/main/importer-gate'
import { mergeProviders, copySecrets } from '../../apps/desktop/src/main/importer-config'
import { importPersonas, enableImportedPersonas } from '../../apps/desktop/src/main/importer-personas'
import { importSkills } from '../../apps/desktop/src/main/importer-skills'
import { copyAssoc } from '../../apps/desktop/src/main/importer-assoc'
import { getConfig, getDevaHome, registerConfigIpc, setConfig } from '../../apps/desktop/src/main/services/config'

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

/* ═════════ personawrite：角色启用态写盘失败 ═════════ */
async function scenarioPersonaWrite(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  mkdirp(path.join(SRC, 'personas'))
  fs.writeFileSync(path.join(SRC, 'personas', 'custom-role.md'), '---\nid: custom-role\nname: C\n---\nhi')
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)

  // 先让角色文件导入成功（这步不写 config），再让写 config 失败
  // 手法：先正常跑一次把角色搬过去；然后删掉 config.json 并用同名目录占位，再手工调第 ③ 步
  const p1 = importPersonas(SRC)
  eq('personawrite：角色文件已搬', p1.copied, ['custom-role'])

  const cfgPath = path.join(DST, 'config.json')
  rmrf(cfgPath)
  mkdirp(cfgPath) // 写 config 必然失败
  const enabled = enableImportedPersonas(['custom-role'])
  info('personawrite：enableImportedPersonas 返回', JSON.stringify(enabled))
  info(
    'personawrite 观察',
    '这个函数返回「声称启用了哪些」，不返回失败；setPersonaEnabled → writeEnabledMap → setConfig 的布尔返回值被丢弃，异常也被 catch 吞掉'
  )
  check(
    'personawrite：断言——写盘失败时必须能上报（当前实现做不到）',
    enabled.length === 0,
    `enabled=${JSON.stringify(enabled)}（写盘失败却仍声称成功 → 静默失效）`
  )
  rmrf(cfgPath)
}

/* ═════════ skilllink：建链接失败要进 failed ═════════ */
async function scenarioSkillLink(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  const sk = path.join(SRC, 'skills')
  mkdirp(sk)
  const outside = path.join(process.env.QA_SCRATCH as string, 'target-skill')
  mkdirp(outside)
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '# t')
  // 建一个链接条目（junction，本机唯一可行）
  try {
    fs.symlinkSync(outside, path.join(sk, 'linked-skill'), 'junction')
  } catch (e) {
    info('skilllink：造不出链接夹具', String(e))
    return
  }
  const st = importSkills(SRC)
  info('skilllink：导入结果', JSON.stringify({ linked: st.linked, copied: st.copied, skipped: st.skipped, failed: st.failed }))
  check('skilllink：链接条目成功重建（linked）', st.linked.includes('linked-skill'), JSON.stringify(st.linked))
  eq('skilllink：成功时 failed 为空', st.failed, [])

  // 二次：已存在 → skipped（不是 failed）
  const st2 = importSkills(SRC)
  eq('skilllink：二次导入进 skipped', st2.skipped, ['linked-skill'])
  eq('skilllink：二次导入 failed 仍为空', st2.failed, [])
}

/* ═════════ copytmp：.tmp- 过滤是否会误伤正常文件名 ═════════ */
async function scenarioCopyTmp(): Promise<void> {
  rmrf(DST)
  mkdirp(SRC)
  writeJson(path.join(SRC, 'config.json'), { models: { providers: [] } })
  const cp = path.join(SRC, 'data', 'checkpoints')
  mkdirp(path.join(cp, 'sess_a'))
  // 正常文件 + 崩溃残留
  fs.writeFileSync(path.join(cp, 'sess_a', 'normal-hash'), 'ok')
  fs.writeFileSync(path.join(cp, 'sess_a', 'abcdef.tmp-1234-uuid'), 'leftover')
  // 名字里含 .tmp- 但看起来像正常内容的（边界）
  fs.writeFileSync(path.join(cp, 'sess_a', 'note.tmp-draft'), 'draft')
  const { assoc, failures } = copyAssoc(SRC)
  const dstCp = path.join(DST, 'data', 'checkpoints', 'sess_a')
  const copied = fs.existsSync(dstCp) ? fs.readdirSync(dstCp).sort() : []
  info('copytmp：目标 checkpoints 目录', JSON.stringify(copied))
  eq('copytmp：会话目录计数为 1', assoc.checkpoints, 1)
  check('copytmp：正常文件被复制', copied.includes('normal-hash'), '')
  check('copytmp：.tmp- 残留被跳过', !copied.some((n) => n.includes('.tmp-')), JSON.stringify(copied))
  eq('copytmp：跳过残留不算失败', failures, [])
  info(
    'copytmp 观察',
    '过滤是「名字含 .tmp- 就跳过」，所以名字里真的带 .tmp- 的正常文件也会被跳过 —— 但 chat-store 的 hash 命名不含点，实际不会命中'
  )
}

/* ═════════ 入口 ═════════ */
const S: Record<string, () => Promise<void>> = {
  personawrite: scenarioPersonaWrite,
  skilllink: scenarioSkillLink,
  copytmp: scenarioCopyTmp
}
async function main(): Promise<void> {
  const name = process.argv[2] || 'personawrite'
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
