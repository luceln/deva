/**
 * 导入报告 —— 构建浏览器验证页。
 *
 * 把真实的 `ImportPane` 打进 bundle，只替换 `importBridge`（IPC 桩）与 `store/extensions`。
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
      b.onResolve({ filter: /\/importBridge$/ }, () => ({ path: path.join(QA, 'stub-importbridge.js') }))
      b.onResolve({ filter: /\/store\/extensions$/ }, () => ({ path: path.join(QA, 'stub-extensions.js') }))
      // ImportPane 会引用 modelSettingsBus 打开设置；用例不跳转，给个空实现即可。
      b.onResolve({ filter: /\/modelSettingsBus$/ }, () => ({ path: path.join(QA, 'stub-settingsbus.js') }))
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
    logLevel: 'error',
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
<style>body{margin:0;background:var(--bg);font-family:sans-serif}</style>
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