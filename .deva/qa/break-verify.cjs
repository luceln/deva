#!/usr/bin/env node
/**
 * 破坏验证总入口（章程第 4 步）：「撤掉修复，看对应测试是否真的红」。
 *
 * 做法：把仓库复制到 tmp（**产品代码不动**），在副本里把某条修复改回旧行为，然后拿
 * `.deva/qa/run-accept.cjs` 指向副本跑同一个场景。判据只有一条：
 *
 *   修复在场 → 场景 PASS（基线）
 *   修复撤掉 → 场景必须 FAIL，且失败原因对得上
 *
 * 只做「撤掉」不做「全绿的确认」：基线本来就该绿，绿了不算证据。
 *
 * ## 为什么副本而不是 git stash
 *
 * 工作区里有未提交的改动，`git stash` 会把实现方正在做的东西一起收走。副本隔离更安全，
 * 而且能同时跑多个破坏，不互相干扰。
 *
 * 用法：
 *   node .deva/qa/break-verify.cjs            # 全部破坏项
 *   node .deva/qa/break-verify.cjs sessbroken # 只跑指定的
 *
 * 新增一项破坏 = 往 BREAKS 里加一条：{ id, why, patch(root), scenario, expect }
 *   expect 是这个场景在**撤掉修复后**应当打出来的 FAIL 行片段（用来区分「红了」和「红对了」）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
/** 场景跑手：`repro-accept.cjs` 本来就支持 `QA_SRC` 指定源码树，不必另造一条通路。 */
const RUN = path.join(__dirname, 'repro-accept.cjs')
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

/** 在副本里替换文本；命中不到就抛（防止源码结构变了以后「破坏」悄悄失效）。 */
function sub(file, from, to, label) {
  const s = fs.readFileSync(file, 'utf8')
  if (!s.includes(from)) throw new Error(`${label}：要替换的原文没找到（源码结构变了，请更新本脚本）`)
  fs.writeFileSync(file, s.replace(from, to))
}

const D = (root) => path.join(root, 'apps/desktop/src/main')

const BREAKS = [
  {
    id: 'unread',
    why: '附件/会话：inspectTarget 把「打不开」折回 absent（旧 bug：读不到当没有 → 覆盖能读的文件）',
    scenario: 'unread',
    expect: 'target-unreadable',
    patch(root) {
      // 场景里用的是 Windows 独占打开，openSync 会失败 —— 所以破坏点必须落在 inspectTarget 的
      // openSync catch 分支上；改 targetState 的 readFileSync 分支是打不中的（那条分支走不到）。
      sub(
        path.join(D(root), 'importer-target.ts'),
        "  } catch (e) {\n    // 打不开就不知道里面是什么：宁可不写（写下去可能毁掉一份好文件，见 copyFileSync 非原子）\n    return { kind: 'unreadable', error: (e as Error)?.message ?? String(e) }\n  }\n  return { kind: 'usable', size: st.size }",
        "  } catch {\n    return { kind: 'absent' }\n  }\n  return { kind: 'usable', size: st.size }",
        'unread'
      )
    }
  },
  {
    id: 'assocblk',
    why: '附件：copyAssoc 的 media 分支改回裸 existsSync（旧 bug：目标被占位 → 永久跳过，报告不提）',
    scenario: 'assocblk',
    expect: 'target-blocked',
    patch(root) {
      // 场景第一步走的是 copyAssoc 的 media 循环，所以破坏点要在那段，而不是 mergeDir。
      sub(
        path.join(D(root), 'importer-assoc.ts'),
        "        const probe = inspectTarget(to)\n        if (probe.kind === 'blocked') {\n          failures.push({ step: 'assoc', id: `media:${name}`, reason: 'target-blocked' })",
        "        if (statSync(to, { throwIfNoEntry: false })) {\n          continue\n        }\n        const probe = inspectTarget(to)\n        if (probe.kind === 'blocked') {\n          failures.push({ step: 'assoc', id: `media:${name}`, reason: 'target-blocked' })",
        'assocblk'
      )
    }
  },
  {
    id: 'p0ckpt',
    why: '附件：copyFileFresh 去掉 utimesSync（旧 bug：保留源 mtime → 导入后首次启动被清扫删空）',
    scenario: 'p0ckpt',
    expect: 'p0ckpt',
    patch(root) {
      sub(
        path.join(D(root), 'importer-assoc.ts'),
        '  refreshMtime(to)\n}',
        '  // refreshMtime(to)  <- 故意撤掉\n}',
        'p0ckpt'
      )
    }
  },
  {
    id: 'p0turn',
    why: '会话缓存：收尾改回 invalidateIndex（旧 bug：清 sessionCache → 在跑的那轮对话丢盘）',
    scenario: 'p0turn',
    expect: 'p0turn',
    patch(root) {
      const f = path.join(D(root), 'importer.ts')
      sub(f, 'invalidateIndexOnly()', 'invalidateIndex()', 'p0turn-调用点')
      sub(f, 'import { invalidateIndexOnly } from', 'import { invalidateIndex } from', 'p0turn-import')
    }
  },
  {
    id: 'writefail',
    why: '收尾：补回那次 mergeProviders 的返回值丢掉（旧 bug：内存改了、磁盘没写、报告 ok）',
    scenario: 'writefail',
    expect: 'writefail',
    patch(root) {
      sub(
        path.join(D(root), 'importer.ts'),
        '    const restore = mergeProviders(src, { excludeIds: [...applied.removedIds] })\n    failures.push(...(restore.failed ?? []))',
        '    mergeProviders(src, { excludeIds: [...applied.removedIds] })',
        'writefail'
      )
    }
  }
]

