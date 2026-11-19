/**
 * 最小复现：`report.providers.pluginManaged` 被 importer.ts 汇总时漏掉。
 *
 * 判据：`mergeProviders(src)` 自己能算出 pluginManaged（importer-config.ts:174 push），
 * 但 `runImport()` 返回的 `report.providers` 里没有这个字段。
 * 对照：同一轮里的 `report.secrets.pluginManaged` 是有的（importer.ts:207）——说明不是判定失败，是漏拷。
 */
import * as fs from 'fs'
import * as path from 'path'

import { runImport } from '../../apps/desktop/src/main/importer'
import { mergeProviders } from '../../apps/desktop/src/main/importer-config'
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
const eq = (n: string, a: unknown, e: unknown): void => {
  const A = JSON.stringify(a)
  const E = JSON.stringify(e)
  const ok = A === E
  ok ? pass(n, A) : fail(n, `${A} ≠ ${E}`)
  if (!ok) fails += 0
  return ok
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

  // 源：插件托管一个 provider（用非 magpie 的 id，证明不靠硬编码），外加一个用户自己的
  writeJson(path.join(SRC, '.magpie-agent.state.json'), { providerId: 'gw-relay-7', ownedSecret: true })
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: [
        { id: 'gw-relay-7', name: 'plugin', apiHost: 'http://127.0.0.1:3425/v1', models: [] },
        { id: 'my-own', name: 'mine', apiHost: 'https://x.invalid', models: [] }
      ]
    }
  })
  writeJson(path.join(SRC, 'secrets.json'), { 'gw-relay-7': 'x', 'my-own': 'y' })
  mkdirp(DST)
  writeJson(path.join(DST, 'config.json'), { models: { providers: [] } })

  // ① mergeProviders 自己算得出
  const direct = mergeProviders(SRC)
  info('mergeProviders 直出', JSON.stringify({ copied: direct.copied, pluginManaged: direct.pluginManaged }))
  eq('① mergeProviders 算出 pluginManaged', direct.pluginManaged, ['gw-relay-7'])
  eq('① mergeProviders 没把它算进 copied', direct.copied, ['my-own'])

  // ② runImport 报告里丢了它
  const r: any = await runImport()
  info('runImport 的 providers 字段', JSON.stringify(Object.keys(r.providers ?? {})))
  info('report.providers.pluginManaged', JSON.stringify(r.providers?.pluginManaged))
  info('report.secrets.pluginManaged', JSON.stringify(r.secrets?.pluginManaged))
  eq('② report.providers.pluginManaged 应当等于 mergeProviders 的结果（当前为 undefined/缺失）', r.providers?.pluginManaged, ['gw-relay-7'])
  eq('② 对照：report.secrets.pluginManaged 是有的（证明判定没问题，是汇总漏拷）', r.secrets?.pluginManaged, ['gw-relay-7'])

  // ③ 后果：界面据此渲染「插件托管」那一行，字段缺失 → 用户看不到这条
  check3()
  function check3(): void {
    const has = 'pluginManaged' in (r.providers ?? {})
    if (has) pass('③ report.providers 里有这个键')
    else fail('③ report.providers 里没有这个键 → 界面无法显示「N 个服务商归插件管」')
  }

  console.log(`=== 结束：FAIL ${fails} ===`)
  process.exit(fails ? 1 : 0)
}
void main()
