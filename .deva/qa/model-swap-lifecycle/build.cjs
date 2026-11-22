const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const out = path.join(__dirname, '.artifacts')
fs.mkdirSync(out, { recursive: true })
// No resolve plugins, module replacements or source instrumentation: actual ChatProvider actions are bundled unchanged.
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'entry.jsx')],
  bundle: true,
  outfile: path.join(out, 'bundle.js'),
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [path.resolve(__dirname, '../../../apps/desktop/node_modules')]
})
fs.writeFileSync(path.join(out, 'page.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Real ModelPanel + ChatProvider lifecycle</title><link rel="stylesheet" href="bundle.css"></head><body>
<script>window.lifecycleErrors=[];window.addEventListener('error',e=>window.lifecycleErrors.push(String(e.error||e.message)));window.addEventListener('unhandledrejection',e=>window.lifecycleErrors.push(String(e.reason)));window.deva={platform:'win32'};</script>
<script src="bundle.js"></script></body></html>`)
console.log('Lifecycle harness built without module stubs:', path.join(out, 'page.html'))