function runScenario(root, scenario) {
  try {
    const out = execFileSync(process.execPath, [RUN, scenario], {
      env: { ...process.env, QA_SRC: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'break-verify-'))
  const dst = path.join(dir, 'repo')
  fs.cpSync(REPO, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REPO, src)
      if (!rel) return true
      const parts = rel.split(path.sep)
      // 任何层级的 node_modules 都不带（顶层与 apps/desktop 下都有一份）；qa 打包产物也不必带
      if (parts.includes('node_modules') || parts[0] === '.git') return false
      return !(parts[0] === '.deva' && parts[1] === 'qa' && parts[2] === 'dist')
    }
  })
  // 场景要 node_modules 才能 esbuild 打包：软链到真实仓库（Windows 无特权时回落 junction）
  for (const nm of ['node_modules', path.join('apps/desktop/node_modules')]) {
    const src = path.join(REPO, nm)
    const target = path.join(dst, nm)
    if (!fs.existsSync(src)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      fs.symlinkSync(src, target, 'junction')
    } catch (e) {
      console.log(`INFO 无法为 ${nm} 建链接（${e.code}），场景打包可能失败`)
    }
  }
  return { dir, dst }
}

let fails = 0
const list = only.length ? BREAKS.filter((b) => only.includes(b.id)) : BREAKS
console.log(`破坏验证：${list.length} 项\n`)

for (const b of list) {
  const { dir, dst } = copyRepo()
  try {
    try {
      b.patch(dst)
    } catch (e) {
      fails++
      console.log(`FAIL ${b.id}：破坏没打上 — ${e.message}`)
      continue
    }
    const r = runScenario(dst, b.scenario)
    const failsLines = r.out.split('\n').filter((l) => l.startsWith('FAIL'))
    const hit = failsLines.filter((l) => l.includes(b.expect))
    if (r.code !== 0 && hit.length) {
      console.log(`PASS ${b.id}：撤掉修复 → 场景 ${b.scenario} 变红且原因对得上`)
      console.log(`     ${hit[0].slice(0, 150)}`)
    } else if (r.code !== 0) {
      fails++
      console.log(`FAIL ${b.id}：场景红了，但失败原因对不上（可能测试写偏了）`)
      console.log(`     期望含「${b.expect}」，实得：${failsLines.slice(0, 3).join(' | ') || '（无 FAIL 行）'}`)
    } else {
      fails++
      console.log(`FAIL ${b.id}：撤掉修复后场景仍然全绿 → 这条修复没有被测试覆盖`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${fails === 0 ? '全部破坏都被对应测试抓住' : `${fails} 项有问题`}（fail=${fails}）`)
process.exit(fails === 0 ? 0 : 1)
