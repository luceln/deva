import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown
const home = () => process.env.DEVA_HOME!
const cfgFile = () => path.join(home(), 'config.json')
const patch = (srv: boolean): Record<string, unknown> => ({ mcp: { enabled: { srv }, servers: {} } })

/**
 * 配置写入守卫（第二批·一）。
 *
 * 现状：`setConfig` 只信内存里的载入结果。于是
 *  - config.json 内容坏时 `ensureLoaded` 折成 `{}`，同一轮里 MCP 启用 / 角色启用会把整份文件覆盖成
 *    「空配置 + 这次补丁」，用户原有的键（这里用 `original_private_setting` 代表）永久丢失；
 *  - 目标文件坏或读不出时一个字节都不该动，且失败要能区分；
 *  - 被本次补丁覆盖的键若在磁盘上已被外部改过，整次写入必须取消，不能局部成功。
 *
 * 每个用例都在**独立子进程**里跑：`config` 的载入态与 `lastWritten` 基线都是模块级状态，同进程换目录会
 * 读到上一段的结论（本仓库踩过这个坑）。子进程按 `CFG_STEP` 分派。
 */
export async function configWriteGuard(eq: Eq): Promise<void> {
  const step = process.env.CFG_STEP ?? ''
  const cfg = await import('../../apps/desktop/src/main/services/config')
  /*
   * 适配层：修复前只有布尔 `setConfig`。用它跑同一批行为断言——这样基线红的是**真实缺陷**
   * （磁盘被覆盖 / 外部改动被静默顶掉），而不是「新 API 不存在」这种同义反复。
   */
  const write = (p: Record<string, unknown>): { ok: boolean; code?: string } => {
    const fn = (cfg as { setConfigDetailed?: (x: Record<string, unknown>) => { ok: boolean; code?: string } })
      .setConfigDetailed
    if (fn) return fn(p)
    const ok = (cfg as { setConfig: (x: Record<string, unknown>) => boolean }).setConfig(p)
    return ok ? { ok } : { ok, code: 'config-write-failed' }
  }
  fs.mkdirSync(home(), { recursive: true })

  if (step === 'corrupt') {
    fs.writeFileSync(cfgFile(), '{"original_private_setting":"MUST_SURVIVE"')
    const broken = fs.readFileSync(cfgFile(), 'utf8')
    const r = write(patch(true))
    eq('corrupt: write refused', r.ok, false)
    eq('corrupt: reason is unreadable', r.ok ? null : r.code, 'config-unreadable')
    eq('corrupt: disk bytes untouched', fs.readFileSync(cfgFile(), 'utf8'), broken)
    eq('corrupt: memory not polluted by the patch', cfg.getConfig().mcp, undefined)
  }

  if (step === 'heal') {
    // 上一次写入被拒（坏文件）之后，用户把文件修好：必须能恢复写入，且原有关键字活下来。
    fs.writeFileSync(cfgFile(), '{bad')
    write(patch(true))
    fs.writeFileSync(cfgFile(), JSON.stringify({ original_private_setting: 'MUST_SURVIVE' }))
    const r = write(patch(true))
    eq('healed: write succeeds', r.ok, true)
    const disk = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))
    eq('healed: unknown key survives', disk.original_private_setting, 'MUST_SURVIVE')
    eq('healed: patch applied', disk.mcp.enabled.srv, true)
  }

  if (step === 'conflict') {
    // 先成功写一次建立基线，再由「外部」改动同一批键。
    eq('conflict: baseline write ok', write({ ...patch(false), skills: { enabled: {} } }).ok, true)
    fs.writeFileSync(cfgFile(), JSON.stringify({
      original_private_setting: 'MUST_SURVIVE',
      mcp: { enabled: { srv: false }, servers: {} },
      skills: { enabled: { external: true } }
    }))
    const before = fs.readFileSync(cfgFile(), 'utf8')
    const r = write({ ...patch(true), skills: { enabled: {} } })
    eq('conflict: whole patch refused', r.ok, false)
    eq('conflict: reason distinguishes external change', r.ok ? null : r.code, 'config-changed-externally')
    eq('conflict: nothing written', fs.readFileSync(cfgFile(), 'utf8'), before)
    eq('conflict: untouched key from the same patch also not written', (cfg.getConfig().mcp as any)?.enabled?.srv, false)
  }

  if (step === 'deleted') {
    eq('deleted: baseline write ok', write(patch(false)).ok, true)
    fs.rmSync(cfgFile(), { force: true })
    const r = write(patch(true))
    eq('deleted: write refused', r.ok, false)
    eq('deleted: reason distinguishes external change', r.ok ? null : r.code, 'config-changed-externally')
    eq('deleted: file not recreated', fs.existsSync(cfgFile()), false)
  }

  if (step === 'fresh') {
    // 从来没有过基线 = 真的首次初始化，必须能写第一份。
    eq('fresh: first write allowed', write(patch(true)).ok, true)
    eq('fresh: file created', fs.existsSync(cfgFile()), true)
  }

  if (step === 'mergebase') {
    /*
     * `mergeModelsPatch` 是纯函数，但它的「磁盘基准」必须是磁盘当前内容：内存态里若还留着旧 providers，
     * 渲染层整段回写的陈旧快照会把主进程刚并入的服务商抹掉。这里先让磁盘上多一个内存不知道的 provider。
     */
    write({ models: { providers: [{ id: 'kept-from-disk' }], activeModelId: '' } })
    fs.writeFileSync(cfgFile(), JSON.stringify({
      models: { providers: [{ id: 'kept-from-disk' }, { id: 'disk-only' }], activeModelId: '' }
    }))
    const merged = cfg.mergeModelsPatch({ models: { providers: [{ id: 'kept-from-disk' }], activeModelId: 'x:y' } })
    const ids = ((merged.models as any).providers as Array<{ id: string }>).map((p) => p.id)
    eq('merge base: provider that only exists on disk is kept', ids.includes('disk-only'), true)
    eq('merge base: incoming sibling field wins', (merged.models as any).activeModelId, 'x:y')
  }

  // 子进程（CFG_STEP 非空）只跑自己那一段就结束，不能再往下派生。
  if (step) return

  // 派生子进程跑各个用例。
  const { spawnSync } = await import('child_process')
  const run = (name: string, extraEnv: Record<string, string> = {}): { code: number; out: string } => {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'cfgwrite'], {
      env: { ...process.env, CFG_STEP: name, DEVA_HOME: path.join(home(), `sub-${name}`), ...extraEnv },
      encoding: 'utf8'
    })
    return { code: child.status ?? -1, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
  }
  const expectPass = (name: string, extraEnv: Record<string, string> = {}): void => {
    const r = run(name, extraEnv)
    eq(`cfgwrite/${name}: sub-process exit 0`, r.code, 0)
    if (r.out.includes('FAIL ')) eq(`cfgwrite/${name}: no failed assertion`, r.out.split('\n').filter((l) => l.startsWith('FAIL ')), [])
  }
  expectPass('corrupt')
  expectPass('heal')
  expectPass('conflict')
  expectPass('deleted')
  expectPass('fresh')
  expectPass('mergebase')
}
