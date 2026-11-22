/**
 * 导入新状态（indexStale / superseded / pluginManaged）—— 构建浏览器验证页。
 *
 * 与 `.deva/qa/import-report/` 的分工：那边验 unrecoverable / rekeyed，这边只验本批新接的三项。
 * 从**当前工作区**取的源码路径（相对本脚本），不写死别的工作区。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src')

async function build() {
  const stubPlugin = {
    name: 'stub-modules',
    setup(b) {
      b.onResolve({ filter: /\/importBridge$/ }, () => ({ path: path.join(QA, 'stub-importbridge.js') }))
      b.onResolve({ filter: /\/store\/extensions$/ }, () => ({ path: path.join(QA, 'stub-extensions.js') }))
      b.onResolve({ filter: /\/store\/chat$/ }, () => ({ path: path.join(QA, 'stub-chat.ts') }))
      b.onResolve({ filter: /\/store\/models$/ }, () => ({ path: path.join(QA, 'stub-models.ts') }))
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
</head><body>
<script>
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message || e.error || e)); });
/* 必须早于 bundle：模块顶层会读 window.deva.platform；locale 固定为 zh-CN，英文用例由 __setLocale 切。 */
window.deva = { platform: 'win32', config: { getSync: function () { return { locale: 'zh-CN' }; }, set: function () {} } };
</script>
<script>
try {
${read(path.join(QA, 'bundle.js'))}
} catch (e) { window.__errors.push('bundle threw: ' + (e && (e.stack || e.message))); }
</script>
<script>${read(path.join(QA, 'test.js'))}</script>
</body></html>`
  )
  console.log('page ok')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})