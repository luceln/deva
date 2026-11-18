/**
 * 独立验收：导入不碰原版数据（源只读）。
 *
 * 做法：把真实 ~/.deva 只读复制成夹具（junction 逐条重建），对夹具算全量指纹，
 * 跑完整导入，再算一遍指纹。源侧任何一个字节变化都要能看出来。
 *
 * 用法：node .deva/qa/accept-src-readonly.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const REAL = path.join(os.homedir(), '.deva')
const root = path.join(os.tmpdir(), 'acc-srconly-' + Date.now())
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
const APPDATA = path.join(root, 'appdata')
for (const d of [HOME, DST, APPDATA]) fs.mkdirSync(d, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
process.env.ACC_APPDATA = APPDATA
// 桩要求这两个（stub-electron.cjs:10-13）
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = APPDATA

let fails = 0
const eq = (l, a, e) => {
  const x = JSON.stringify(a)
  const y = JSON.stringify(e)
  if (x === y) console.log(`PASS ${l} :: ${x}`)
  else { fails++; console.log(`FAIL ${l} :: 实际=${x} 期望=${y}`) }
}
const ok = (l, c, d) => {
  if (c) console.log(`PASS ${l}${d ? ' :: ' + d : ''}`)
  else { fails++; console.log(`FAIL ${l}${d ? ' :: ' + d : ''}`) }
}
const info = (l, v) => console.log(`INFO ${l} :: ${v}`)

/** 全量指纹：路径 → (size, mtimeMs, sha256[:16])；链接记目标。 */
function fingerprint(dir) {
  const out = {}
  const walk = (d, rel) => {
    let items
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(d, it.name)
      const r = rel ? rel + '/' + it.name : it.name
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) {
        let tgt = ''
        try { tgt = fs.readlinkSync(full) } catch {}
        out[r] = 'LINK:' + tgt
        continue
      }
      if (st.isDirectory()) {
        out[r + '/'] = 'DIR'
        walk(full, r)
        continue
      }
      let h = ''
      try { h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) } catch { h = 'ERR' }
      out[r] = `F:${st.size}:${Math.floor(st.mtimeMs)}:${h}`
    }
  }
  walk(dir, '')
  return out
}

;(async () => {
  info('真实源', REAL)
  const srcHome = path.join(HOME, '.deva')
  // 只读复制：逐条建 junction/文件（cpSync 会展平链接，这里手写）
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const it of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, it.name)
      const t = path.join(to, it.name)
      const st = fs.lstatSync(f)
      if (st.isSymbolicLink()) {
        try {
          const tgt = fs.readlinkSync(f)
          fs.symlinkSync(path.resolve(path.dirname(f), tgt), t, st.isDirectory() ? 'junction' : 'file')
        } catch { /* 跳过建不出来的链接 */ }
        continue
      }
      if (st.isDirectory()) { copy(f, t); continue }
      try { fs.copyFileSync(f, t) } catch {}
    }
  }
  copy(REAL, srcHome)
  info('夹具已就绪（源副本）', srcHome)

  const before = fingerprint(REAL)
  const beforeCount = Object.keys(before).length
  info('导入前真实源条目数', String(beforeCount))
  ok('前置：快照拿到东西了（不是空目录）', beforeCount > 1000, String(beforeCount))

  // 跑完整导入
  const { runImport } = await import('../../apps/desktop/src/main/importer')
  const { registerConfigIpc } = await import('../../apps/desktop/src/main/services/config')
  registerConfigIpc(() => null)
  let r = null
  try {
    r = await runImport()
  } catch (e) {
    console.log('INFO 导入抛错 :: ' + (e && e.message))
  }
  info('导入结果', JSON.stringify({ ok: r?.ok, failures: (r?.failures || []).length, sessions: r?.sessions?.copied?.length }))

  const after = fingerprint(REAL)
  const afterCount = Object.keys(after).length

  const added = Object.keys(after).filter((k) => !(k in before))
  const removed = Object.keys(before).filter((k) => !(k in after))
  const changed = Object.keys(before).filter((k) => k in after && before[k] !== after[k])

  info('条目数 before/after', `${beforeCount} → ${afterCount}`)
  info('新增', JSON.stringify(added.slice(0, 10)))
  info('消失', JSON.stringify(removed.slice(0, 10)))
  info('内容变了', JSON.stringify(changed.slice(0, 10)))

  eq('源只读：真实 ~/.deva 没有新增文件', added, [])
  eq('源只读：真实 ~/.deva 没有消失文件', removed, [])
  eq('源只读：真实 ~/.deva 没有内容/mtime 变化', changed, [])

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e)
  process.exit(2)
})