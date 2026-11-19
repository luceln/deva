/**
 * 导入报告 —— 断言 `unrecoverable` 是警告、`rekeyed` 在成功面板。
 *
 * 全部断言在真实 DOM 上跑：类名（颜色档位）、文案、逐条 key 名、以及「不把整份报告标失败」。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CASES = []
const ok = (name, fn) => CASES.push({ name, fn })
function assert(c, m) {
  if (!c) throw new Error(m)
}
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}

async function waitFor(fn, msg, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`超时：${msg}`)
    await sleep(25)
  }
}

/** 去掉敏感的空步骤，只留本用例关心的字段。 */
function report(patch) {
  const empty = { copied: [], skipped: [], ignored: [], noEncryption: [], invalid: [], unrecoverable: [], rekeyed: [] }
  const step = (n = 0) => ({ copied: Array.from({ length: n }, (_, i) => `x${i}`), skipped: [], failed: [] })
  return {
    ok: true,
    providers: step(2),
    mcp: step(0),
    secrets: { ...empty, ...patch.secrets },
    personas: step(1),
    personaEnabled: [],
    memories: { added: [], skipped: [], failed: [] },
    skills: step(0),
    sessions: step(0),
    assoc: { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 },
    failures: [],
    ...patch.top
  }
}

/** 挂载 + 点「开始导入」 + 等结果区出现。 */
async function run(report) {
  // 运行态已提到模块级（importSession），不复位会让上一条用例的报告串到这一条。
  window.__unmountOnly()
  window.__resetImportSession()
  window.__mountImport()
  // 闸门是进页时异步 probe 的：要等按钮真的可点，不能一挂载就点（否则 disabled 点不动）。
  const btn = await waitFor(
    () => {
      const b = [...document.querySelectorAll('.cf-imp__actions button')].find((x) =>
        /开始导入|再次导入/.test(x.textContent ?? '')
      )
      return b && !b.disabled ? b : null
    },
    '「开始导入」按钮一直不可点（闸门没就绪）'
  )
  window.__setReport(report)
  btn.click()
  await waitFor(() => document.querySelector('.cf-imp__result'), '结果区没出现')
  await sleep(100)
}

const q = (s) => document.querySelector(s)
const qa = (s) => [...document.querySelectorAll(s)]

// ── 用例 ────────────────────────────────────────────────────────

ok('① unrecoverable 显示为警告，不是错误（有警示面板、没有失败清单）', async () => {
  await run(
    report({
      secrets: {
        copied: ['magpie', 'remote:bot_mwcyl7ok_3hrt:appSecret', 'openai'],
        rekeyed: ['magpie', 'remote:bot_mwcyl7ok_3hrt:appSecret'],
        unrecoverable: ['anthropic']
      }
    })
  )
  const warn = await waitFor(() => q('.cf-imp__warn'), '没有警告面板')
  assert(warn, '警告面板不存在')
  // 关键：不能用失败清单那套（危险色）
  eq(!!q('.cf-imp__fails'), false, '不该出现失败清单（report.ok 是 true）')
  const head = q('.cf-imp__warnhead')
  assert(head, '警告面板缺标题行')
  assert(/1 条密钥需要重新填写/.test(head.textContent), `标题文案不对：${head.textContent}`)
})

ok('② 警告面板逐条列出要重填的 key 名', async () => {
  const keys = qa('.cf-imp__keys code').map((c) => c.textContent)
  eq(keys.join(','), 'anthropic', 'key 名清单')
})

ok('③ 警告面板带「去设置 › 模型」入口', async () => {
  const btn = qa('.cf-imp__warnact button').find((b) => /设置/.test(b.textContent ?? ''))
  assert(btn, '没有去设置的按钮')
})

ok('④ 整份报告仍是「成功」（不因 unrecoverable 变成失败）', async () => {
  const head = q('.cf-imp__resulthead')
  assert(head, '缺结果标题')
  const txt = (head.textContent ?? '').trim()
  assert(!/失败/.test(txt), `标题不该说失败：${txt}`)
  assert(/导入完成/.test(txt), `标题应是「导入完成」：${txt}`)
})

ok('⑤ rekeyed 出现在密钥行（成功色说明「其中 N 条修好了」）', async () => {
  const tags = qa('.cf-imp__note-tag').map((t) => ({ cls: t.className, txt: t.textContent }))
  const rk = tags.find((t) => /修好/.test(t.txt ?? ''))
  assert(rk, `没有 rekeyed 说明：${JSON.stringify(tags)}`)
  assert(/is-good/.test(rk.cls), `rekeyed 应用成功色，实际 ${rk.cls}`)
  assert(/2 条/.test(rk.txt), `条数应为 2：${rk.txt}`)
})

