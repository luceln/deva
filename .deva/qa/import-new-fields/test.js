/**
 * 导入新状态 —— 在真实 DOM 上断言三处展示接线。
 *
 *  A. pluginManaged（导入报告）：单列成「归插件管，未导入」，与「已存在，跳过」区分，且不被算成失败或跳过数。
 *  B. indexStale（模型替换结果）：说成「已保存、索引待重建」，绝不出现在失败清单里。
 *  C. superseded（模型替换结果）：显示「未改动」+ 当前真实模型名，不能静默消失。
 *
 * 反向约束：这些字段缺省时不能凭空多出区块（旧持久化结果 / 旧调用方）。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (s) => document.querySelector(s)
const qa = (s) => [...document.querySelectorAll(s)]

function assert(c, m) {
  if (!c) throw new Error(m)
}
function eq(a, b, m) {
  if (a !== b) throw new Error(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}
async function waitFor(fn, msg, ms = 4000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`超时：${msg}`)
    await sleep(25)
  }
}

/** 与 shared/import-protocol.ts 同形；patch 里只放本用例关心的字段。 */
function report(patch) {
  const emptySecrets = {
    copied: [],
    skipped: [],
    ignored: [],
    noEncryption: [],
    invalid: [],
    unrecoverable: [],
    rekeyed: [],
    pluginManaged: []
  }
  const step = (n = 0) => ({
    copied: Array.from({ length: n }, (_, i) => `x${i}`),
    skipped: [],
    failed: []
  })
  return {
    ok: true,
    providers: step(0),
    mcp: step(0),
    secrets: { ...emptySecrets, ...(patch.secrets ?? {}) },
    personas: step(0),
    personaEnabled: [],
    memories: { added: [], skipped: [], failed: [] },
    skills: step(0),
    sessions: step(0),
    assoc: { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 },
    failures: [],
    ...(patch.top ?? {})
  }
}

/** 切语言：detectLocale 先读 config.getSync（挂载时结算），故改它再重挂即可。 */
function setLocale(locale) {
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
  window.deva.config.getSync = () => ({ locale })
}

async function runImport(reportData) {
  window.__unmountAll()
  window.__resetImportSession()
  window.__mountImport()
  const btn = await waitFor(
    () => {
      const b = [...document.querySelectorAll('.cf-imp__actions button')].find((x) =>
        /开始导入|再次导入|Start import|Import again/.test(x.textContent ?? '')
      )
      return b && !b.disabled ? b : null
    },
    '「开始导入」一直不可点'
  )
  window.__setReport(reportData)
  btn.click()
  await waitFor(() => q('.cf-imp__result'), '结果区没出现')
  await sleep(80)
}

const rowOf = (text) => qa('.cf-imp__row').find((r) => (r.textContent ?? '').includes(text))

/** 展开某一行明细（点该行里的「明细」按钮）。 */
async function expandRow(row) {
  const btn = [...row.querySelectorAll('button')].find((b) => /明细|Details/.test(b.textContent ?? ''))
  assert(btn, '这一行没有明细入口')
  btn.click()
  await sleep(60)
}

/** 打开替换对话框：选一个目标模型再点「替换」。 */
async function runSwap(result, locale = 'zh-CN') {
  setLocale(locale)
  window.__unmountAll()
  window.__mountSwap(result)
  const combo = await waitFor(() => q('.modal__card [role="combobox"]'), '没有目标模型下拉')
  combo.click()
  const opt = await waitFor(
    () => document.querySelector('.select-menu__opt:not(.is-disabled)'),
    '候选模型没出现'
  )
  opt.click()
  await sleep(60)
  const apply = await waitFor(
    () => [...document.querySelectorAll('.modal__card button')].find((b) => /^(替换|Switch)$/.test((b.textContent ?? '').trim())),
    '没有替换按钮'
  )
  assert(!apply.disabled, '替换按钮不可点（未选到目标模型）')
  apply.click()
  await waitFor(() => q('.modal__card .cf-swap__result'), '替换结果没出现')
  await sleep(80)
}

const broken = (id, name, ref, kind = 'model-disabled') => ({ sessionId: id, name, ref, kind })

const CASES = []
const ok = (name, fn) => CASES.push({ name, fn })

// ── A. pluginManaged ─────────────────────────────────────────────

