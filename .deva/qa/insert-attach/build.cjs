/**
 * 插话带附件 —— 构建 + 打包成单页（需浏览器，手动跑）。
 *
 * 用 esbuild 把**真实的 `Composer.tsx`**（含 Lexical 编辑器、附件条、胶囊）打进浏览器 bundle，
 * 只把三个重依赖换成桩（`store/chat`、`store/extensions`、`features/browser/shared`）：
 * 真实 ChatProvider 挂载会打一串 IPC，且「回合进行中」无法从外部构造，而本用例恰恰要验它。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src')

async function build() {
  const p = (s) => path.join(SRC, s).replace(/\\/g, '/')
  const entry = path.join(QA, 'entry.tsx')
  // 入口里用绝对路径 import（同 model-panel 的做法），这里只做替换桩的解析。
  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /\/store\/chat$/ }, () => ({ path: path.join(QA, 'stub-chat.ts') }))
      b.onResolve({ filter: /\/store\/extensions$/ }, () => ({ path: path.join(QA, 'stub-extensions.ts') }))
      b.onResolve({ filter: /\/store\/models$/ }, () => ({ path: path.join(QA, 'stub-models.ts') }))
      b.onResolve({ filter: /\/features\/browser\/shared$/ }, () => ({ path: path.join(QA, 'stub-browser.ts') }))
      b.onResolve({ filter: /\/features\/browser\/BrowserCapsule$/ }, () => ({
        path: path.join(QA, 'stub-browsercapsule.ts')
      }))
    }
  }

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: path.join(QA, 'bundle.js'),
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubPlugin],
    logLevel: 'warning',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')]
  })
  console.log('bundle ok → bundle.js')

  const css = fs.readFileSync(path.join(SRC, 'styles', 'app.css'), 'utf8')
  const tokens = fs.readFileSync(path.join(SRC, 'styles', 'tokens.css'), 'utf8')
  const red = fs.readFileSync(path.join(SRC, 'redesign', 'redesign.css'), 'utf8')
  const capsule = fs.readFileSync(path.join(SRC, 'features', 'browser', 'capsule.css'), 'utf8')
  const test = fs.readFileSync(path.join(QA, 'test.ts'), 'utf8')
  fs.writeFileSync(
    path.join(QA, 'page.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>RUN</title>
<style>${tokens}</style><style>${css}</style><style>${red}</style><style>${capsule}</style>
<style>body{margin:0;padding:120px 40px;font-family:sans-serif;background:var(--bg)}</style>
</head><body><div id="root"></div>
<script>
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message || e.error || e)) });
</script>
<script>${fs.readFileSync(path.join(QA, 'deva-stub.js'), 'utf8')}</script>
<script>
try {
${fs.readFileSync(path.join(QA, 'bundle.js'), 'utf8')}
} catch (e) { window.__errors.push('bundle threw: ' + (e && (e.stack || e.message))) }
</script>
<script>${test}</script>
</body></html>`
  )
  console.log('page ok → page.html')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})