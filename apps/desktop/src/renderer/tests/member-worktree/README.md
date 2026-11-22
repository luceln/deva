# Member worktree renderer checks

These mount the production `MemberWorktreePanel` / `MemberWorktreeDialog`, `Modal`, dialogs, translations and CSS in real Chromium, with controlled IPC boundaries. They do **not** prove Electron directory-picker behavior, real Git operations, backend persistence, or the new-member waiting-card flow.

From `apps/desktop`:

```sh
pnpm exec esbuild src/renderer/tests/member-worktree/browser.jsx --bundle --outfile=src/renderer/tests/member-worktree/.artifacts/browser.js --jsx=automatic
```

Open `index.html` in Chromium, then run:

```js
await window.runMemberWorktreeChecks('en')
await window.runMemberWorktreeChecks('zh-CN')
await window.runMemberWorktreeAdapterChecks()
```

Expected: 16 checks for each language and 6 adapter checks. Each remount unmounts the previous root and removes its host. Assertions check nonempty, uniquely identified DOM targets before testing properties.

For narrow-layout inspection, run the panel checks last, use a 360 × 640 viewport, and inspect `.modal__card`, `.cf-mwt__scroll`, safety notice and footer. The content scrolls; the safety notice and action buttons stay outside that scroller. Repeat with `document.documentElement.dataset.theme = 'dark'` at 560 × 720.

The source/canonical-path fixture deliberately differs in slash style and case. The service supplies canonical source, relative path, branch, target and base SHA. The bind request must match that preview, keep the fixed member ID and pass `skipDeps: true`; no Git worktree is created by this harness.
