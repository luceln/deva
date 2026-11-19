/**
 * 合并面板用例。断言写在 `window.__logs`，标题变 DONE n/m 供外部读取。
 *
 * 每条都对应规格里一条「做错会被打回」的硬约束，注释写明出处。
 */
const logs: string[] = []
let pass = 0
let fail = 0

function log(m: string): void {
  logs.push(m)
}
function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      log('PASS ' + name)
    })
    .catch((e) => {
      fail++
      log('FAIL ' + name + ' → ' + (e as Error)?.message)
    })
}
function assert(c: unknown, msg: string): void {
  if (!c) throw new Error(msg)
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}：实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const q = (s: string): HTMLElement | null => document.querySelector(s)
const qa = (s: string): HTMLElement[] => [...document.querySelectorAll(s)]
const txt = (s: string): string => (q(s)?.textContent ?? '').trim()

async function waitFor<T>(fn: () => T | null | undefined, msg: string, ms = 3000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('超时：' + msg)
    await sleep(25)
  }
}

/** 点「合并」并等结果落到面板上。 */
async function doMerge(result: unknown): Promise<void> {
  ;(window as any).__stubMergeResult(result)
  const btn = await waitFor(
    () => qa('.cf-wt-merge__foot button').find((b) => !(b as HTMLButtonElement).disabled),
    '合并按钮不可点'
  )
  btn.click()
  await sleep(120)
}