ok('A1 服务商行显示「归插件管，未导入」，且不混进「跳过」', async () => {
  setLocale('zh-CN')
  await runImport(
    report({
      top: {
        providers: { copied: ['openai'], skipped: [], failed: [], pluginManaged: ['magpie'] }
      }
    })
  )
  const row = rowOf('服务商')
  assert(row, '找不到服务商行')
  const tags = [...row.querySelectorAll('.cf-imp__note-tag')].map((t) => t.textContent ?? '')
  assert(tags.some((t) => /1 个归插件管，未导入/.test(t)), `缺插件托管标签：${JSON.stringify(tags)}`)
  // 关键：不能把插件托管算成「跳过 1」，那会被读成「已存在、不用管」
  const numText = [...row.querySelectorAll('.cf-imp__num')].map((n) => n.textContent ?? '').join('|')
  assert(/跳过 0/.test(numText), `跳过数应为 0：${numText}`)
  assert(!/失败/.test(numText), `不该出现失败数：${numText}`)
})

ok('A2 展开明细逐条列出插件托管的 id，并说明去插件里改', async () => {
  const row = rowOf('服务商')
  await expandRow(row)
  const sub = row.querySelector('.cf-imp__sub')
  assert(sub, '没有明细区')
  assert(sub.textContent.includes('magpie'), `明细里应有 magpie：${sub.textContent}`)
  const hint = sub.querySelector('.cf-imp__pluginhint')
  assert(hint, '缺「去插件里改」的说明')
  assert(/插件/.test(hint.textContent), `说明文案不对：${hint.textContent}`)
})

ok('A3 只有插件托管项的行仍然显示（0 新增 0 跳过也不会被过滤掉）', async () => {
  setLocale('zh-CN')
  await runImport(
    report({
      top: {
        mcp: { copied: [], skipped: [], failed: [], pluginManaged: ['magpie'] }
      }
    })
  )
  const row = rowOf('MCP 服务')
  assert(row, 'MCP 行被过滤掉了——有东西被排除却在界面上一个字都没有')
  assert(/归插件管，未导入/.test(row.textContent), `缺插件托管标签：${row.textContent}`)
})

ok('A4 密钥行的插件托管密钥不落进「需要重新填写」警告', async () => {
  setLocale('zh-CN')
  await runImport(
    report({
      secrets: { copied: ['openai'], pluginManaged: ['magpie'], unrecoverable: [] }
    })
  )
  const row = rowOf('API 密钥')
  assert(row, '找不到密钥行')
  assert(/归插件管，未导入/.test(row.textContent), `密钥行缺插件标签：${row.textContent}`)
  // 它是「归插件管」，不是「去设置重填」——走错那条指引会让用户扑空
  eq(!!q('.cf-imp__warn'), false, '不该出现「需要重新填写」警告面板')
})

ok('A5 英文环境用插件口径的文案，不是「跳过」', async () => {
  setLocale('en')
  await runImport(
    report({
      top: {
        providers: { copied: ['openai'], skipped: [], failed: [], pluginManaged: ['magpie'] }
      }
    })
  )
  const row = rowOf('Providers')
  assert(row, '找不到 Providers 行')
  const txt = row.textContent ?? ''
  assert(/1 belong to a plugin, not imported/.test(txt), `英文插件标签不对：${txt}`)
  assert(/0 skipped/.test(txt), `英文跳过数应为 0：${txt}`)
})

// ── B / C. indexStale + superseded ───────────────────────────────

ok('B1 indexStale 说成「已保存、索引待重建」，不进失败清单', async () => {
  setLocale('zh-CN')
  await runSwap({
    changed: [broken('s1', '主对话', 'anthropic:claude')],
    skipped: [],
    failed: [],
    indexStale: [broken('s2', '成员甲', 'anthropic:claude')],
    superseded: []
  })
  const summary = q('.modal__card .cf-swap__result').textContent ?? ''
  assert(/已替换 1 个/.test(summary), `成功数不对：${summary}`)
  assert(/1 个已保存，索引待重建/.test(summary), `标题里应有索引待重建：${summary}`)
  assert(!/没能写入/.test(summary), `索引待重建不能被说成失败：${summary}`)

  const note = qa('.modal__card .cf-swap__note').map((n) => n.textContent ?? '').join('\n')
  assert(/没有丢/.test(note), `应说明数据没丢：${note}`)
  assert(/刷新/.test(note), `应说明列表刷新一次即可：${note}`)

  const row = qa('.modal__card .cf-swap__row').find((r) => (r.textContent ?? '').includes('成员甲'))
  assert(row, '索引待重建的会话没有单列出来')
  assert(/已保存/.test(row.textContent), `该行应标「已保存」：${row.textContent}`)

  // 失败清单的类是危险色语义，索引待重建绝不能用它
  eq(qa('.modal__card .cf-swap__kind').filter((k) => /替换失败|Switch failed/.test(k.textContent ?? '')).length, 0, '不该出现「替换失败」')
})

