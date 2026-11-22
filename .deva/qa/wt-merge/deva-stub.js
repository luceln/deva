/**
 * 「工作区合并面板」的桩：只替换 `window.deva` 上合并用到的通道，其余照真实形状给。
 *
 * 关键点：`MergePanel` 的 result 来自 `worktree.merge()` 的返回值，所以**结果由桩喂**——
 * 外部先 `__stubMergeResult(x)` 再点「合并」，就能把任意 MergeResult 摆到面板上。
 * 中止合并记录入参，用来验「传的是 targetPath 而不是 focusRoot」。
 */
window.__devaStub = {
  platform: 'win32',
  mergeResult: null,
  calls: [],
  reset() {
    this.mergeResult = null
    this.calls = []
  }
}

window.__stubMergeResult = (r) => {
  window.__devaStub.mergeResult = r
}
window.__stubBranches = (list) => {
  window.__devaStub.branches = list
}

window.deva = {
  platform: 'win32',
  worktree: {
    merge: async (req) => {
      window.__devaStub.calls.push({ m: 'merge', req })
      return window.__devaStub.mergeResult
    },
    setTarget: async (req) => {
      window.__devaStub.calls.push({ m: 'setTarget', req })
      return { ok: true, targetBranch: req.targetBranch }
    }
  },
  git: {
    branches: async (dir) => {
      window.__devaStub.calls.push({ m: 'branches', dir })
      return (window.__devaStub.branches ?? []).map((n) => ({
        name: n,
        current: false,
        remote: null,
        upstream: null
      }))
    },
    mergeAbort: async (dir) => {
      window.__devaStub.calls.push({ m: 'mergeAbort', dir })
      return { ok: true }
    }
  },
  terminal: {
    create: async (opts) => {
      window.__devaStub.calls.push({ m: 'terminal', cwd: opts.cwd })
      return { id: 't1' }
    }
  },
  fs: {
    revealFolder: async (p) => {
      window.__devaStub.calls.push({ m: 'reveal', path: p })
      return { ok: true }
    }
  }
}
