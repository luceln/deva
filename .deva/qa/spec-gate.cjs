#!/usr/bin/env node
/**
 * 实施门槛：把 `.deva/spec-worktree-parallel.md` §8 的任务表变成可跑的判据。
 *
 * ## 为什么需要它
 *
 * spec §8 开头写着：「每个任务写明：改哪些文件 / 依赖 / **完成的判据**。判据要么是**可跑的断言编号**，
 * 要么是**可 grep 的事实**。」——这句话等于说这张表本来就该是机械可查的，但它躺在 2839 行文档里，
 * 只能靠人记。
 *
 * 实测代价：本轮写完 spec 后，P0 还差 4 个任务（含整块 Git 锁）就差点直接跳到 P3 的删除流程。
 * 不是因为不懂规矩，而是因为「P0 全绿才许进 P1」这条门槛只有一个读者，而读者会忘。
 *
 * ## 判据只认三种事实
 *
 *   file       文件存在
 *   grep       某文件里能搜到某个记号（断言编号 / 函数名 / 通道名）
 *   absent     某文件里**搜不到**某个记号（用于「不许再调 X」这类否定判据）
 *
 * 不写「我判断它做对了」——那种判据无法复跑，也就无法拦人。行为正确性交给 driver 的断言，
 * 这里只回答一个问题：**这个任务的产物在不在、有没有留下可复跑的断言。**
 *
 * ## 这个脚本查不到什么
 *
 *   - 断言是不是真的有效（可能写了 `A35` 但断言恒真）→ 那是 break-*.cjs 与验收的活
 *   - 实现是否符合 spec 的算法细节（如失败清理的六步顺序）→ 那是代码审查的活
 *   - 界面是否好用 → 要人看
 *
 * 所以它绿了只代表「产物齐了」，不代表「做对了」。**但红了就一定不能往下走。**
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const WT = 'apps/desktop/src/main/services/worktree'
const QA = '.deva/qa/test-main.ts'

/**
 * 任务表，逐条对应 spec §8。`criteria` 里每项都能机械判定。
 *
 * 每一项写 `why`：判据不满足时告诉人「缺的是什么」，而不是只报一个文件名。
 */
