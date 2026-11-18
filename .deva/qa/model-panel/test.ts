/**
 * 模型面板失效标红 —— 浏览器内驱动真实 ModelPanel。
 *
 * 打桩边界（只替掉与本用例无关的重依赖，ModelPanel / ModelMenu / ModelSwapDialog / clampEffort 都是真代码）：
 *   store/chat   —— 真实 ChatProvider 会打一串 IPC，且无法从外部构造 brokenModels / sessions
 *   store/models —— 真实 ModelsProvider 从 mock/models 起种子，构造不出「缺密钥 / 不支持思考」边界
 * 其余（i18n / Toast / Dialog / Modal / Select / context-usage / shared/effort）全用真实实现。
 *
 * 判据只认 DOM 与 computed style：贴片文案、徽标数字、类名（is-broken / is-nokey）、点击后的表现。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}

const CASES = []
const ok = (name, fn) => CASES.push({ name, fn })
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

const ROOT = 'E:\\deva'

/** 两个服务商：p1 有 p1:m1 / p1:m2，p2（另一家，accent 不同）有 p2:q1。 */
function providers() {
  return [
    {
      id: 'p1',
      name: '甲服务商',
      accent: '#111111',
      enabled: true,
      adapter: 'openai',
      apiHost: 'https://a.example',
      models: [
        { id: 'm1', name: '甲模型一', enabled: true, contextWindow: 128000, maxOutput: 8192 },
        { id: 'm2', name: '甲模型二', enabled: true, contextWindow: 32000, maxOutput: 4096 }
      ]
    },
    {
      id: 'p2',
      name: '乙服务商',
      accent: '#222222',
      enabled: true,
      adapter: 'openai',
      apiHost: 'https://b.example',
      models: [{ id: 'q1', name: '乙模型一', enabled: true, contextWindow: 64000, maxOutput: 4096 }]
    }
  ]
}

/** window.deva 全套桩：只实现本用例会走到的方法。 */
function makeDevaStub() {
  const st = {
    available: true,
    blocked: [],
    usage: null,
    statusCalls: 0
  }
  window.deva = {
    platform: 'win32',
    config: { set: async () => ({ ok: true }), get: async () => ({}) },
    chat: {
      // context-usage：返回可控读数，用于上游新功能回归（圆环 / 百分比 / 进度条 / 自动压缩竖线）
      contextUsage: async () => st.usage,
      onEvent: () => () => undefined,
      // ModelSwapDialog 打开时会重扫 + 拉 blocked 服务商
      scanModelSwap: async () => [],
      blockedProviders: async () => st.blocked,
      applyModelSwap: async () => ({ error: 'stub' })
    },
    git: {
      available: async () => ({ available: false }),
      status: async () => ({ isRepo: false })
    }
  }
  return st
}

