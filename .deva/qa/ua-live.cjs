/**
 * 实测 UA：用与 provider 层**同一条代码路径**装配 headers，发一次真实 HTTP 请求，
 * 在服务端把收到的 headers 打出来。不是读常量自证——读的是网络上的真实字节。
 *
 * 跑法：node .deva/qa/ua-live.cjs
 */
const http = require('http')
const path = require('path')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '../..')
const STUB = path.join(__dirname, 'stub-electron.cjs')

async function main() {
  const out = path.join(REPO, 'dist', 'ua-live.cjs')
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'ua-live-entry.ts')],
    bundle: true,
    outfile: out,
    platform: 'node',
    format: 'cjs',
    alias: { electron: STUB },
    external: ['electron'],
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps/desktop/node_modules')],
    logLevel: 'silent'
  })

  const received = []
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/v1`

  const mod = await import(require('url').pathToFileURL(out).href)
  const result = await mod.probe(base)

  server.close()

  const h = received[0]?.headers ?? {}
  console.log('=== 实际收到的请求头 ===')
  console.log(JSON.stringify(received[0], null, 2))
  console.log('=== 断言 ===')
  const ua = h['user-agent'] ?? ''
  const pass1 = /^DevaPlus\/\d+\.\d+\.\d+/.test(ua)
  const pass2 = received.length === 1
  console.log(`${pass1 ? 'PASS' : 'FAIL'} UA 是 DevaPlus/<版本> :: ${JSON.stringify(ua)}`)
  console.log(`${pass2 ? 'PASS' : 'FAIL'} 确实发出了一次真实请求 :: count=${received.length}`)
  console.log('=== providerHeaders 直接返回 ===')
  console.log(JSON.stringify(result, null, 2))
  process.exit(pass1 && pass2 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
