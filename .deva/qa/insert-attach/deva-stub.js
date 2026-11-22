/**
 * `window.deva` 桩。**必须在 bundle 之前注入**：多个模块在顶层读 `window.deva.platform`，
 * 晚一步挂上就是 `Cannot read properties of undefined`，整个 bundle 不执行。
 *
 * 本用例的目标是「输入框里贴图 → 随插话交出去」，而 Composer 的依赖链很深
 * （ModelPanel / 各种胶囊 / 卡片），会碰到一大票 `window.deva.*` 接口。
 * 逐个照抄它们的签名只会让桩面无限膨胀、且与上游一起漂移——故用 Proxy 兜底：
 * 显式写出来的（`fs.pasteAttachment` / `attachmentImage`）是真实桩，
 * 其余任何未列出的路径一律返回「万能异步函数」，能继续往下点、也能 await。
 *
 * 风险与取舍：万一某处用 `if (window.deva.x)` 判存在，兜底是 truthy 会让它走进去。
 * 本用例不验浏览器等功能，故把 `BrowserCapsule` 整个替换掉了（见 stub-browsercapsule.ts），
 * 不让那些分支有机会被走到。
 */

/*
 * 语言：默认钉成 zh-CN，让本地与 CI 跑的是同一个界面语言。
 *
 * i18n 的 detectLocale 依次看 window.deva.config.getSync().locale → localStorage → navigator.language，
 * 所以这里三层都钉：config 桩显式返回 zh-CN，localStorage 清掉（本机可能残留上次的选择），
 * navigator.language 也定义成 zh-CN（万一 config 桩被绕过）。
 *
 * 但断言本身**不再依赖** zh-CN：test.ts 从词条表取当前 locale 的期望文案，所以
 * `?locale=en` 打开页面也能 6/6（run.cjs 用 DEVA_TEST_LOCALE=en 走这条）。
 */
const TEST_LOCALE = new URLSearchParams(location.search).get('locale') || 'zh-CN'
try {
  Object.defineProperty(navigator, 'language', { get: () => TEST_LOCALE, configurable: true })
  Object.defineProperty(navigator, 'languages', { get: () => [TEST_LOCALE], configurable: true })
} catch {
  /* 定义失败就退回 config 桩 */
}
try {
  localStorage.removeItem('deva.locale')
} catch {
  /* ignore */
}

const real = {
  platform: 'win32',
  /** i18n 的 detectLocale 读这里；钉住语言，避免跟随跑测机器的系统语言。 */
  config: {
    getSync: () => ({ locale: TEST_LOCALE }),
    get: async () => ({ locale: TEST_LOCALE }),
    set: async () => undefined
  },
  /** 粘贴 / 拖入落盘过的文件（断言用）。 */
  __pasted: [],
  /** `pickAttachments` 下一次返回什么。 */
  __pick: [],
  fs: {
    /** 粘贴 / 拖入的文件：给一个稳定的落盘路径，并记下来供断言检查。 */
    pasteAttachment: async (f) => {
      const path = `C:\\tmp\\deva-paste\\${f.name}`
      window.deva.__pasted.push({ name: f.name, mime: f.mime, size: f.size, path })
      return {
        path,
        name: f.name,
        ext: f.name.split('.').pop(),
        size: f.size,
        kind: /^image\//.test(f.mime) ? 'image' : 'file',
        supported: true
      }
    },
    pickAttachments: async () => window.deva.__pick,
    /**
     * 拖入 / 粘贴的条目：`null` = 取不到真实路径（截图就是这样），由调用方照旧交字节走 `pasteAttachment`。
     * 必须显式返回数组：兜底的万能函数 resolve 出 `undefined`，而调用方会立刻 `entries.flatMap(...)`，
     * 抛出的 TypeError 在 `void ingest(files)` 里被静默吞掉——表现就是「贴了没反应」。
     */
    droppedEntries: async (files) => files.map(() => null),
    /** 图片缩略图：给个 1x1 的 data URI，够渲染出 <img>。 */
    attachmentImage: async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  }
}

/** 万能异步函数：既能被调用（返回 Promise），也能继续点下去（返回自己）。 */
function anything() {
  const fn = function () {
    return Promise.resolve()
  }
  fn.onState = () => () => undefined
  fn.onLiveFrame = () => () => undefined
  fn.onEvent = () => () => undefined
  fn.onChanged = () => () => undefined
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'then') return undefined // 别被当成 thenable
      if (k in t) return t[k]
      return anything()
    },
    apply() {
      return Promise.resolve()
    }
  })
}

window.deva = new Proxy(real, {
  get(t, k) {
    if (k in t) return t[k]
    return anything()
  }
})