const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')

async function build() {
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
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')]
  })
  console.log('bundle ok')

  const css = fs.existsSync(path.join(QA, 'bundle.css')) ? fs.readFileSync(path.join(QA, 'bundle.css'), 'utf8') : ''
  fs.writeFileSync(
    path.join(QA, 'page.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>MERGE</title><style>${css}
<style>html,body{margin:0;font-family:system-ui;background:#1e1e1e;color:#ddd}</style></style></head>
<body><script src="./deva-stub.js"></script><script>${fs.readFileSync(path.join(QA, 'bundle.js'), 'utf8')}</script>
<script>window.__runTest()</script></body></html>`
  )
  console.log('page ok')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
