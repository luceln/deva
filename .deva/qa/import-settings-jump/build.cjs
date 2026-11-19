/**
 * 「去设置 › 模型重填」点击实测 —— 构建脚本。
 *
 * 把**真实的 Settings 面板**（含真实 ImportPane、真实 GeneralPane 等）打进 bundle，
 * 只替换 importBridge（IPC 桩）与 store/extensions（不需要真实扩展列表）。
 * modelSettingsBus 用**真实实现**——这次要验的就是它。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')

async function build() {
  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /\/importBridge$/ }, () => ({ path: path.join(REPO, '.deva/qa/import-report/stub-importbridge.js') }))
      b.onResolve({ filter: /\/store\/extensions$/ }, () => ({ path: path.join(REPO, '.deva/qa/import-report/stub-extensions.js') }))
    }
  }
  await esbuild.build({
    entryPoints: [path.join(QA, 'entry.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: path.join(QA, 'bundle.js'),
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubPlugin],
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')]
  })
  console.log('bundle ok')

  const css = fs.readFileSync(path.join(QA, 'bundle.css'), 'utf8')
  fs.writeFileSync(
    path.join(QA, 'page.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>JUMP</title><style>${css}</style>
<style>html,body{margin:0}#host{width:1200px;height:900px}</style></head>
<body><script src="./deva-stub.js"></script><script>${fs.readFileSync(path.join(QA, 'bundle.js'), 'utf8')}</script>
<script>
window.__mount();
</script></body></html>`
  )
  console.log('page ok')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
