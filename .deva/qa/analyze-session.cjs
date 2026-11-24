#!/usr/bin/env node
/**
 * 统计本会话（sess_mwh4e9ts_e6）里开了多少需求、每条从提出到合入花了多少轮、卡在哪。
 *
 * 数据源：主档 JSON（含压缩后的近期）+ compacted 分片（含压缩前的完整早期历史）。
 * 只读，不改任何东西。
 *
 * 判据说明（这是分析，不是测试；但结论必须能追溯到原文）：
 *  - 「需求」= 真用户消息里提出要做的事。用关键词 + 结构判断，不靠直觉。
 *  - 「轮」= 用户消息编号（第 N 次用户发言），比"消息数"更能反映交互成本。
 *  - 「合入」= git 记录里该功能的提交进入 dev/main 的那个提交。
 */
const fs = require('fs')
const path = require('path')

const CHATS = path.join(process.env.HOME || process.env.USERPROFILE, '.deva-plus', 'data', 'chats')
const MAIN = path.join(CHATS, 'sess_mwh4e9ts_e6.json')
const SHARD = path.join(CHATS, 'sess_mwh4e9ts_e6.compacted-mwh7hvbzsg74.jsonl')

/** 从一条消息里取纯文本（content 可能是 string 或 parts 数组）。 */
function textOf(m) {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p && p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 读全部历史：分片在前（早期），主档在后（近期）。 */
function loadAll() {
  const out = []
  if (fs.existsSync(SHARD)) {
    for (const line of fs.readFileSync(SHARD, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line)
        out.push({ ...m, _src: 'shard' })
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  const main = JSON.parse(fs.readFileSync(MAIN, 'utf8'))
  for (const m of main.messages ?? []) out.push({ ...m, _src: 'main' })
  return out
}

const all = loadAll()

/*
 * 挑出「真用户在说话」：
 *  - role === user
 *  - 不是 tool_result（那些是工具回灌，role 也是 user）
 *  - 不是系统注入（⟦deva:*）
 *  - 不是记忆/技能/待办清单这类自动附带（它们都以【...】开头）
 */
function isRealUser(m) {
  if (m.role !== 'user') return false
  if (Array.isArray(m.content) && m.content.every(( p) => p && p.type === 'tool_result')) return false
  const t = textOf(m)
  if (!t) return false
  if (t.startsWith('⟦deva:')) return false
  // 自动附带物：整条以【xxx】开头且很短就一句，通常不是用户提问
  if (/^【(记忆|可用技能|技能清单更新|记忆更新|待办清单提醒|deva:)/.test(t)) return false
  return true
}

const users = all.filter(isRealUser)
console.log(`== 数据源 ==`)
console.log(`分片 ${fs.existsSync(SHARD) ? (fs.statSync(SHARD).size / 1024 / 1024).toFixed(1) + 'MB' : '无'}，主档 ${(fs.statSync(MAIN).size / 1024 / 1024).toFixed(1)}MB`)
console.log(`合并后消息 ${all.length} 条，其中真用户发言 ${users.length} 条\n`)

console.log('== 真用户发言时间线（第 N 轮）==')
users.forEach((m, i) => {
  const t = textOf(m).replace(/\s+/g, ' ').trim()
  console.log(`[${String(i + 1).padStart(3)}] ${t.slice(0, 130)}`)
})