ok('⑥ 密钥计数只按 copied 算（3 条，不因 rekeyed 变成 5）', async () => {
  const row = qa('.cf-imp__row').find((r) => /API 密钥/.test(r.textContent ?? ''))
  assert(row, '找不到密钥行')
  const txt = row.textContent ?? ''
  assert(/新增 3/.test(txt), `copied 应为 3：${txt}`)
  assert(!/新增 5/.test(txt), `不该把 rekeyed 叠加进去：${txt}`)
})

ok('⑦ 没有 unrecoverable 时不出现警告面板（不误报）', async () => {
  await run(report({ secrets: { copied: ['a', 'b'], rekeyed: ['a'] } }))
  eq(!!q('.cf-imp__warn'), false, '不该出现警告面板')
  const tags = qa('.cf-imp__note-tag').map((t) => t.textContent ?? '')
  assert(tags.some((t) => /修好/.test(t)), `rekeyed 说明仍应在：${JSON.stringify(tags)}`)
})

ok('⑧ 大量 unrecoverable（12 条）时折叠，不把面板撑爆', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `provider${i}:apiKey`)
  await run(report({ secrets: { copied: [], unrecoverable: many } }))
  const warn = await waitFor(() => q('.cf-imp__warn'), '没有警告面板')
  const shown = qa('.cf-imp__keys code').length
  eq(shown, 5, '默认只显示 5 条')
  const more = qa('.cf-imp__keys button').find((b) => /还有/.test(b.textContent ?? ''))
  assert(more, '缺「还有 N 条」的展开入口')
  assert(/7/.test(more.textContent), `应剩 7 条：${more.textContent}`)
  assert(warn.textContent.includes('12 条密钥需要重新填写'), '标题仍报总数 12')
})

ok('⑨ 切走设置页再回来，报告还在（不被卸载清空）', async () => {
  await run(
    report({ secrets: { unrecoverable: ['magpie'] } })
  )
  const before = (q('.cf-imp__resulthead')?.textContent ?? '').trim()
  assert(before, '前置：应该有结果区')

  // 模拟「切到设置 › 模型」：ImportPane 被卸载，但面板没关。
  window.__unmountOnly()
  eq(!!q('.cf-imp__resulthead'), false, '卸载后结果区应消失（这是卸载生效的证据）')

  // 切回「导入」：重新挂载，不该重跑导入，但报告要立刻在。
  window.__mountImport()
  const head = await waitFor(() => q('.cf-imp__resulthead'), '切回来报告丢了')
  eq((head.textContent ?? '').trim(), before, '报告标题应与切走前一致')
  assert(q('.cf-imp__warn'), '切回来警告面板丢了')
  eq(qa('.cf-imp__keys code').map((c) => c.textContent).join(','), 'magpie', '重填清单丢了')
})

ok('⑩ 切回来不重跑导入（只恢复展示）', async () => {
  const btn = qa('.cf-imp__actions button').find((b) => /导入/.test(b.textContent ?? ''))
  assert(btn, '找不到导入按钮')
  assert(/再次导入/.test(btn.textContent), `应显示「再次导入」而不是「开始导入」：${btn.textContent}`)
})

ok('⑪ 失败清单的展开态也跨挂载保留', async () => {
  await run(
    report({
      top: {
        failures: Array.from({ length: 12 }, (_, i) => ({
          step: 'memories',
          id: `p_cc7f18c${i}`,
          reason: 'budget'
        }))
      }
    })
  )
  const more = await waitFor(
    () => qa('.cf-imp__failmore').find((b) => /展开看全部/.test(b.textContent ?? '')),
    '没有展开入口'
  )
  more.click()
  await sleep(80)
  eq(qa('.cf-imp__failmore')[0]?.getAttribute('aria-expanded'), 'true', '应已展开')

  window.__unmountOnly()
  window.__mountImport()
  const again = await waitFor(() => qa('.cf-imp__failmore')[0], '切回来失败区块丢了')
  eq(again.getAttribute('aria-expanded'), 'true', '展开态应保留')
})

// ── 运行 ────────────────────────────────────────────────────────

async function main() {
  let pass = 0
  const fails = []
  for (const c of CASES) {
    try {
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
  log(`FATAL ${e && (e.stack || e.message)}`)
  document.title = 'DONE FATAL'
})