async function main(): Promise<void> {
  /* ── ① 复制命令的三条硬要求（§4.7） ── */
  await ok('① 复制命令带 cd、Windows 用 cd /d、用分支名不用 SHA', () => {
    const win = (window as any).__mergeCommand('C:\\repo\\wts\\feat', 'deva/req', 'win32')
    eq(win, 'cd /d "C:\\repo\\wts\\feat" && git merge --no-ff deva/req', 'Windows 命令')
    assert(win.includes('/d'), 'Windows 必须带 /d（跨盘符必需）')
    const mac = (window as any).__mergeCommand('/repo/wts/feat', 'deva/req', 'darwin')
    eq(mac, 'cd "/repo/wts/feat" && git merge --no-ff deva/req', 'macOS 命令不该有 /d')
    // 用分支名：传进来的就是分支名，命令里不该出现 40 位 SHA
    assert(!/[0-9a-f]{40}/.test(win), '命令里不该有 SHA')
  })

  await ok('② 中止命令同样带 cd /d', () => {
    eq(
      (window as any).__abortCommand('C:\\a b', 'win32'),
      'cd /d "C:\\a b" && git merge --abort',
      '中止命令'
    )
  })

  /* ── ③ 四个圆点：按数组顺序、不过滤、C1 是 warn（§4.6） ── */
  await ok('③ 四个圆点按数组顺序渲染，不过滤，C1 显示为 warn（黄）', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: false,
      mergeAttempted: false,
      reason: 'source-branch-changed',
      message: '',
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      checks: [
        { id: 'C1', status: 'warn', reason: 'dirty', detail: { dirtyCount: 2 } },
        { id: 'C2', status: 'bad', reason: 'branch-changed', detail: { actualBranch: 'hotfix' } },
        { id: 'C4', status: 'bad', reason: 'not-checked-out', detail: { primaryBranch: 'my/dev' } },
        { id: 'C5', status: 'skipped', reason: 'source-missing', detail: {} }
      ]
    })
    const dots = await waitFor(() => (qa('.cf-wt-merge__dot').length ? qa('.cf-wt-merge__dot') : null), '没画圆点')
    eq(dots.length, 4, '必须画 4 个圆点（不按 status 过滤）')
    eq(dots.map((d) => d.className.replace('cf-wt-merge__dot ', '')).join(','), 'is-warn,is-bad,is-bad,is-skipped', '颜色与顺序')
    const labels = qa('.cf-wt-merge__checklabel').map((d) => d.textContent)
    eq(labels.length, 4, '四个标题都要有')
    // C1 是 warn 颜色，不能是 bad —— 它不阻断合并
    assert(dots[0].className.includes('is-warn'), 'C1 必须是 warn，不是 bad')
  })

  /* ── ④ 检查阶段 message 为空串：文案从 checks[].reason 拼（§4.6） ── */
  await ok('④ message 是空串时靠 checks[].reason 出文案（不显示空白）', async () => {
    const texts = qa('.cf-wt-merge__checktext').map((d) => (d.textContent ?? '').trim())
    assert(texts.length >= 3, `应有说明句，实际 ${texts.length} 条`)
    assert(
      texts.some((x) => x.includes('2') && x.includes('未提交')),
      'C1 的 dirty 应显示「2 个未提交改动」：' + JSON.stringify(texts)
    )
    assert(texts.some((x) => x.includes('hotfix')), 'C2 应显示实际分支 hotfix')
    // 不该冒出空白的说明行
    assert(!texts.some((x) => x === ''), '说明句不该为空')
  })

  /* ── ⑤ 冲突时 git 原文原样显示、不翻译（§4.6） ── */
  await ok('⑤ conflict 时 git 原文原样显示（不翻译）', async () => {
    ;(window as any).__mountMerge()
    const raw = 'CONFLICT (content): Merge conflict in src/foo.ts\nAuto-merging src/foo.ts'
    await doMerge({
      ok: false,
      mergeAttempted: true,
      reason: 'conflict',
      message: raw,
      gitOutput: raw,
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      targetPath: 'C:\\repo\\main',
      checks: [
        { id: 'C1', status: 'ok', detail: { dirtyCount: 0 } },
        { id: 'C2', status: 'ok', detail: {} },
        { id: 'C4', status: 'ok', detail: {} },
        { id: 'C5', status: 'ok', detail: {} }
      ]
    })
    const pre = await waitFor(() => q('.cf-wt-merge__fail .cf-wt-merge__pre'), '没显示原文')
    eq(pre.textContent, raw, '原文必须一字不改')
    assert(txt('.cf-wt-merge__failhead').length > 0, '要有中文标题')
  })

  /* ── ⑥ 失败出口四个平权，中止传 targetPath（§4.7） ── */
  await ok('⑥ 失败出口四个、全是 btn--sm、中止传 targetPath 不传 focusRoot', async () => {
    const exits = qa('.cf-wt-merge__exits button')
    eq(exits.length, 4, `应有四个出口，实际 ${exits.length}`)
    for (const b of exits) {
      assert(b.className.includes('btn--sm'), '出口必须都是 --sm：' + b.textContent)
      assert(!b.className.includes('btn--primary'), '出口都不做 primary：' + b.textContent)
    }
    const names = exits.map((b) => (b.textContent ?? '').trim())
    assert(names.some((x) => x.includes('中止')), '缺「中止合并」：' + JSON.stringify(names))

    ;(window as any).__devaStub.calls = []
    exits[0].click()
    await sleep(100)
    const call = (window as any).__devaStub.calls.find((c: any) => c.m === 'mergeAbort')
    assert(call, '没调用 mergeAbort')
    eq(call.dir, 'C:\\repo\\main', '必须传 targetPath（不能传当前会话的 focusRoot）')
  })

  /* ── ⑦ 成功面板：短 SHA / upToDate 不显示 SHA / behindNote 出「再次合并」（§4.8） ── */
  await ok('⑦ 成功面板显示 7 位短 SHA 与可展开的 git 原文', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: true,
      upToDate: false,
      targetPath: 'C:\\repo\\main',
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      sourceSha: 'a'.repeat(40),
      mergeCommit: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      gitOutput: "Merge made by the 'ort' strategy.\n src/a.ts | 2 +-"
    })
    const sha = await waitFor(() => q('.cf-wt-merge__sha'), '没显示合并提交')
    assert(txt('.cf-wt-merge__sha').includes('3f9a2c1'), 'SHA 应短 7 位：' + txt('.cf-wt-merge__sha'))
    assert(!txt('.cf-wt-merge__sha').includes('bbbbbbbbbb'), '不该显示完整 SHA')
    assert(txt('.cf-wt-merge__okhead').includes('已合并到 my/dev'), '标题：' + txt('.cf-wt-merge__okhead'))
    // git 原文默认收起，点了才展开
    assert(!q('.cf-wt-merge__pre'), '原文应默认收起')
    const toggle = qa('.cf-wt-merge__ok button').find((b) => (b.textContent ?? '').includes('显示'))!
    assert(toggle, '缺展开按钮')
    toggle.click()
    await sleep(80)
    assert(txt('.cf-wt-merge__pre').includes("Merge made by the 'ort' strategy."), '展开后应显示原文')
    void sha
  })

  await ok('⑧ upToDate 时不显示 SHA 与原文，文案是「无需合并」', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: true,
      upToDate: true,
      targetPath: 'C:\\repo\\main',
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      sourceSha: 'a'.repeat(40),
      mergeCommit: null,
      gitOutput: ''
    })
    await waitFor(() => q('.cf-wt-merge__okhead'), '没成功面板')
    assert(txt('.cf-wt-merge__okhead').includes('无需合并'), '应说无需合并：' + txt('.cf-wt-merge__okhead'))
    assert(!q('.cf-wt-merge__sha'), 'upToDate 不该显示 SHA')
    assert(!q('.cf-wt-merge__pre'), 'upToDate 不该显示原文')
  })

  await ok('⑨ behindNote 出「N 个新提交尚未合并」+「再次合并」', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: true,
      upToDate: false,
      targetPath: 'C:\\repo\\main',
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      sourceSha: 'a'.repeat(40),
      mergeCommit: '3f9a2c1' + 'b'.repeat(33),
      gitOutput: 'x',
      behindNote: { pendingSha: 'c'.repeat(40), pendingCount: 3 }
    })
    await waitFor(() => q('.cf-wt-merge__behind'), '没 behindNote')
    assert(txt('.cf-wt-merge__behind').includes('3'), '应显示 3 个新提交：' + txt('.cf-wt-merge__behind'))
    assert(qa('.cf-wt-merge__behind button').some((b) => (b.textContent ?? '').includes('再次合并')), '缺「再次合并」')
  })

  /* ── ⑩ C5 交集非空 → 二选一，不拦死（§4.9.4） ── */
  await ok('⑩ C5 交集非空时给三个选择（不是拦死），并列出会被覆盖的文件', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: false,
      mergeAttempted: false,
      reason: 'target-overlap',
      message: '',
      targetBranch: 'my/dev',
      sourceBranch: 'deva/req-worktree-ui',
      targetPath: 'C:\\repo\\main',
      checks: [
        { id: 'C1', status: 'ok', detail: { dirtyCount: 0 } },
        { id: 'C2', status: 'ok', detail: {} },
        { id: 'C4', status: 'ok', detail: {} },
        {
          id: 'C5',
          status: 'bad',
          reason: 'overlap',
          detail: { overlapPaths: ['src/a.ts', 'src/b.ts', 'docs/c.md'] }
        }
      ]
    })
    const box = await waitFor(() => q('.cf-wt-merge__overlap'), '没出二选一')
    assert(box, '必须有 .cf-wt-merge__overlap')
    const btns = qa('.cf-wt-merge__overlap button').map((b) => (b.textContent ?? '').trim())
    assert(btns.some((x) => x.includes('先存起来')), '缺「先存起来再合并」：' + JSON.stringify(btns))
    assert(btns.some((x) => x.includes('终端')), '缺「我去终端自己处理」')
    assert(btns.some((x) => x === '取消'), '缺「取消」')
    // 覆盖的文件必须列出来（用户要知道是哪几个）
    const paths = qa('.cf-wt-merge__paths li').map((l) => l.textContent)
    eq(paths.join(','), 'src/a.ts,src/b.ts,docs/c.md', '覆盖清单')
    // 提示句里的数字要对
    assert(txt('.cf-wt-merge__overlap p').includes('3'), '提示句应带 3：' + txt('.cf-wt-merge__overlap p'))
  })

  await ok('⑪ 「先存起来再合并」传 stashFirst: true 重调 merge', async () => {
    ;(window as any).__devaStub.calls = []
    const b = qa('.cf-wt-merge__overlap button').find((x) => (x.textContent ?? '').includes('先存起来'))!
    b.click()
    await sleep(120)
    const call = (window as any).__devaStub.calls.find((c: any) => c.m === 'merge')
    assert(call, '没重调 merge')
    eq(call.req.stashFirst, true, '必须显式传 stashFirst（自动 stash 是禁止项）')
  })

  /* ── ⑫ target-not-set：不画圆点，出选择器，不自动挑（§4.9.4） ── */
  await ok('⑫ target-not-set 时不出圆点、出目标选择器、不自动挑一个', async () => {
    ;(window as any).__mountMerge()
    await doMerge({
      ok: false,
      mergeAttempted: false,
      reason: 'target-not-set',
      message: '',
      targetBranch: null,
      sourceBranch: 'deva/req-worktree-ui',
      checks: []
    })
    await waitFor(() => q('.cf-wt-merge__pick'), '没出选择器')
    eq(qa('.cf-wt-merge__dot').length, 0, 'target-not-set 时不该画圆点（checks 为空）')
    const sel = q('.cf-wt-merge__select') as HTMLSelectElement
    assert(sel, '缺选择器')
    eq(sel.value, '', '不该自动选中一个分支')
  })

  await ok('⑬ 选目标后调 setTarget 并写回分支名', async () => {
    // 候选分支必须在**挂载前**就位：面板在 target-not-set 时立刻拉一次，
    // 桩数据晚设就会先拿到一次空列表（这一版用例第一次跑就是这么红的）。
    ;(window as any).__stubBranches(['my/dev', 'my/main'])
    ;(window as any).__mountMerge()
    await doMerge({
      ok: false,
      mergeAttempted: false,
      reason: 'target-not-set',
      message: '',
      targetBranch: null,
      sourceBranch: 'deva/req-worktree-ui',
      checks: []
    })
    const sel = await waitFor(() => q('.cf-wt-merge__select') as HTMLSelectElement, '没选择器')
    await waitFor(
      () => (sel.querySelectorAll('option').length > 1 ? sel : null),
      '候选分支一直没加载出来'
    )
    await sleep(150)
    const opts = [...sel.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value)
    assert(opts.includes('my/dev') && opts.includes('my/main'), '候选分支：' + JSON.stringify(opts))
    ;(window as any).__devaStub.calls = []
    sel.value = 'my/dev'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(50)
    const btn = qa('.cf-wt-merge__pickrow button')[0] as HTMLButtonElement
    assert(!btn.disabled, '选完分支后按钮应可点')
    btn.click()
    await sleep(150)
    const call = (window as any).__devaStub.calls.find((c: any) => c.m === 'setTarget')
    assert(call, '没调 setTarget')
    eq(call.req.targetBranch, 'my/dev', '应写回选中的分支')
  })

  const title = `DONE ${pass}/${pass + fail}`
  document.title = title
  ;(window as any).__logs = logs
  console.log(logs.join('\n'))
}

;(window as any).__runTest = main