async function waitFor(fn, msg, timeout = 4000) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = fn()
    } catch {
      v = false
    }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`超时：${msg}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

function chip() {
  return document.querySelector('.cf-mp__chip')
}
function chipText() {
  const el = document.querySelector('.cf-mp__chip .chip__label')
  return el ? el.textContent.trim() : null
}
function badgeText() {
  const el = document.querySelector('.cf-mp__chip .chip__badge')
  return el ? el.textContent.trim() : null
}
function chipClasses() {
  const el = chip()
  return el ? [...el.classList] : []
}
/** computed color，用于区分危险色 / 警示色 / 正常色。 */
function chipColor() {
  const el = chip()
  return el ? getComputedStyle(el).color : null
}

/** 造一条失效记录。 */
function broken(sessionId, ref, kind, name = '会话') {
  return { sessionId, ref, kind, name }
}

/** 把状态重置到「一切正常，本会话用 p1:m1」。 */
function resetNormal() {
  window.__resetChat()
  window.__resetModels()
  window.__setModels({ providers: providers(), activeModel: null, activeEffort: 'default' })
  window.__setChat({
    currentSessionId: 's1',
    currentBinding: { focusRoot: null, model: 'p1:m1' },
    sessions: [{ id: 's1', updatedAt: Date.now() }],
    brokenModels: {}
  })
}

// ── 用例 ──────────────────────────────────────────────────────────

ok('正常态：贴片显示模型名，无 is-broken、无徽标', async () => {
  resetNormal()
  await waitFor(() => chipText() === '甲模型一', '贴片未显示模型名')
  assert(!chipClasses().includes('is-broken'), '正常态不该有 is-broken')
  eq(badgeText(), null, '正常态不该有徽标')
})

ok('正常态点贴片 → 打开面板（含上下文占用区 + 两行）', async () => {
  chip().click()
  await waitFor(() => document.querySelector('.cf-mp__panel'), '面板没打开')
  assert(document.querySelector('.cf-mp__rows'), '面板下半部分（模型 / 思考等级两行）缺失')
  // 关掉
  document.querySelector('.model-pick__backdrop').click()
  await waitFor(() => !document.querySelector('.cf-mp__panel'), '面板没关掉')
})

// —— 四种失效 kind ——

ok('kind=model-disabled → 危险色「模型不可用」+ 徽标数字', async () => {
  resetNormal()
  window.__setChat({
    brokenModels: { s1: [broken('s1', 'p1:m1', 'model-disabled')] }
  })
  await waitFor(() => chipText() === '模型不可用', '文案未变成「模型不可用」')
  const cls = chipClasses()
  assert(cls.includes('is-broken'), '缺少 is-broken 类')
  assert(!cls.includes('is-nokey'), 'model-disabled 不该用警示色（is-nokey）')
  eq(badgeText(), '1', '徽标数字应为受影响会话数')
})

ok('kind=disabled（服务商停用）→ 危险色', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('s1', 'p1:m1', 'disabled')] } })
  await waitFor(() => chipText() === '模型不可用', '文案未变')
  assert(!chipClasses().includes('is-nokey'), '服务商停用属「真坏」，应用危险色')
})

ok('kind=missing（模型已从配置消失）→ 危险色', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('s1', 'p1:gone', 'missing')] } })
  await waitFor(() => chipText() === '模型不可用', '文案未变')
  assert(!chipClasses().includes('is-nokey'), '模型缺失属「真坏」，应用危险色')
})

ok('kind=nokey → 警示色「缺少密钥」', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('s1', 'p1:m1', 'nokey')] } })
  await waitFor(() => chipText() === '缺少密钥', '文案未变成「缺少密钥」')
  assert(chipClasses().includes('is-nokey'), '缺密钥应用警示色（is-nokey）')
})

ok('kind=keyunreadable → 警示色「缺少密钥」', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('s1', 'p1:m1', 'keyunreadable')] } })
  await waitFor(() => chipText() === '缺少密钥', '文案未变成「缺少密钥」')
  assert(chipClasses().includes('is-nokey'), '密钥读不出同属「密钥的事」，应用警示色')
})

ok('kind=malformed（引用非法，即 ref-gone 同族）→ 危险色', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('s1', 'not-a-ref', 'malformed')] } })
  await waitFor(() => chipText() === '模型不可用', '文案未变')
  assert(!chipClasses().includes('is-nokey'), '引用非法属「真坏」，应用危险色')
})

ok('混合：一处 nokey + 一处 model-disabled → 危险色（只要有一处真坏）', async () => {
  resetNormal()
  window.__setChat({
    brokenModels: {
      s1: [broken('s1', 'p1:m1', 'nokey'), broken('s2', 'p2:q1', 'model-disabled')]
    }
  })
  await waitFor(() => chipText() === '模型不可用' && badgeText() === '2', '混合情况应为「模型不可用」且徽标为 2')
  assert(!chipClasses().includes('is-nokey'), '有真坏的一处就该用危险色')
  eq(badgeText(), '2', '徽标应算上名下成员')
})

ok('只有别的会话坏、本会话没坏 → 不标红（不误伤）', async () => {
  resetNormal()
  window.__setChat({ brokenModels: { s1: [broken('other', 'p1:m1', 'model-disabled')] } })
  await new Promise((r) => setTimeout(r, 300))
  eq(chipText(), '甲模型一', '本会话没坏就不该标红')
  assert(!chipClasses().includes('is-broken'), '本会话没坏不该有 is-broken')
})

ok('成员会话：看成员时按它的主对话判断（主对话名单反查）', async () => {
  resetNormal()
  window.__setChat({
    currentSessionId: 'member-a',
    currentBinding: { focusRoot: null, model: 'p1:m1' },
    sessions: [{ id: 'main', updatedAt: Date.now(), members: [{ sessionId: 'member-a' }] }],
    brokenModels: { main: [broken('member-a', 'p1:m1', 'model-disabled')] }
  })
  await waitFor(() => chipText() === '模型不可用', '成员会话的失效没被识别')
  eq(badgeText(), '1', '徽标数字')
})

ok('失效态点贴片 → 直接打开批量替换对话框，不弹模型面板', async () => {
  resetMeta()
  const el = chip()
  el.click()
  await waitFor(() => document.querySelector('.cf-swap') || document.querySelector('[role="dialog"]'), '没打开替换对话框')
  eq(document.querySelector('.cf-mp__panel'), null, '失效态不该弹常规模型面板')
})

/** 把当前状态固定成「失效且是本会话自己的引用」，用于点击相关用例。 */
function resetMeta() {
  resetNormal()
  window.__setChat({
    brokenModels: { s1: [broken('s1', 'p1:m1', 'model-disabled'), broken('s2', 'p2:q1', 'nokey')] }
  })
}

// —— 上游新功能回归（迁移最容易碰坏的部分）——

ok('回归：有读数时贴片是占用圆环而不是色点', async () => {
  resetNormal()
  window.deva.chat.contextUsage = async () => ({
    used: 64000,
    window: 128000,
    trigger: 115200,
    estimated: false
  })
  // 依赖 updatedAt 变一次才会重拉
  window.__setChat({ sessions: [{ id: 's1', updatedAt: Date.now() + 1 }] })
  await waitFor(() => document.querySelector('.cf-mp__ring'), '贴片没出现占用圆环')
  eq(document.querySelector('.cf-mp__chip .chip__dot'), null, '有读数时不该同时显示色点')
})

ok('回归：面板里有百分比、进度条、自动压缩竖线', async () => {
  chip().click()
  await waitFor(() => document.querySelector('.cf-mp__panel'), '面板没打开')
  const big = document.querySelector('.cf-mp__big')
  assert(big && /%/.test(big.textContent), `没找到百分比读数（实际 ${big ? big.textContent : 'null'}）`)
  const fill = document.querySelector('.cf-mp__fill')
  assert(fill, '没找到进度条填充')
  const w = parseFloat(fill.style.width)
  assert(w > 0 && w <= 100, `进度条宽度应在 (0,100]，实际 ${fill.style.width}`)
  assert(document.querySelector('.cf-mp__tick'), '没找到自动压缩竖线')
  assert(document.querySelector('.cf-mp__ticklabel'), '没找到自动压缩竖线的说明')
})

ok('回归：思考等级选择后贴片显示灯泡 + 档位', async () => {
  resetNormal()
  // p1 的 openai 适配器 + m1 支持思考等级
  window.__setModels({ providers: providers(), activeModel: null, activeEffort: 'high' })
  await waitFor(() => document.querySelector('.cf-mp__eff'), '贴片没显示思考档位')
  const eff = document.querySelector('.cf-mp__eff').textContent.trim()
  assert(eff.length > 0, '档位文字为空')
})

ok('回归：思考等级菜单能打开并列出档位', async () => {
  chip().click()
  await waitFor(() => document.querySelector('.cf-mp__panel'), '面板没打开')
  const rows = [...document.querySelectorAll('.cf-mp__row')]
  assert(rows.length >= 2, `面板应有两行（模型 / 思考等级），实际 ${rows.length}`)
  // 点第二行（思考等级）
  rows[1].click()
  await waitFor(() => document.querySelector('.cf-mp__sub'), '思考等级二级菜单没打开')
  const items = [...document.querySelectorAll('.cf-mp__sub .model-pick__item')]
  assert(items.length > 0, '思考等级菜单没有选项')
})

ok('回归：模型二级菜单能切换模型（写入本对话 + 记为最近使用）', async () => {
  resetNormal()
  window.__picked = []
  chip().click()
  await waitFor(() => document.querySelector('.cf-mp__panel'), '面板没打开')
  const rows = [...document.querySelectorAll('.cf-mp__row')]
  rows[0].click()
  await waitFor(() => document.querySelector('.cf-mp__sub'), '模型二级菜单没打开')
  const items = [...document.querySelectorAll('.cf-mp__sub .model-pick__item')]
  const target = items.find((b) => !b.disabled && b.textContent.includes('甲模型二'))
  assert(target, '没找到「甲模型二」这一项')
  target.click()
  await waitFor(() => window.__picked.length > 0, '点模型后没调用 setSessionModel')
  eq(window.__picked[0], 'model:p1:m2', '应写入 p1:m2')
})

ok('回归：缺密钥服务商的模型在菜单里不可选并写明原因', async () => {
  resetNormal()
  window.deva.chat.blockedProviders = async () => [{ id: 'p2', kind: 'nokey' }]
  // 让 blocked 生效：Hook 依赖 mainId，换一次会话触发重拉
  window.__setChat({ currentSessionId: 's1', sessions: [{ id: 's1', updatedAt: Date.now() }] })
  await new Promise((r) => setTimeout(r, 200))
  chip().click()
  await waitFor(() => document.querySelector('.cf-mp__panel'), '面板没打开')
  const rows = [...document.querySelectorAll('.cf-mp__row')]
  rows[0].click()
  await waitFor(() => document.querySelector('.cf-mp__sub'), '模型二级菜单没打开')
  // 当前在 p1 的模型列表里，先回服务商列表再进 p2
  const back = document.querySelector('.cf-mp__back')
  assert(back, '没有「全部服务商」入口')
  back.click()
  await waitFor(() => document.querySelector('.cf-mp__prov'), '服务商列表没出现')
  const provs = [...document.querySelectorAll('.cf-mp__prov')]
  const p2 = provs.find((b) => b.textContent.includes('乙服务商'))
  assert(p2, '服务商列表里没有乙服务商')
  p2.click()
  await waitFor(() => document.querySelector('.cf-mp__blockednote'), '没显示「缺密钥」的说明')
  const q1 = [...document.querySelectorAll('.cf-mp__sub .model-pick__item')].find((b) =>
    b.textContent.includes('乙模型一')
  )
  assert(q1, '没找到乙模型一')
  assert(q1.disabled, '缺密钥服务商的模型应不可选')
  assert(q1.classList.contains('is-unusable'), '应带 is-unusable 类')
})

// ── 运行 ──────────────────────────────────────────────────────────

async function main() {
  makeDevaStub()
  window.__picked = []
  window.__mount()
  let pass = 0
  const fails = []
  for (const c of CASES) {
    try {
      // 每个用例前关掉残留的浮层，避免上一条的弹层挡住这一条
      document.querySelectorAll('.model-pick__backdrop').forEach((b) => b.click())
      await c.fn()
      pass++
      log(`PASS ${c.name}`)
    } catch (e) {
      fails.push(`${c.name} → ${e.message}`)
      log(`FAIL ${c.name} → ${e.message}`)
    }
  }
  log(`==RESULT== ${pass}/${CASES.length} PASS`)
  for (const f of fails) log(`  ✗ ${f}`)
  document.title = `DONE ${pass}/${CASES.length}`
}

main().catch((e) => {
  const msg = `FATAL ${e && (e.stack || e.message)}`
  log(msg)
  const pre = document.createElement('pre')
  pre.id = 'fatal'
  pre.textContent = msg
  document.body.appendChild(pre)
  document.title = 'DONE FATAL'
})
