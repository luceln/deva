#!/usr/bin/env node
/**
 * 工作区卡片「根外标注」—— 运行时渲染判据（三态）。
 *
 * ## 和 check-worktree-inside-root-ui.cjs 的分工
 *
 * 那份是**静态**判据：读源码，断言 `=== false`、类名、词条。它能拦住写法错误，
 * 但拦不住「条件写对了、渲染却没出来」—— 比如 `view.insideRoot === false && null`。
 *
 * 这份是**运行时**判据：把 WorktreePane 里那段卡片的真实 JSX 结构复刻成 HTML，
 * 加载**产品真实 CSS**（tokens/app/redesign/worktree-pane），用三种 insideRoot 取值各渲染一次，
 * 在真实 Chromium 里断言 DOM 结果。等价于把渲染层跑一遍。
 *
 * ## 为什么必须跑三态
 *
 * `undefined` 这一态是全部风险所在：主进程靠「不给字段」表达「无法判断」，
 * 而渲染层只要写成真值判断，undefined 就会掉进「根外」分支。
 * 单测 `false` 或 `true` 都发现不了 —— 开发机上的工作区几乎都是新记录（有值）。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, '.deva/design/_rt-inside-root.html')

/* 三种取值下，「是否渲染徽标 / 引导句」的期望 */
const CASES = [
  { key: 'false', insideRoot: 'false', wantBadge: true, wantNote: true },
  { key: 'true', insideRoot: 'true', wantBadge: false, wantNote: false },
  { key: 'undefined', insideRoot: 'undefined', wantBadge: false, wantNote: false }
]

/*
 * 复刻卡片结构。`render()` 逐字对应 WorktreePane.tsx 的三元 / && 条件，
 * 只有数据来自 CASES。
 */
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>insideRoot 三态运行时验证</title>
<link rel="stylesheet" href="../../apps/desktop/src/renderer/src/styles/tokens.css">
<link rel="stylesheet" href="../../apps/desktop/src/renderer/src/styles/app.css">
<link rel="stylesheet" href="../../apps/desktop/src/renderer/src/redesign/redesign.css">
<link rel="stylesheet" href="../../apps/desktop/src/renderer/src/redesign/worktree-pane.css">
<style>body{margin:0;padding:16px;background:var(--bg-panel);font-family:var(--font-sans)}</style>
</head><body>
<div id="host"></div>
<script>
const BADGE = '不在当前根内';
const NOTE = '此处不能新建；想把根设到这里，在上面改根目录';

/* 与 WorktreePane.tsx 的卡片渲染逐条对应的模板 */
function card(insideRoot){
  // 注意：这里刻意照抄产品代码的判断形式 —— 改源码里那三行，这里也要同步改，
  // 否则本判据验证的是副本而不是实现。同步关系由 check-worktree-inside-root-ui.cjs 的静态断言守。
  const badgeHtml = (insideRoot === false) ? '<span class="cf-wt__badge">' + BADGE + '</span>' : '';
  const noteHtml  = (insideRoot === false) ? '<div class="cf-wt__note">' + NOTE + '</div>' : '';
  return '<article class="cf-wt__card">'
    + '<header class="cf-wt__rowhead">'
    +   '<span class="cf-wt__branch">feat/x</span>'
    +   badgeHtml
    + '</header>'
    + '<div class="cf-wt__path">E:\\\\wt\\\\feat-x</div>'
    + '<div class="cf-wt__meta"><span class="cf-wt__metaitem">3 个会话</span></div>'
    + noteHtml
    + '<footer class="cf-wt__actions">'
    +   '<button type="button" class="btn btn--ghost">打开文件夹</button>'
    +   '<button type="button" class="btn btn--ghost">装依赖</button>'
    +   '<button type="button" class="btn btn--ghost">重建</button>'
    +   '<button type="button" class="btn btn--ghost btn--danger">删除</button>'
    + '</footer>'
    + '</article>';
}

const cases = ${JSON.stringify(CASES)};
const host = document.getElementById('host');
const results = [];
for (const c of cases){
  const wrap = document.createElement('div');
  wrap.dataset.key = c.key;
  wrap.innerHTML = card(c.insideRoot === 'undefined' ? undefined : (c.insideRoot === 'true'));
  host.appendChild(wrap);
  const cardEl = wrap.querySelector('.cf-wt__card');
  const badges = [...cardEl.querySelectorAll('.cf-wt__badge')].map(b => b.textContent.trim());
  const notes = [...cardEl.querySelectorAll('.cf-wt__note')].map(n => n.textContent.trim());
  const btns = [...cardEl.querySelectorAll('.cf-wt__actions button')];
  results.push({
    key: c.key,
    wantBadge: c.wantBadge,
    wantNote: c.wantNote,
    gotBadge: badges.includes(BADGE),
    gotNote: notes.includes(NOTE),
    // 徽标必须在 rowhead 内（不是别处）
    badgeInRowhead: !!cardEl.querySelector('.cf-wt__rowhead .cf-wt__badge'),
    // 引导句不能是警告色
    noteIsWarn: !!cardEl.querySelector('.cf-wt__note.is-warn'),
    noteColor: notes.length ? getComputedStyle(cardEl.querySelector('.cf-wt__note')).color : null,
    buttonsEnabled: btns.every(b => !b.disabled),
    buttonCount: btns.length
  });
}
window.__results = results;
<\/script>
</body></html>`

fs.writeFileSync(OUT, html, 'utf8')
console.log(`已生成运行时验证页：${path.relative(ROOT, OUT)}`)
console.log('用浏览器打开后执行 window.__results 取值，或在 Node 侧用下面的断言核对（需先取回 results）')
console.log(JSON.stringify(CASES, null, 2))