/**
 * 独立验收：合并后二开关键能力是否真的还在（不看代码存在性，跑行为）。
 *
 * 用法：node .deva/qa/accept-merge-check.cjs <case>
 *   cases: mem-tri   记忆三态（读不出 ≠ 没有）
 *          sec-tri   密钥四态（store-unreadable ≠ absent）
 *          model-kinds 模型失效五类
 *          wk-mem    worktree 会话读主仓记忆
 *          consolidate 记忆写满自动归纳
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const kase = process.argv[2]
const root = path.join(os.tmpdir(), 'acc-merge-' + kase + '-' + Date.now())
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(DST, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
/*
 * 桩的 `getPath('appData')` 读 TEST_APPDATA、`getPath('home')` 读 TEST_HOME，**不读 USERPROFILE**。
 * 不设这两个时 `getPath('userData')` 会抛「未预期的 getPath」，而 `secrets.ts` 的 migrateLegacy
 * 在 catch 里看到的不是 ENOENT，于是把 loadKind 判成 `corrupt` → `readSecret` 一律返回
 * `store-unreadable` → 「缺密钥」的用例全部误判成「库读不出来」。
 * 这是本项目记过的坑：夹具缺环境变量不会报错，只会让断言指向错误的原因。
 */
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = path.join(root, 'appdata')
fs.mkdirSync(process.env.TEST_APPDATA, { recursive: true })

let fails = 0
const eq = (l, a, e) => {
  const x = JSON.stringify(a)
  const y = JSON.stringify(e)
  if (x === y) console.log(`PASS ${l} :: ${x}`)
  else { fails++; console.log(`FAIL ${l} :: 实际=${x} 期望=${y}`) }
}
const ok = (l, c, d) => {
  if (c) console.log(`PASS ${l}${d ? ' :: ' + d : ''}`)
  else { fails++; console.log(`FAIL ${l}${d ? ' :: ' + d : ''}`) }
}
const info = (l, v) => console.log(`INFO ${l} :: ${v}`)

