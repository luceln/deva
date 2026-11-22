const path = require('path')
const puppeteer = require(path.join(process.cwd(), 'node_modules', 'puppeteer'))

async function probe(loc) {
  const b = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=' + loc]
  })
  const p = await b.newPage()
  await p.setExtraHTTPHeaders({ 'Accept-Language': loc })
  const rel = '.deva/qa/insert-attach/page.html'
  const abs = path.resolve(process.cwd(), rel).split(path.sep).join('/')
  await p.goto('file://' + abs)
  await new Promise(function (r) { setTimeout(r, 3000) })
  const r = await p.evaluate(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('.cf-composer button'))
    var labels = btns.map(function (x) { return x.getAttribute('aria-label') }).filter(Boolean)
    return { lang: document.documentElement.lang, labels: labels }
  })
  console.log(loc + ' => ' + JSON.stringify(r))
  await b.close()
}

;(async function () {
  await probe('en')
  await probe('zh-CN')
})()