const TASKS = [
  // ─────────── P0 · 地基与数据安全 ───────────
  {
    id: 'T0.1',
    stage: 'P0',
    name: 'fs-guard 导出 realResolve',
    criteria: [
      { kind: 'grep', file: 'apps/desktop/src/main/services/fs-guard.ts', pattern: 'export function realResolve', why: 'realResolve 未导出' }
    ]
  },
  {
    id: 'T0.2',
    stage: 'P0',
    name: 'paths.ts 归一化 / repoKeyOf / slugifyBranch',
    criteria: [
      { kind: 'file', file: `${WT}/paths.ts`, why: 'paths.ts 不存在' },
      { kind: 'grep', file: `${WT}/paths.ts`, pattern: 'export function normalizeWorktreePath', why: '缺少 normalizeWorktreePath' },
      { kind: 'grep', file: `${WT}/paths.ts`, pattern: 'export function compareKeyOfPath', why: '缺少 compareKeyOfPath' },
      { kind: 'grep', file: `${WT}/paths.ts`, pattern: 'export function repoKeyOf', why: '缺少 repoKeyOf' },
      { kind: 'grep', file: `${WT}/paths.ts`, pattern: 'export function slugifyBranch', why: '缺少 slugifyBranch' },
      { kind: 'grep', file: QA, pattern: 'wtpaths', why: 'wtpaths 场景不存在' }
    ]
  },
  {
    id: 'T0.3',
    stage: 'P0',
    name: 'store.ts 读写 + 写盘返回布尔',
    criteria: [
      { kind: 'file', file: `${WT}/store.ts`, why: 'store.ts 不存在' },
      { kind: 'grep', file: `${WT}/store.ts`, pattern: 'writeFileAtomic', why: '未走 writeFileAtomic' },
      { kind: 'grep', file: `${WT}/store.ts`, pattern: 'loadState', why: '没有读失败三态' },
      { kind: 'grep', file: QA, pattern: 'wtstore', why: 'wtstore 场景不存在' }
    ]
  },
  {
    id: 'T0.4',
    stage: 'P0',
    name: 'lock.ts — Git 锁（withGitLock / gitLockHolder）',
    criteria: [
      { kind: 'file', file: `${WT}/lock.ts`, why: 'lock.ts 不存在：Git 锁整块没做，多会话同时改同一仓库没有互斥' },
      { kind: 'grep', file: `${WT}/lock.ts`, pattern: 'withGitLock', why: '缺少 withGitLock' },
      { kind: 'grep', file: QA, pattern: 'wtlock', why: 'wtlock 场景不存在（锁的行为没有断言）' }
    ]
  },
  {
    id: 'T0.5',
    stage: 'P0',
    name: 'git-worktree.ts — add / remove / list / HEAD 校验 / 失败清理',
    criteria: [
      { kind: 'file', file: `${WT}/git-worktree.ts`, why: 'git-worktree.ts 不存在' },
      { kind: 'grep', file: `${WT}/git-worktree.ts`, pattern: 'cleanupFailedCreate', why: '缺少失败清理 cleanupFailedCreate' },
      { kind: 'grep', file: `${WT}/git-worktree.ts`, pattern: 'verifyWorktree', why: '缺少 HEAD 校验 verifyWorktree' },
      { kind: 'grep', file: QA, pattern: 'wtcreate', why: 'wtcreate 场景不存在' },
      // A1/A2/A4 是「不碰用户改动」的三条硬断言
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A4：主目录 status 逐字符一致', why: '缺 A4 的 status 逐字符断言' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A4：stash list 仍为空', why: '缺「没靠 stash」断言' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A7：新 worktree 的 baseSha 等于主检出的 HEAD', why: '缺 A7（n 层树）断言' }
    ]
  },
  {
    id: 'T0.6',
    stage: 'P0',
    name: 'scope.ts — projectMemoryRootOf + Brief',
    criteria: [
      { kind: 'file', file: `${WT}/scope.ts`, why: 'scope.ts 不存在' },
      { kind: 'grep', file: `${WT}/scope.ts`, pattern: 'projectMemoryRootOf', why: '缺少 projectMemoryRootOf' }
    ]
  },
  {
    id: 'T0.7',
    stage: 'P0',
    name: '启动清扫（§2.4）',
    criteria: [
      { kind: 'file', file: `${WT}/sweep.ts`, why: 'sweep.ts 不存在（spec 里叫 recover.ts，实现用了 sweep.ts）' },
      { kind: 'grep', file: 'apps/desktop/src/main/index.ts', pattern: 'sweep', why: '启动清扫未接进 main/index.ts' },
      { kind: 'grep', file: QA, pattern: 'wtsweep', why: 'wtsweep 场景不存在' }
    ]
  },
  {
    id: 'T0.8',
    stage: 'P0',
    name: 'worktree:create + precheck IPC',
    criteria: [
      { kind: 'file', file: `${WT}/ipc.ts`, why: 'ipc.ts 不存在' },
      { kind: 'grep', file: `${WT}/ipc.ts`, pattern: 'worktree:', why: 'ipc.ts 里没有 worktree: 通道' },
      { kind: 'grep', file: 'apps/desktop/src/shared/worktree-protocol.ts', pattern: 'WorktreePrecheckReq', why: '协议里缺 WorktreePrecheckReq' },
      { kind: 'grep', file: QA, pattern: 'wtprecheck', why: 'wtprecheck 场景不存在' }
    ]
  },
  {
    id: 'T0.9',
    stage: 'P0',
    name: '会话绑定 + startFresh 的 persist 参数',
    criteria: [
      {
        kind: 'grep',
        file: 'apps/desktop/src/renderer/src/store/chat.tsx',
        pattern: 'persist',
        why: 'startFresh 未加 persist 参数（A13/A14 依赖它，会话无法落到新工作区）'
      },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A13：', why: '缺 A13 断言（focusRoot 与终端 cwd 同源）' }
    ]
  },
  {
    id: 'T0.10',
    stage: 'P0',
    name: 'A29/A30 回归守卫（只审查不改码）',
    criteria: [
      // 判据是「不许再出现」：为刷新列表调 invalidateIndex 会让在跑的对话静默丢盘
      { kind: 'absent', file: 'apps/desktop/src/main/services/worktree', pattern: 'invalidateIndex', why: 'worktree 代码里出现 invalidateIndex：会让在跑的对话静默丢盘（A29/A30）' }
    ]
  },

  // ─────────── P1 · 可用 ───────────
  {
    id: 'T1.1',
    stage: 'P1',
    name: '新建会话 UI（位置单选 / 起点选择器 / dirty 只警示）',
    criteria: [
      // spec §8 的 T1.1 写的是「`QuickStart.tsx`（**或**新建 `NewSessionDialog.tsx`）」——
      // 两种落点都合法。判据原先把文件写死成 QuickStart.tsx，等于把 spec 的二选一砍成一选一，
      // 会把「按 spec 允许的另一条路做完」误报成没做。这里两个文件**任一**命中即通过。
      {
        kind: 'grepAny',
        files: [
          'apps/desktop/src/renderer/src/redesign/QuickStart.tsx',
          'apps/desktop/src/renderer/src/redesign/NewSessionDialog.tsx'
        ],
        pattern: 'locationTouched',
        why: 'QuickStart.tsx 与 NewSessionDialog.tsx 里都没有 locationTouched 联动'
      },
      // A47 = 分支名为中文/含空格 → slug 回落 worktree；路径框可编辑，用户改写为合法值后创建成功。
      //
      // 判据只认 `test-main.ts` 里**断言调用**的形态（`A47.*eq(`），不认裸 `A47`：
      // 裸字串会让「在文件头写一句 `## A47：…` 注释」也算通过，而注释不是断言 —— 那是把门禁改成
      // 「写个字就能过」。渲染层那半边（路径可编辑）靠上面 T1.1 的 `locationTouched` 判据兜。
      {
        kind: 'grep',
        file: '.deva/qa/test-main.ts',
        pattern: 'eq\\(.*A47',
        regex: true,
        why: '缺 A47 真断言（中文/空格分支名 → slug 回落 worktree），只写注释不算'
      }
    ]
  },
  {
    id: 'T1.2',
    stage: 'P1',
    name: 'worktree 快照 store + state 计算',
    criteria: [
      { kind: 'file', file: `${WT}/list.ts`, why: 'list.ts 不存在（worktree:list 快照与 state 计算）' },
      { kind: 'file', file: 'apps/desktop/src/renderer/src/store/worktree.tsx', why: '渲染层 worktree store 不存在' }
    ]
  },
  {
    id: 'T1.3',
    stage: 'P1',
    name: '依赖安装（异步、可降级、deps 状态机）',
    criteria: [
      { kind: 'file', file: `${WT}/deps.ts`, why: 'deps.ts 不存在' },
      { kind: 'grep', file: `${WT}/ipc.ts`, pattern: 'install-deps', why: 'ipc 里没有 install-deps 通道' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A27', why: '缺 A27 断言（依赖装好之前不许当可用）' }
    ]
  },
  {
    id: 'T1.4',
    stage: 'P1',
    name: 'worktree 列表页（设置 › 工作区）',
    criteria: [
      { kind: 'file', file: 'apps/desktop/src/renderer/src/redesign/WorktreePane.tsx', why: 'WorktreePane.tsx 不存在' }
    ]
  },
  {
    id: 'T1.4b',
    stage: 'P1',
    name: 'sizeBytes 异步统计',
    criteria: [
      { kind: 'grep', file: `${WT}/list.ts`, pattern: 'sizeBytes', why: 'list.ts 里没有 sizeBytes' }
    ]
  },
  {
    id: 'T1.5',
    stage: 'P1',
    name: '边界告知 A36（五项齐全）',
    criteria: [
      { kind: 'file', file: `${WT}/brief.ts`, why: 'brief.ts 不存在' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A36-5', why: 'A36 未覆盖到第 5 项（记忆共享行）' }
    ]
  },
  {
    id: 'T1.6',
    stage: 'P1',
    name: 'P1 记忆共享 G5（M1~M15）',
    criteria: [
      { kind: 'grep', file: 'apps/desktop/src/main/services/tools.ts', pattern: 'memoryScopeRoot', why: 'tools.ts 未接 memoryScopeRoot' },
      // listing.ts 的参数刻意叫 memoryRoot（注释：原名 root 会让人顺手传 workspaceRoot），
      // 真正的接线点在 agent-loop 传 ctx.memoryScopeRoot 进去
      { kind: 'grep', file: 'apps/desktop/src/main/services/agent-loop.ts', pattern: 'memoryScopeRoot', why: 'agent-loop.ts 未把 ctx.memoryScopeRoot 传给记忆清单' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A35', why: '缺 A35 断言（worktree 写入 → 主仓库立即可读）' }
    ]
  },
  {
    id: 'T1.7',
    stage: 'P1',
    name: '显示标签（分支名而非目录名）',
    criteria: [
      { kind: 'file', file: 'apps/desktop/src/renderer/src/redesign/worktree-label.ts', why: 'worktree-label.ts 不存在' }
    ]
  },

  // ─────────── P2 · 合回去 ───────────
  {
    id: 'T2.1',
    stage: 'P2',
    name: 'worktree:merge + dryrun + 四项检查 + 冻结 SHA',
    criteria: [
      { kind: 'file', file: `${WT}/merge.ts`, why: 'merge.ts 不存在（合并流程整块没开工）' },
      { kind: 'grep', file: `${WT}/merge.ts`, pattern: '--no-ff', why: '合并没有 --no-ff' },
      { kind: 'absent', file: `${WT}/merge.ts`, pattern: '--autostash', why: '出现 --autostash：实测 exit 0 但工作区 UU、MERGE_HEAD 空（§4.9 禁用）' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A37', why: '缺 A37 断言' }
    ]
  },
  {
    id: 'T2.1b',
    stage: 'P2',
    name: '显式 stash 流程（push -u → merge → pop）',
    criteria: [
      { kind: 'grep', file: `${WT}/merge.ts`, pattern: 'stash', why: 'merge.ts 里没有 stash 流程' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A94', why: '缺 A94 断言' }
    ]
  },
  {
    id: 'T2.1c',
    stage: 'P2',
    name: 'stderr 稳健解析',
    criteria: [{ kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A97', why: '缺 A97 断言' }]
  },
  {
    id: 'T2.2',
    stage: 'P2',
    name: '失败出口四件套 + 成功面板',
    criteria: [{ kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A42', why: '缺 A42 断言（四个出口都要可用）' }]
  },
  {
    id: 'T2.3',
    stage: 'P2',
    name: 'upToDate 与窗口报告',
    criteria: [{ kind: 'grep', file: `${WT}/merge.ts`, pattern: 'upToDate', why: 'merge.ts 里没有 upToDate' }]
  },

  // ─────────── P3 · 收尾 ───────────
  {
    id: 'T3.1',
    stage: 'P3',
    name: '删除 worktree（三态分派 + dirty 拒绝）',
    criteria: [
      { kind: 'file', file: `${WT}/remove.ts`, why: 'remove.ts 不存在' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A53', why: '缺 A53 断言' }
    ]
  },
  {
    id: 'T3.2',
    stage: 'P3',
    name: '单独删分支（未合并提交数提示）',
    criteria: [{ kind: 'grep', file: `${WT}/remove.ts`, pattern: 'branch', why: 'remove.ts 未处理分支' }]
  },
  {
    id: 'T3.3',
    stage: 'P3',
    name: 'worktree:rebuild',
    criteria: [
      { kind: 'file', file: `${WT}/rebuild.ts`, why: 'rebuild.ts 不存在' },
      { kind: 'grep', file: QA, within: 'scenarioWorktree', pattern: 'A34', why: '缺 A34 断言' }
    ]
  }
]

const STAGES = ['P0', 'P1', 'P2', 'P3']
/** 进入下一阶段的前置：上一阶段必须全绿。spec §8：「P0 全绿才允许进入 P1」 */
const GATE = { P1: 'P0', P2: 'P1', P3: 'P2' }

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function readFileSafe(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** 目录下所有文件的内容拼起来（用于 absent 判据扫一整个目录）。 */
function readTree(rel) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return null
  const stat = fs.statSync(abs)
  if (stat.isFile()) return readFileSafe(rel)
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(p)
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        try {
          out.push(fs.readFileSync(p, 'utf8'))
        } catch {
          /* 读不出就跳过：这里只用于 absent，跳过会让判据偏松 → 记一条说明 */
          out.push(`__UNREADABLE__:${p}`)
        }
      }
    }
  }
  walk(abs)
  return out.join('\n')
}

/**
 * 判据的匹配：`c.regex` 为真时按正则，否则按字面量 `includes`。
 *
 * 为什么需要正则：字面量匹配无法区分「断言」与「注释」。例如 A47 的断言在
 * `eq(\`…（A47）\`, …)` 里，但如果只在文件头写一句 `## A47：…` 注释也会被字面量命中——
 * 那就成了「写个字就能过门禁」。给定 `regex: true` 后可以把 pattern 收成 `eq\(.*A47` 这类
 * 「必须是断言调用」的形态。
 */
function matches(c, content) {
  if (!c.regex) return content.includes(c.pattern)
  try {
    return new RegExp(c.pattern).test(content)
  } catch {
    // pattern 写错当不命中处理：不能因为判据本身有 typo 就静默放行
    return false
  }
}

function checkCriterion(c) {
  if (c.kind === 'file') {
    return { ok: exists(c.file), detail: exists(c.file) ? '' : c.why }
  }
  // `grepAny`：多个候选文件，**任一**命中即算满足。
  //
  // 为什么需要：有些任务的实现落点 spec 明确给了「A 或 B」（如 T1.1 的 `QuickStart.tsx` 或
  // `NewSessionDialog.tsx`）。判据若写死单个文件，会把「按 spec 另一条路做完」误报成没做——
  // 那是假红，和假绿一样让门禁失去意义。
  if (c.kind === 'grepAny') {
    const misses = []
    for (const f of c.files) {
      const raw = readFileSafe(f)
      if (raw === null) {
        misses.push(`${f}（读不到）`)
        continue
      }
      if (matches(c, raw)) return { ok: true, detail: '' }
      misses.push(f)
    }
    return { ok: false, detail: `${c.why}｜查过：${misses.join('、')}` }
  }
  const raw = c.kind === 'absent' ? readTree(c.file) : readFileSafe(c.file)
  if (raw === null) {
    return { ok: false, detail: `读不到 ${c.file}（不是「没有违规」，是没法判断）` }
  }
  // `within`：只在名字以该前缀开头的场景函数体里找。
  //
  // 为什么必须有：断言编号是**每个功能各自从 A1 数起**的。worktree 的 A42（合并冲突后四个出口可用）
  // 与模型切换的 A42（密钥库损坏时不能集体判缺密钥）编到了同一个号，而两者都在 `test-main.ts` 里。
  // 只按 `A42` 找会命中别人的断言，于是「没做」被报成「做好了」——这是假绿，比假红危险得多。
  const content = c.within ? scopeToScenario(raw, c.within) : raw
  if (content === null) {
    return { ok: false, detail: `找不到以 ${c.within} 开头的场景函数（断言无处可写）` }
  }
  const hit = matches(c, content)
  if (c.kind === 'grep') return { ok: hit, detail: hit ? '' : c.why }
  // absent：命中即为问题
  return { ok: !hit, detail: hit ? c.why : '' }
}

/**
 * 取出名字以 `prefix` 开头的场景函数体，拼成一段。
 *
 * 找不到任何匹配函数时返回 null —— 调用方据此报「断言无处可写」，
 * 而不是把「函数不存在」当成「断言不存在」蒙混过去（那会让判据永远为假，红了也不知道为什么）。
 */
function scopeToScenario(text, prefix) {
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) {
    if (!m[1].startsWith(prefix)) continue
    // 从函数头到下一个 function 声明之间即函数体（不追求精确配对，够用且不会跨到别的场景）
    const start = m.index
    const next = text.slice(re.lastIndex).search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/)
    const end = next === -1 ? text.length : re.lastIndex + next
    blocks.push(text.slice(start, end))
  }
  return blocks.length ? blocks.join('\n') : null
}

function checkTask(t) {
  const results = t.criteria.map((c) => ({ c, r: checkCriterion(c) }))
  const failed = results.filter((x) => !x.r.ok)
  return { task: t, ok: failed.length === 0, failed }
}

// ── 执行 ──
const stageArg = process.argv.find((a) => a.startsWith('--stage='))
const onlyStage = stageArg ? stageArg.split('=')[1] : null
const json = process.argv.includes('--json')

const results = TASKS.map(checkTask)
const byStage = {}
for (const s of STAGES) byStage[s] = results.filter((r) => r.task.stage === s)

const stageOk = {}
for (const s of STAGES) stageOk[s] = byStage[s].length > 0 && byStage[s].every((r) => r.ok)

if (json) {
  console.log(
    JSON.stringify(
      {
        stages: Object.fromEntries(
          STAGES.map((s) => [
            s,
            {
              ok: stageOk[s],
              done: byStage[s].filter((r) => r.ok).length,
              total: byStage[s].length,
              tasks: byStage[s].map((r) => ({
                id: r.task.id,
                name: r.task.name,
                ok: r.ok,
                gaps: r.failed.map((x) => x.r.detail)
              }))
            }
          ])
        )
      },
      null,
      2
    )
  )
  process.exit(0)
}

console.log('═══════ 并行功能实施门槛 ═══════')
console.log('判据来源：spec §8 的任务表（文件存在 / grep 命中 / 不许再出现）\n')

for (const s of STAGES) {
  if (onlyStage && s !== onlyStage) continue
  const list = byStage[s]
  const done = list.filter((r) => r.ok).length
  const gate = GATE[s]
  const blocked = gate && !stageOk[gate]
  const head = blocked
    ? `${s}  —  🔒 被 ${gate} 阻塞（${gate} 还有 ${byStage[gate].filter((r) => !r.ok).length} 项没过）`
    : `${s}  —  ${done}/${list.length}`
  console.log(head)

  for (const r of list) {
    if (r.ok) {
      console.log(`  ✅ ${r.task.id.padEnd(7)} ${r.task.name}`)
    } else {
      console.log(`  ❌ ${r.task.id.padEnd(7)} ${r.task.name}`)
      for (const x of r.failed) console.log(`       ↳ [${x.c.kind}] ${x.r.detail}`)
    }
  }
  console.log('')
}

// ── 门槛结论 ──
//
// ## 这里只拦「跳级」，「没做完」不算失败
//
// 一开始我把「任一阶段没全绿」判成 exit 1，这是错的：开发期间 P1 天然是半成品，
// 于是 CI 天天红——**红着的门禁等于没有门禁**，正是这个脚本要解决的那个问题本身。
//
// 真正该拦的是**跳级**：前一个阶段还没全绿，后一个阶段却已经有产物了。
// 那才是「不按顺序走」的客观证据，而且是代码状态的函数，不依赖谁记不记得。
const firstBad = STAGES.find((s) => !stageOk[s])

/**
 * 某阶段是否已经有产物，用于判断「有没有偷偷开工」。
 *
 * 这里**不要求整个任务通过**，只要**任意一条判据命中**就算开过工。
 * 一开始我用 `r.ok`（整个任务全绿），结果造一个只有空壳的 `merge.ts` 时检测不到——
 * 而「空壳 merge.ts 已经躺在仓库里」恰恰就是跳级的证据。判据要能抓住**半成品**，
 * 不能只在「做完了」时才说话，那样它就只能事后追认，拦不住人。
 */
function started(s) {
  return byStage[s].some((r) => r.task.criteria.some((c) => checkCriterion(c).ok))
}

console.log('═══════ 结论 ═══════')
for (const s of STAGES) {
  const list = byStage[s]
  const done = list.filter((r) => r.ok).length
  console.log(`  ${stageOk[s] ? '✅' : '❌'} ${s}: ${done}/${list.length}`)
}

/** 跳级：前序阶段未全绿，但本阶段已有产物。 */
const jumps = []
for (const s of STAGES) {
  const gate = GATE[s]
  if (gate && !stageOk[gate] && started(s)) {
    // 报「已开工的任务数」而不是「已全绿的任务数」：跳级时的常态是半成品，
    // 用全绿计数会打出「已有 0 项产物」这种自相矛盾的文案。
    const touched = byStage[s].filter((r) => r.task.criteria.some((c) => checkCriterion(c).ok)).length
    jumps.push({ later: s, gate, touched })
  }
}

if (jumps.length > 0) {
  console.log('\n❌ 跳级：')
  for (const j of jumps) {
    console.log(
      `  ${j.later} 已有 ${j.touched} 项开工，但 ${j.gate} 还没全绿 —— 按 spec §8「${j.gate} 全绿才允许进入 ${j.later}」`
    )
  }
  console.log('\n这不是「进度慢」，是顺序错了：失败清理、锁、路径归一化这些地基没验完就开始往上盖，')
  console.log(`出问题时无法判断是上层写错还是地基漏了。先补 ${jumps[0].gate}，再继续。`)
  process.exit(1)
}

if (!firstBad) {
  console.log('\n全部阶段通过。')
  process.exit(0)
}

const bad = byStage[firstBad].filter((r) => !r.ok)
console.log(`\n当前在 ${firstBad}：还有 ${bad.length} 项未完成（这是正常进度，不是错误）。`)
console.log(`约束：${firstBad} 全绿之前不许开工 ${Object.keys(GATE).find((k) => GATE[k] === firstBad) || '后续阶段'}。`)
console.log('\n边界：本脚本只查「产物在不在、断言有没有」。以下查不到：')
console.log('  · 断言是否真的有效（可能写了 A35 但恒真）→ break-*.cjs 与独立验收')
console.log('  · 实现是否符合 spec 的算法细节（如失败清理六步顺序）→ 代码审查')
console.log('  · 界面是否好用 → 要人看')
process.exit(0)
