#!/usr/bin/env node
/*
 * 判据：AGENTS.md「能力 → 唯一实现」一节里提到的每个文件路径必须真实存在。
 *
 * 为什么需要：AGENTS.md 会随代码演进变陈旧（文件改名、符号删除、模块拆分）。陈旧的表比没有表
 * 更糟——它指着一个不存在的地方，让人白找几分钟，还会让人以为「按规范做了」。
 *
 * 解析范围：只认 `### 能力 → 唯一实现` 之后、同属该 `###` 节的内容（含表后两条按钮/表单行），
 * 到下一个同级或更高级标题为止。不做全文扫描，避免把示例 / 历史说明里的路径也算进来。
 *
 * 路径基准：那一节声明「相对 apps/desktop/src/」，但按钮行用的是 renderer 内的 `styles/app.css`。
 * 所以按候选基准依次尝试，任一命中即通过：
 *   apps/desktop/src/ → apps/desktop/src/renderer/src/ → 仓库根
 *
 * 用法：node .deva/qa/check-agents-table.cjs [--file <path>]
 * 退出码：0 全部存在 / 1 有缺失或解析不出路径
 */
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

// Windows 控制台默认 GBK，中文直接输出会乱码。
try {
  process.stdout.reconfigure?.('utf8')
} catch {
  /* 非 TTY 或旧版 node：忽略 */
}

const ROOT = resolve(__dirname, '../..')
const SECTION_TITLE = '能力 → 唯一实现'
const BASES = ['apps/desktop/src', 'apps/desktop/src/renderer/src', '.']

/** 从 AGENTS.md 里切出目标小节。找不到小节直接判红——整节被删说明判据失去对象。 */
function extractSection(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim().startsWith('###') && l.includes(SECTION_TITLE))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    // 下一个 ## 或 ### 标题即本节结束
    if (/^#{2,3}\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/*
 * 抓引号里的路径 token。
 *
 * 判定规则（必须显式，不能「认不出就悄悄跳过」）：
 *   含 `/` 且不以 `.` 开头 → 文件/目录路径，纳入检查
 *   以 `.` 开头            → CSS 类名 / 选择器，跳过并打印
 *   不含 `/` 且含 `.`      → 裸文件名（如 `AGENTS.md`），跳过并打印
 *   其余                   → 纯符号名（函数、常量），跳过并打印
 *
 * ⚠️ 早先版本用 `[A-Za-z0-9_]` 打头做匹配，反向验证灌进 `/nonexistent/x.ts` 时被直接跳过，
 * 判据照样 GREEN —— 假绿比没判据更糟。现在凡是含 `/` 的一律必须检查，跳过项一并打印，
 * 免得「没检查到」被误读成「检查通过」。
 */
function extractPaths(section) {
  const found = new Map()
  const skipped = new Map()
  const re = /`([^`\n]+)`/g
  for (const m of section.matchAll(re)) {
    const raw = m[1].trim()
    if (!raw) continue
    if (/^\./.test(raw) || /\(\)\s*$/.test(raw) || !raw.includes('/') && !raw.includes('.')) {
      // CSS 类名 / 函数调用 / 纯符号名
      if (/^\./.test(raw)) skipped.set(raw, 'CSS 类名或选择器')
      else if (/\(\)\s*$/.test(raw) || !raw.includes('/') && !raw.includes('.')) skipped.set(raw, '符号名，非路径')
      continue
    }
    if (!raw.includes('/')) {
      skipped.set(raw, '裸文件名，无目录基准')
      continue
    }
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    found.set(p, (found.get(p) ?? 0) + 1)
  }
  return { found, skipped }
}

function locate(rel) {
  for (const base of BASES) {
    const abs = join(ROOT, base, rel)
    if (existsSync(abs)) return { abs, base }
  }
  return null
}

function main() {
  const argIdx = process.argv.indexOf('--file')
  const file = argIdx !== -1 && process.argv[argIdx + 1]
    ? resolve(process.argv[argIdx + 1])
    : join(ROOT, 'AGENTS.md')

  if (!existsSync(file)) {
    console.error(`RED  找不到 AGENTS.md：${file}`)
    process.exit(1)
  }

  const section = extractSection(readFileSync(file, 'utf8'))
  if (section === null) {
    console.error(`RED  没找到「### ${SECTION_TITLE}」小节——判据失去对象，请同步更新脚本或恢复小节`)
    process.exit(1)
  }

  const { found: paths, skipped } = extractPaths(section)
  if (paths.size === 0) {
    console.error('RED  小节里没解析出任何文件路径——判据没生效，不等于通过')
    process.exit(1)
  }

  const bad = []
  for (const [rel, count] of [...paths].sort((a, b) => a[0].localeCompare(b[0]))) {
    // 绝对路径必然落在基准之外，直接判红（不因「找不到基准」而含糊）。
    if (rel.startsWith('/')) {
      console.log(`RED  ${rel}  (引用 ${count} 次，绝对路径不在任何基准下)`)
      bad.push(rel)
      continue
    }
    const hit = locate(rel)
    if (hit) {
      console.log(`OK   ${rel}  (引用 ${count} 次，基准 ${hit.base})`)
    } else {
      console.log(`RED  ${rel}  (引用 ${count} 次，三处基准都没找到)`)
      bad.push(rel)
    }
  }

  if (skipped.size) {
    console.log('\n跳过（非文件路径，不参与存在性检查）：')
    for (const [token, why] of [...skipped].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`SKIP ${token}  — ${why}`)
    }
  }

  console.log(`\n共 ${paths.size} 条路径，${paths.size - bad.length} 存在，${bad.length} 缺失`)
  if (bad.length) {
    console.error(`\nRED  以下路径在仓库中不存在，AGENTS.md 该条目已陈旧：`)
    for (const p of bad) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('GREEN 表中所有路径均真实存在')
}

main()