/**
 * 流式滚动跳变 —— 构建诊断页（只读排查用）。
 *
 * 把真实的 `Conversation` 打进 bundle，只替换 `store/chat` / `store/models` / `store/extensions` 等重依赖。
 * 产出 page.html，用浏览器打开看 `window.__logs` 的轨迹数据。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src')

async function build() {
  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /\/store\/chat$/ }, () => ({ path: path.join(QA, 'stub-chat.js') }))
      b.onResolve({ filter: /\/store\/models$/ }, () => ({ path: path.join(QA, 'stub-models.js') }))
      b.onResolve({ filter: /\/store\/extensions$/ }, () => ({ path: path.join(QA, 'stub-extensions.js') }))
      b.onResolve({ filter: /\/features\/browser\/shared$/ }, () => ({ path: path.join(QA, 'stub-browser.js') }))
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
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubPlugin],
    logLevel: { warnings: 'error', errors: 'error' } && 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')]
  })
  console.log('bundle ok')

  const read = (p) => fs.readFileSync(p, 'utf8')
  const css = [
    path.join(SRC, 'styles', 'tokens.css'),
    path.join(SRC, 'styles', 'app.css'),
    path.join(SRC, 'redesign', 'redesign.css')
  ]
    .map((p) => `<style>${read(p)}</style>`)
    .join('\n')

  fs.writeFileSync(
    path.join(QA, 'page.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>RUN</title>
${css}
<style>
  /* 让 .cf-conv 有确定高度：产品里它由 flex 外壳撑满，这里给固定视口 */
  html,body{margin:0;height:100%;background:var(--bg);font-family:sans-serif}
  #root{height:100%}
  .cf-conv{height:100%;display:flex;flex-direction:column}
</style>
</head><body><div id="root"></div>
<script>
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message || e.error || e)); });
</script>
<script>${read(path.join(QA, 'deva-stub.js'))}</script>
<script>
try {
${read(path.join(QA, 'bundle.js'))}
} catch (e) { window.__errors.push('bundle threw: ' + (e && (e.stack || e.message))); }
</script>
<script>${read(path.join(QA, 'test.ts'))}</script>
</body></html>`
  )
  console.log('page ok')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
