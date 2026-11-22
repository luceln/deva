# Model swap result lifecycle regression

Run `node .deva/qa/model-swap-lifecycle/build.cjs` from the repository root, open `.deva/qa/model-swap-lifecycle/.artifacts/page.html` in a foreground Chromium tab, and run these sequentially in DevTools:

```js
await window.runSwapLifecycle('mixed', false)
await window.runSwapLifecycle('mixed', true)
await window.runSwapLifecycle('success', false)
window.lifecycleErrors
```

Each run returns DOM snapshots, IPC and store commit order, and a `failures` array. On the fix, all three `failures` arrays and `lifecycleErrors` are empty. The second run returns a different broken reference from the final scan. The third run checks ordinary success.

The harness renders the real `ModelPanel`, `ModelSwapDialog`, `ChatProvider`, store actions, and surrounding providers. Only `window.deva` IPC responses are controlled. `listSessions` and the final `scanModelSwap` are paused separately to observe committed renderer state, without replacing the store's broken cache or its clearing logic. This does not exercise real Electron IPC or disk writes.

## Negative control

On base `89a6b31802aa11ad74facb5a4871e6cff970fd9c`, with the harness but without the `ModelPanel.tsx` change, `mixed, false` fails 8 of 9 checks. The one passing check verifies the original swap request scope. Observed sequence:

1. Initial scan commits `fixture:old`; the chip opens the dialog.
2. `applyModelSwap({ mainId: 's1', fromRef: 'fixture:old', toRef: 'fixture:new' })` returns the fixture. The real store commits an empty broken cache while `listSessions` is still pending. The dialog is already absent.
3. The list returns; final `scanModelSwap` waits and then returns. The toast contains all counts, but the dialog summary is `null` and there are no result rows.

On the fix, the dialog remains mounted during both waits. The settled mixed result includes `Saved index pending` (`Saved`), `Changed meanwhile` (`Not changed — now using Current model`), and `Write failed` (`Switch failed`), even if a different broken reference appears on rescan. Clicking `Done` closes the dialog.