ok('B2 索引待重建的会话不算进失败数（写盘失败仍需单独报）', async () => {
  setLocale('zh-CN')
  await runSwap({
    changed: [],
    skipped: [],
    failed: [broken('s3', '成员乙', 'anthropic:claude')],
    indexStale: [broken('s2', '成员甲', 'anthropic:claude')],
    superseded: []
  })
  const summary = q('.modal__card .cf-swap__result').textContent ?? ''
  assert(/1 个没能写入/.test(summary), `真实失败仍要说出来：${summary}`)
  assert(/1 个已保存，索引待重建/.test(summary), `索引待重建仍要说出来：${summary}`)
  const rows = qa('.modal__card .cf-swap__row').map((r) => r.textContent ?? '')
  assert(rows.some((r) => r.includes('成员乙')), `失败行丢了：${JSON.stringify(rows)}`)
  assert(rows.some((r) => r.includes('成员甲')), `索引待重建行丢了：${JSON.stringify(rows)}`)
})

ok('C1 superseded 显示「未改动」+ 当前真实模型名（不静默）', async () => {
  setLocale('zh-CN')
  await runSwap({
    changed: [broken('s1', '主对话', 'anthropic:claude')],
    skipped: [],
    failed: [],
    indexStale: [],
    // 关键：ref 是**当前真实引用**（用户期间换成了 claude-lite），不是快照值
    superseded: [broken('s4', '成员丙', 'anthropic:claude-lite')]
  })
  const summary = q('.modal__card .cf-swap__result').textContent ?? ''
  assert(/1 个未改动/.test(summary), `标题里应有未改动数：${summary}`)

  const row = qa('.modal__card .cf-swap__row').find((r) => (r.textContent ?? '').includes('成员丙'))
  assert(row, '被放弃的会话没有显示出来')
  const txt = row.textContent ?? ''
  assert(/未改动/.test(txt), `该行应写「未改动」：${txt}`)
  // 显示人看得懂的模型名，而不是 RPC 字段值 anthropic:claude-lite
  assert(/Claude Lite/.test(txt), `应显示当前真实模型名：${txt}`)
  assert(!/anthropic:claude-lite/.test(txt), `不该把引用原文当给人看的文案：${txt}`)
})

ok('C2 superseded 的说明讲清「为什么没改」，并保留选择权归用户', async () => {
  const notes = qa('.modal__card .cf-swap__note').map((n) => n.textContent ?? '').join('\n')
  assert(/没有覆盖/.test(notes), `应说明没有覆盖：${notes}`)
  assert(/现在实际使用/.test(notes) || /现在用的是/.test(notes), `应说明这些是当前实际值：${notes}`)
})

ok('C3 字段缺省时不凭空多出区块（旧结果兼容）', async () => {
  setLocale('zh-CN')
  await runSwap({ changed: [broken('s1', '主对话', 'anthropic:claude')], skipped: [], failed: [] })
  const summary = q('.modal__card .cf-swap__result').textContent ?? ''
  eq(summary, '已替换 1 个', `只有成功时标题应保持原样：${summary}`)
  eq(qa('.modal__card .cf-swap__note').length, 0, '不该出现索引/放弃说明')
  eq(qa('.modal__card .cf-swap__row').length, 1, '只应有 changed 那一行')
})

ok('D1 英文环境下三项都说英文，且不出现 RPC 字段名', async () => {
  setLocale('en')
  await runSwap(
    {
      changed: [],
      skipped: [],
      failed: [],
      indexStale: [broken('s2', 'Member A', 'anthropic:claude')],
      superseded: [broken('s4', 'Member C', 'anthropic:claude-lite')]
    },
    'en'
  )
  const text = q('.modal__card').textContent ?? ''
  assert(/saved, list index pending/.test(text), `英文索引文案不对：${text.slice(0, 400)}`)
  assert(/not changed/.test(text), `英文未改动文案不对：${text.slice(0, 400)}`)
  assert(/Claude Lite/.test(text), '英文下也应显示当前模型名')
  for (const bad of ['indexStale', 'superseded', 'pluginManaged']) {
    assert(!text.includes(bad), `界面上不该出现字段名 ${bad}`)
  }
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
  if (window.__errors?.length) log(`页面错误：${window.__errors.join(' | ')}`)
  log(`==RESULT== ${pass}/${CASES.length} PASS`)
  for (const f of fails) log(`  ✗ ${f}`)
  document.title = `DONE ${pass}/${CASES.length}`
}

main().catch((e) => {
  log(`FATAL ${e && (e.stack || e.message)}`)
  document.title = 'DONE FATAL'
})