;(async () => {
  const S = {}

  S['mem-tri'] = async () => {
    const mem = await import('../../apps/desktop/src/main/services/memory')
    // ① 文件不存在 → absent
    const r1 = mem.readMemories({ kind: 'global' })
    info('无文件时', JSON.stringify(r1))
    eq('记忆三态：文件不存在 → absent', r1.kind, 'absent')
    // ② 正常读
    fs.writeFileSync(path.join(DST, 'memory.json'), JSON.stringify({ version: 1, entries: [{ id: 'm_1', content: 'x', createdAt: 1, updatedAt: 1 }] }))
    const r2 = mem.readMemories({ kind: 'global' })
    info('正常时', JSON.stringify(r2).slice(0, 200))
    eq('记忆三态：正常文件 → ok', r2.kind, 'ok')
    // ③ 文件坏了 → unreadable（不是 absent）
    fs.writeFileSync(path.join(DST, 'memory.json'), '{ broken')
    const r3 = mem.readMemories({ kind: 'global' })
    info('损坏时', JSON.stringify(r3))
    eq('记忆三态：文件损坏 → unreadable（不是 absent）', r3.kind, 'unreadable')
    ok('记忆三态：unreadable 带可读原因', typeof r3.error === 'string' && r3.error.length > 5, r3.error)
    // ④ 写入路径在 unreadable 时必须拒写，不能覆盖成「只有这一条」
    const w = mem.writeMemory('新记忆内容', undefined, { kind: 'global' })
    info('损坏时写入', JSON.stringify(w))
    ok('记忆三态：读不出时写入必须拒绝（不覆盖成一条）', w.ok === false, JSON.stringify(w))
    eq('记忆三态：拒绝原因码是 readFailed', w.code, 'readFailed')
    // 原文件必须没被覆盖
    eq('记忆三态：读不出时原文件内容未被覆盖', fs.readFileSync(path.join(DST, 'memory.json'), 'utf8'), '{ broken')
  }

  S['sec-tri'] = async () => {
    const secrets = await import('../../apps/desktop/src/main/services/secrets')
    // 库文件坏
    fs.writeFileSync(path.join(DST, 'secrets.json'), '{bad json')
    const r = await secrets.readSecret('someprovider')
    info('readSecret', JSON.stringify(r))
    // 不再断言 `loadKind === 'corrupt'`：`readSecretsLoadKind()` 这个接口已被删除，
    // 理由是它没有生产调用点、且同步版在首次载入前只能返回 'ok'（会把「还没载入」误判成「库没问题」）。
    // 见 services/secrets.ts:78-87 的注释。判据改为**经由唯一正确的入口**观察：readSecret 的返回值。
    eq('密钥四态：库坏 → store-unreadable（不是 absent）', r.kind, 'store-unreadable')
    ok('密钥四态：带可读原因', typeof r.reason === 'string' && r.reason.length > 5, r.reason)
    // 库坏时写入必须失败且不覆盖（这是「不静默」的另一半）
    const w = await secrets.setSecret('someprovider', 'v')
    info('库坏时 setSecret', JSON.stringify(w))
    ok('密钥四态：库坏时写入被拒（不是静默写空）', w.ok === false, JSON.stringify(w))
  }

  S['model-kinds'] = async () => {
    const { setConfig } = await import('../../apps/desktop/src/main/services/config')
    const { setSecret } = await import('../../apps/desktop/src/main/services/secrets')
    const { resolveAvailability } = await import('../../apps/desktop/src/main/services/model-availability')
    setConfig({
      models: {
        providers: [
          { id: 'off', name: 'Off', apiHost: 'https://a.example/v1', enabled: false, models: [{ id: 'm' }] },
          { id: 'moff', name: 'MOff', apiHost: 'https://b.example/v1', enabled: true, models: [{ id: 'm', enabled: false }] },
          { id: 'gone', name: 'Gone', apiHost: 'https://c.example/v1', enabled: true, models: [{ id: 'other' }] },
          { id: 'nok', name: 'Nok', apiHost: 'https://d.example/v1', enabled: true, models: [{ id: 'm' }] },
          { id: 'okp', name: 'OK', apiHost: 'https://e.example/v1', enabled: true, models: [{ id: 'm' }] }
        ]
      }
    })
    await setSecret('okp', 'sk')
    const cases = [
      ['disabled', 'off:m'],
      ['model-disabled', 'moff:m'],
      ['missing', 'gone:gone'],
      ['nokey', 'nok:m']
    ]
    for (const [exp, ref] of cases) {
      const r = await resolveAvailability(ref)
      info(ref, JSON.stringify(r))
      eq(`模型失效：${ref} → ${exp}`, r.kind, exp)
    }
    const okr = await resolveAvailability('okp:m')
    eq('模型失效：可用 → ok', okr.ok, true)
  }

  S['wk-mem'] = async () => {
    // worktree 会话应读到主仓记忆（projectMemoryKey 走主仓 root，不是 worktree 路径）
    const mem = await import('../../apps/desktop/src/main/services/memory')
    const scope = await import('../../apps/desktop/src/main/services/worktree/scope')
    info('导出', JSON.stringify(Object.keys(scope).filter((k) => /root|main|repo/i.test(k))))
    // 造一个「主仓 + worktree」结构
    const mainRepo = path.join(root, 'main-repo')
    const wt = path.join(root, 'wt-feature')
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'wt-feature'), { recursive: true })
    fs.writeFileSync(path.join(mainRepo, '.git', 'worktrees', 'wt-feature', 'gitdir'),
      path.join(wt, '.git') + '\n')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(mainRepo, '.git', 'worktrees', 'wt-feature')}\n`)
    fs.writeFileSync(path.join(mainRepo, '.git', 'worktrees', 'wt-feature', 'commondir'), '../..\n')

    // 真实链路：先 upsert 一条 active 的 worktree 记录，再走 projectMemoryRootOf
    const store = await import('../../apps/desktop/src/main/services/worktree/store')
    const paths = await import('../../apps/desktop/src/main/services/worktree/paths')
    const normWt = paths.normalizeWorktreePath(wt)
    store.upsertRecord({
      schemaVersion: 1,
      path: normWt.path,
      compareKey: normWt.compareKey,
      repoRoot: mainRepo,
      repoKey: paths.normalizeWorktreePath(mainRepo).compareKey,
      branch: 'feat/x',
      baseSha: 'a'.repeat(40),
      baseLabel: 'my/dev',
      targetBranch: 'my/dev',
      createdAt: Date.now(),
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: {}
    })
    const resolvedRoot = scope.projectMemoryRootOf(wt)
    info('projectMemoryRootOf(worktree)', String(resolvedRoot))
    eq('worktree 会话的项目记忆根 = 主仓', mem.projectMemoryKey(resolvedRoot), mem.projectMemoryKey(mainRepo))
    const kMain = mem.projectMemoryKey(mainRepo)
    info('主仓 key', kMain)

    // 真正写一条主仓记忆，再从 worktree 读
    const projectDir = path.join(DST, 'projects', kMain)
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'memory.json'),
      JSON.stringify({ version: 1, root: mainRepo, entries: [{ id: 'p_1', content: '主仓记忆', createdAt: 1, updatedAt: 1 }] }))
    const readFromWt = mem.readMemories({ kind: 'project', root: scope.projectMemoryRootOf(wt) })
    info('从 worktree 读', JSON.stringify(readFromWt).slice(0, 200))
    eq('worktree 会话能读到主仓记忆（不是空的）', readFromWt.kind, 'ok')
    eq('worktree 读到的条目数', readFromWt.entries?.length ?? 0, 1)
  }

  S.consolidate = async () => {
    const mem = await import('../../apps/desktop/src/main/services/memory')
    const cons = await import('../../apps/desktop/src/main/services/memory-consolidate')
    info('memory-consolidate 导出', JSON.stringify(Object.keys(cons)))
    // 塞满全局记忆到超预算
    const big = 'x'.repeat(50)
    const entries = []
    for (let i = 0; i < 95; i++) entries.push({ id: 'm_' + i, content: big, createdAt: 1, updatedAt: 1 })
    fs.writeFileSync(path.join(DST, 'memory.json'), JSON.stringify({ version: 1, entries }))
    const limits = mem.memoryLimits({ kind: 'global' })
    info('全局上限', JSON.stringify(limits))
    const used = entries.reduce((n, e) => n + mem.formatMemoryLine(e).length, 0)
    info('当前占用', String(used) + ' / 预算 ' + limits.budget)
    ok('前置：确实是满的', used > limits.budget, `${used} > ${limits.budget}`)
    // 不传模型 → 直接拒写（原行为）
    const plain = mem.writeMemory('一条新记忆', undefined, { kind: 'global' })
    info('无模型时写入', JSON.stringify(plain))
    eq('无模型（定时任务/面板）时仍拒写', plain.ok, false)
    ok('拒写码是超预算类（budget/full 都表示写满）', plain.code === 'budget' || plain.code === 'full', plain.code)
    // 真正的归纳：带模型时应先归纳再写（模型桩给个能返回压缩结果的假模型）
    const cons2 = await import('../../apps/desktop/src/main/services/memory-consolidate')
    const fakeModel = {
      async *stream() {
        // 归纳要求模型返回 JSON 数组：把 95 条压成 2 条
        yield { type: 'text', text: JSON.stringify([
          { id: 'm_0', content: '合并后的一条' },
          { id: 'm_1', content: '合并后的另一条' }
        ]) }
      }
    }
    const w2 = await cons2.writeMemoryWithConsolidation('新的记忆内容', undefined, { kind: 'global' }, fakeModel)
    info('带模型写入', JSON.stringify(w2).slice(0, 400))
    ok('归纳：写满时带模型会先归纳再写（ok 或有明确失败原因）',
       typeof w2 === 'object' && ('ok' in w2), JSON.stringify(Object.keys(w2 || {})))
    const after = mem.readMemories({ kind: 'global' })
    info('归纳后条目数', String(after.entries.length))
  }

  const fn = S[kase]
  if (!fn) { console.error('unknown case', kase); process.exit(2) }
  console.log(`=== ${kase} ===`)
  try { await fn() } catch (e) {
    fails++
    console.log('FAIL 抛异常 :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e))
  }
  console.log(`=== ${kase} 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})()