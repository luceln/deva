import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/**
 * MCP 所有权判据（第三批·3，审查 P2-13）。
 *
 * 旧实现拿**provider id 的并集**去排除 **MCP server id**——两个独立命名空间。实例：某 home 声明插件
 * provider 叫 `relay`，源里又有用户自配、与插件无关的 MCP server 也叫 `relay` → 正常 MCP 被误排，
 * 界面还告诉用户「归插件管」。
 *
 * 新判据：只认插件**显式声明**的 MCP 所有权（状态文件的 `mcpServers` 字段）；没有声明就一律不排除。
 * 无法确认归属时不排除，代价是可能多一条可删的死条目——那是可见的，而误排用户自己的服务是不可见的。
 */
export async function mcpOwnership(eq: Eq): Promise<void> {
  const home = process.env.DEVA_HOME!
  fs.mkdirSync(home, { recursive: true })
  const PL = await import('../../apps/desktop/src/main/services/plugin-managed')
  const { importMcp } = await import('../../apps/desktop/src/main/importer-mcp')

  const src = path.join(home, 'own-src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(
    path.join(src, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        relay: { name: '用户自配的中转', transport: 'http', url: 'https://relay.example/mcp' },
        context7: { name: 'context7', transport: 'http', url: 'https://c7.example/mcp' }
      }
    })
  )

  // ① 插件只声明了 provider 叫 relay，没声明任何 MCP 所有权
  fs.writeFileSync(path.join(src, '.magpie-agent.state.json'), JSON.stringify({ providerId: 'relay', ownedSecret: true }))
  eq('ownership: provider 集合里有 relay', PL.pluginManagedProviderIds([src]).has('relay'), true)
  eq('ownership: MCP 集合为空（插件没有声明）', [...PL.pluginOwnedMcpIds([src])], [])

  const st = importMcp(src)
  eq('ownership: 同名但实为用户自配的 MCP 必须正常导入', st.copied.includes('relay'), true)
  eq('ownership: 不带进 pluginManaged', st.pluginManaged ?? [], [])
  const dstMcp = JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, unknown>
  }
  eq('ownership: 目标里确实有这条 MCP', 'relay' in (dstMcp.mcpServers ?? {}), true)
  eq('ownership: URL 原样搬过来', (dstMcp.mcpServers?.relay as { url?: string })?.url, 'https://relay.example/mcp')

  // ② 插件显式声明 MCP 所有权时，仍要排除（判据由声明驱动，不是无条件放行）
  fs.writeFileSync(
    path.join(src, '.magpie-agent.state.json'),
    JSON.stringify({ providerId: 'relay', ownedSecret: true, mcpServers: ['relay'] })
  )
  eq('ownership: 声明后 MCP 集合里有 relay', [...PL.pluginOwnedMcpIds([src])], ['relay'])
  fs.rmSync(path.join(home, 'mcp.json'), { force: true })
  const st2 = importMcp(src)
  eq('ownership: 明确声明的条目被排除', st2.pluginManaged ?? [], ['relay'])
  eq('ownership: 排除时不算 copied', st2.copied.includes('relay'), false)
  const dst2 = JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, unknown>
  }
  eq('ownership: 目标里没有它', 'relay' in (dst2.mcpServers ?? {}), false)
  eq('ownership: 无关条目照常导入', st2.copied.includes('context7'), true)

  // ③ 声明类型不对（字符串而非数组 / 数字）→ 不认，避免把用户的服务误排
  fs.writeFileSync(
    path.join(src, '.magpie-agent.state.json'),
    JSON.stringify({ providerId: 'relay', mcpServers: 'relay' })
  )
  eq('ownership: 非数组声明不认', [...PL.pluginOwnedMcpIds([src])], [])
  fs.rmSync(path.join(home, 'mcp.json'), { force: true })
  const st3 = importMcp(src)
  eq('ownership: 非数组声明时照常导入', st3.copied.includes('relay'), true)

  // ④ 状态文件读不出来 → 什么都不排除（不因读失败丢用户的服务）
  fs.writeFileSync(path.join(src, '.magpie-agent.state.json'), '{半截')
  eq('ownership: 状态文件坏时集合为空', [...PL.pluginOwnedMcpIds([src])], [])
  fs.rmSync(path.join(home, 'mcp.json'), { force: true })
  eq('ownership: 状态文件坏时照常导入', importMcp(src).copied.includes('relay'), true)
}
