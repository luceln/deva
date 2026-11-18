/**
 * 分支 pill 刷新时机 —— 浏览器内驱动真实 GitWidget。
 *
 * 打桩边界（只替掉与本用例无关的重依赖，GitWidget 本体、useGitStatus 都是真代码）：
 *   store/chat   —— 真实 ChatProvider 挂载时打一串 chat.* IPC，与 pill 无关
 *   store/models —— 只用来拼「生成提交信息」的模型，本用例给空
 * 其余（i18n / Toast / Dialog / Modal / ContextMenu / lucide）全用真实实现。
 *
 * 判据只认 DOM：pill 的 .cf-gitchip__branch 文本 = 桩 git.status 返回的分支名。
 * 断言的是「外部改了分支之后，什么动作能让 pill 跟上」——这正是用户报的 bug。
 */

const LOGS = []
window.__logs = LOGS
const log = (m) => {
  LOGS.push(m)
  console.log(m)
}

const CASES = []
function ok(name, fn) {
  CASES.push({ name, fn })
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

const ROOT = 'E:\\deva'

/** 桩 window.deva.git：branchNow 是「外部世界当前的分支」，测试中途改它模拟终端切分支。 */
function makeGitStub() {
  const st = { branchNow: 'dev', statusCalls: 0, failNext: false }
  window.deva = {
    platform: 'win32',
    git: {
      available: async () => ({ available: true }),
      status: async (root) => {
        st.statusCalls++
        assert(root === ROOT, `git.status 收到的 root 不对：${root}`)
        if (st.failNext) {
          st.failNext = false
          throw new Error('模拟 git status 失败')
        }
        return {
          isRepo: true,
          root,
          branch: st.branchNow,
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          remotes: [],
          mergeInProgress: false,
          staged: [],
          unstaged: [],
          conflicts: []
        }
      },
      branches: async () => [{ name: st.branchNow, current: true, remote: null, upstream: null }],
      log: async () => [],
      diff: async () => [],
      commit: async () => ({ ok: true }),
      checkout: async () => ({ ok: true }),
      createBranch: async () => ({ ok: true }),
      renameBranch: async () => ({ ok: true }),
      deleteBranch: async () => ({ ok: true }),
      merge: async () => ({ ok: true }),
      abortMerge: async () => ({ ok: true }),
      fetch: async () => ({ ok: true }),
      pull: async () => ({ ok: true }),
      push: async () => ({ ok: true }),
      genMessage: async () => ({ ok: false, reason: 'no-model' })
    },
    config: { set: async () => ({ ok: true }), get: async () => ({}) }
  }
  return st
}

/** 轮询等条件成立（React 更新是异步的，不 sleep 而是等 DOM）。 */
async function waitFor(fn, msg, timeout = 3000) {
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

function pillText() {
  const el = document.querySelector('.cf-gitchip__branch')
  return el ? el.textContent.trim() : null
}

function setVisibility(state, focused) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  Object.defineProperty(document, 'hasFocus', { value: () => focused, configurable: true })
}

function fireFocus() {
  window.dispatchEvent(new Event('focus'))
}

// ── 用例 ──────────────────────────────────────────────────────────

ok('挂载即渲染当前分支（dev）', async () => {
  await waitFor(() => pillText() === 'dev', 'pill 未显示 dev')
})

ok('外部切到 main 后，不触发任何动作时 pill 仍是旧值（复现 bug 基线）', async () => {
  window.__git.branchNow = 'main'
  // 给 React 足够的调度时间；此刻没有任何刷新时机被触发
  await new Promise((r) => setTimeout(r, 300))
  eq(pillText(), 'dev', '未触发刷新时 pill 不该变（这条用于确认基线，变了说明有别的东西在拉）')
})

ok('窗口重新获得焦点 → pill 更新为 main', async () => {
  setVisibility('visible', true)
  fireFocus()
  await waitFor(() => pillText() === 'main', 'focus 后 pill 未更新为 main')
})

ok('窗口不可见（hidden）时 focus 不触发拉取', async () => {
  const before = window.__git.statusCalls
  window.__git.branchNow = 'feature/x'
  setVisibility('hidden', false)
  fireFocus()
  await new Promise((r) => setTimeout(r, 300))
  eq(window.__git.statusCalls, before, 'hidden 状态下不该发 status 请求')
  eq(pillText(), 'main', 'hidden 状态下 pill 不该变')
})

ok('窗口可见但未聚焦（document.hasFocus() 为假）时不拉取', async () => {
  const before = window.__git.statusCalls
  setVisibility('visible', false)
  fireFocus()
  await new Promise((r) => setTimeout(r, 300))
  eq(window.__git.statusCalls, before, 'hasFocus() 为假时不该发 status 请求')
})

ok('恢复可见 + 聚焦 → pill 跟上 feature/x', async () => {
  setVisibility('visible', true)
  fireFocus()
  await waitFor(() => pillText() === 'feature/x', 'focus 后 pill 未更新为 feature/x')
})

ok('连续两次 focus 不叠加并发请求（reqRef 防竞态）', async () => {
  const before = window.__git.statusCalls
  window.__git.branchNow = 'dev2'
  fireFocus()
  fireFocus()
  await waitFor(() => pillText() === 'dev2', 'pill 未更新为 dev2')
  const delta = window.__git.statusCalls - before
  assert(delta >= 1, `至少应有 1 次 status 请求，实际 ${delta}`)
  assert(delta <= 2, `两次 focus 最多 2 次请求，实际 ${delta}（说明没有叠加）`)
})

ok('status 抛错时 pill 隐藏而不崩（容错路径）', async () => {
  window.__git.failNext = true
  setVisibility('visible', true)
  fireFocus()
  await waitFor(() => pillText() === null, 'status 失败后 pill 应隐藏（GitWidget 返回 null）')
})

ok('恢复后 focus 能让 pill 重新出现', async () => {
  setVisibility('visible', true)
  fireFocus()
  await waitFor(() => pillText() === 'dev2', '恢复后 pill 未重新出现')
})

ok('卸载后 focus 监听已移除（不残留、不报错）', async () => {
  const errors = []
  const onErr = (e) => errors.push(e.message)
  window.addEventListener('error', onErr)
  window.__unmount()
  await new Promise((r) => setTimeout(r, 100))
  const before = window.__git.statusCalls
  // 卸载后即便派发 focus，也不该再发请求（监听已清理）
  setVisibility('visible', true)
  fireFocus()
  await new Promise((r) => setTimeout(r, 300))
  window.removeEventListener('error', onErr)
  eq(window.__git.statusCalls, before, '卸载后 focus 仍在发请求（监听没清理）')
  eq(errors.length, 0, `卸载后 focus 触发报错：${errors.join('; ')}`)
})

// ── 运行 ──────────────────────────────────────────────────────────

async function main() {
  window.__git = makeGitStub()
  setVisibility('visible', true)
  window.__mount()
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
  const msg = `FATAL ${e && (e.stack || e.message)}`
  log(msg)
  const pre = document.createElement('pre')
  pre.id = 'fatal'
  pre.textContent = msg
  document.body.appendChild(pre)
  document.title = 'DONE FATAL'
})
