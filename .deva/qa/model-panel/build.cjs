/**
 * 模型面板失效标红 —— 构建 + 打包成单页。
 *
 * 用 esbuild 把真实的 ModelPanel（含 ModelMenu / ModelSwapDialog / clampEffort / context-usage）
 * 打进浏览器 bundle，只把 store/chat、store/models 换成桩（理由见两个 stub 文件头）。
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
  fs.writeFileSync(
    entry,
    `
import { createRoot } from 'react-dom/client'
import { ModelPanel } from '${p('redesign/ModelPanel')}'
import { I18nProvider } from '${p('i18n/i18n')}'
import { ToastProvider } from '${p('components/ToastProvider')}'
import { DialogProvider } from '${p('components/DialogProvider')}'

let root = null
let host = null

window.__mount = () => {
  host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:200px;bottom:120px'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <I18nProvider>
      <ToastProvider>
        <DialogProvider>
          <ModelPanel />
        </DialogProvider>
      </ToastProvider>
    </I18nProvider>
  )
}

window.__unmount = () => {
  if (root) root.unmount()
  if (host) host.remove()
  root = null
  host = null
}
`
  )

  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /\/store\/chat$/ }, () => ({ path: path.join(QA, 'stub-chat.ts') }))
      b.onResolve({ filter: /\/store\/models$/ }, () => ({ path: path.join(QA, 'stub-models.ts') }))
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
  const mp = fs.readFileSync(path.join(SRC, 'redesign', 'model-panel.css'), 'utf8')
  const test = fs.readFileSync(path.join(QA, 'test.ts'), 'utf8')
  fs.writeFileSync(
    path.join(QA, 'page.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>RUN</title>
<style>${tokens}</style><style>${css}</style><style>${red}</style><style>${mp}</style>
<style>body{margin:0;padding:240px 40px;font-family:sans-serif;background:var(--bg)}</style>
</head><body><div id="root"></div>
<script>
/* 必须早于 bundle：模块顶层会读 window.deva.platform（shell-common 的 IS_MAC）。 */
window.deva = { platform: 'win32', chat: {}, config: {} }
</script>
<script>${fs.readFileSync(path.join(QA, 'bundle.js'), 'utf8')}</script>
<script>${test}</script>
</body></html>`
  )
  console.log('page ok → page.html')
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
