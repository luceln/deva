/**
 * QA 共享：读 i18n 词条的**运行时值**，而不是去扫源码文本。
 *
 * ## 为什么要有这个文件
 *
 * 早先多个 QA 脚本（`check-deps-fail-note` / `check-import-rekey` / `check-insert-attachments` /
 * `check-worktree-fields`）各自把 `i18n/messages.ts` 的路径写死，再用正则从文件文本里抠词条：
 *
 * ```js
 * const MSG = path.join(REPO, 'apps','desktop','src','renderer','src','i18n','messages.ts')
 * const hits = [...readFileSync(MSG,'utf8').matchAll(/stillUsable:\s*'([^']*)'/g)]
 * ```
 *
 * 这套写法在 `messages.ts` 被拆分（二开词条搬到 `i18n/fork.ts`）之后**静默失效**：
 * CI 报 `F3 只找到 0 处`，而词条其实好好地在 `fork.ts` 里。更坏的情况是「碰巧还是绿的」——
 * 某个词条搬走了、另一个同名子串还在，检查看着通过，实际早已没在检查它该检查的东西。
 *
 * `messages.ts` 已经把 `fork.ts` 深合并进来（`mergeFork`），所以**打包取值拿到的就是完整词条集**，
 * 不需要知道词条此刻住在哪个文件。以后再怎么拆文件，这里都不用改。
 *
 * ## 口径
 *
 * 与 `check-i18n-keys.cjs` 一致：esbuild 把 `messages.ts` 打成 CJS 在 Node 里 require，
 * 不给产品代码加任何只供测试用的导出。
 *
 * ```js
 * const { readI18n } = require('./lib/i18n-source')
 * const zh = readI18n().locale('zh-CN')      // 扁平字典：{ 'cf.wt.deps.stillUsable': '…' }
 * zh.get('cf.wt.deps.stillUsable')          // 取一个 key（缺失返回 undefined）
 * readI18n().entry('cf.wt.deps.stillUsable')// { 'zh-CN': '…', en: '…' } —— 中英一起取
 * ```
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

/** 本文件在 `.deva/qa/lib/` 下，`qa` 目录是它的上一层。 */
const QA = path.resolve(__dirname, '..')
const ROOT = path.resolve(QA, '..', '..')
const ENTRY = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n', 'messages.ts')

/** 递归摊平成点分 key。数组/标量按 JSON 串存，便于直接比对。 */
function flatten(node, prefix = '', out = {}) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out[prefix] = typeof node === 'string' ? node : JSON.stringify(node)
    return out
  }
  for (const k of Object.keys(node)) flatten(node[k], prefix ? `${prefix}.${k}` : k, out)
  return out
}

/** 本进程内缓存：一个脚本可能查很多次，别每次都重打包。 */
let cache = null

/**
 * 加载当前 i18n 词条的运行时值。
 *
 * @returns {{ locales: string[], locale: (name: string) => Map<string, string>, entry: (key: string) => Record<string, string> }}
 *   `locales` 是实际存在的语言代码（如 `zh-CN`、`en`）。`entry()` 缺失的 key 不出现在结果里，
 *   调用方靠 `Object.keys(entry).length` 判断「中英是不是各一条」。
 */
function readI18n() {
  if (cache) return cache

  const bundle = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })
  const tmp = path.join(QA, `.i18n-source-probe-${process.pid}.cjs`)
  fs.writeFileSync(tmp, bundle.outputFiles[0].text)
  let mod
  try {
    mod = require(tmp)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  const messages = mod.messages
  const flat = {}
  for (const locale of Object.keys(messages)) flat[locale] = flatten(messages[locale])

  const locales = Object.keys(flat)
  cache = {
    locales,
    /** 某个语言的扁平字典（副本，随便改不影响缓存）。 */
    locale: (name) => new Map(Object.entries(flat[name] ?? {})),
    /** 一个 key 在各语言下的值：`{ 'zh-CN': '…', en: '…' }`；缺失的语言不出现。 */
    entry: (key) => {
      const out = {}
      for (const locale of locales) {
        if (Object.hasOwn(flat[locale], key)) out[locale] = flat[locale][key]
      }
      return out
    }
  }
  return cache
}

/**
 * 断言用的小工具：检查「这几个 key 在所有语言里都存在且非空」。
 *
 * 返回 `{ ok, detail }`：`ok=false` 时 `detail` 说明缺哪个语言、或哪个是空串。
 * 让各脚本不用各写一遍 `matchAll` + `trim()` + 计数。
 *
 * @param {string[]} keys
 * @param {string[]} [expectLocales] 期望覆盖的语言，默认 `readI18n().locales`
 */
function checkKeys(keys, expectLocales) {
  const i18n = readI18n()
  const want = expectLocales ?? i18n.locales
  const missing = []
  const empty = []
  for (const key of keys) {
    const e = i18n.entry(key)
    for (const loc of want) {
      if (!Object.hasOwn(e, loc)) missing.push(`${loc}.${key}`)
      else if (String(e[loc]).trim().length === 0) empty.push(`${loc}.${key}`)
    }
  }
  if (missing.length) return { ok: false, detail: `缺 ${missing.join('、')}` }
  if (empty.length) return { ok: false, detail: `空串 ${empty.join('、')}` }
  return {
    ok: true,
    detail: keys.map((k) => `${k}=${i18n.entry(k)[want[0]].slice(0, 30)}`).join(' | ')
  }
}

module.exports = { readI18n, checkKeys, flatten }