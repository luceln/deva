/**
 * 专查「ctr is not a constructor」：包里到底写了什么。
 *
 * 复现路径：连续导出（模拟第二次导出），抓着失败那次的包不放，然后用
 *   1. 中央目录（自己的 seek 实现，不依赖 fflate）
 *   2. 清点每个条目的 method / 实际写入字节 / 声明字节
 *   3. 与「home 里应导文件数」对比，看是少写了条目还是条目本身坏了
 *
 * 关键点：导出侧 writeZip 的完成语义是 `out.on('finish')`。若 rename 前
 * 写入流还没 flush 完，包就会尾部残缺 —— 那种包中央目录可能还在、条目数据却不全，
 * 解压时报出各种怪错误（包括 ctr is not a constructor）。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-ctr')

function readCD(zipPath) {
  const fd = fs.openSync(zipPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tailLen = Math.min(22 + 0xffff, size)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return { error: 'no EOCD', size }
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    const commentLen = tail.readUInt16LE(eocd + 20)
    // EOCD 之后是否还有多余字节 = 尾部是否写完整
    const trailing = tailLen - (eocd + 22 + commentLen)
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    const out = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const csize = cd.readUInt32LE(p + 20)
      const usize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const cmtLen = cd.readUInt16LE(p + 32)
      const lho = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      out.push({ name, method, csize, usize, lho })
      p += 46 + nameLen + extraLen + cmtLen
    }
    return { size, declaredCount: count, parsedCount: out.length, trailingBytesAfterEOCD: trailing, entries: out }
  } finally {
    fs.closeSync(fd)
  }
}

/** 逐个条目 seek 到本地头，核对「声明压缩大小」是否真的在文件里 */
function checkLocal(zipPath, cd) {
  const fd = fs.openSync(zipPath, 'r')
  const size = fs.fstatSync(fd).size
  const bad = []
  try {
    for (const e of cd.entries) {
      const lh = Buffer.alloc(30)
      const got = fs.readSync(fd, lh, 0, 30, e.lho)
      if (got !== 30) {
        bad.push({ name: e.name, why: 'local header truncated' })
        continue
      }
      if (lh.readUInt32LE(0) !== 0x04034b50) {
        bad.push({ name: e.name, why: 'bad local sig' })
        continue
      }
      const lm = lh.readUInt16LE(8)
      const nl = lh.readUInt16LE(26)
      const el = lh.readUInt16LE(28)
      const dataStart = e.lho + 30 + nl + el
      const dataEnd = dataStart + e.csize
      if (dataEnd > size) {
        bad.push({ name: e.name, why: `data beyond EOF (need ${dataEnd}, file ${size})`, localMethod: lm, cdMethod: e.method })
      } else if (lm !== e.method) {
        bad.push({ name: e.name, why: `method mismatch local=${lm} cd=${e.method}` })
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return bad
}

async function main() {
  const n = Number(process.argv[2] || 6)
  const root = path.join(os.tmpdir(), `deva-ctr-${Date.now()}`)
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'data/media'), { recursive: true })
  fs.mkdirSync(path.join(home, 'data/checkpoints/s-1'), { recursive: true })
  fs.mkdirSync(path.join(home, 'data/chats'), { recursive: true })
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(home, 'data/media', `img-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024))
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(home, 'data/checkpoints/s-1', `cp-${i}.json`), JSON.stringify({ i, pad: 'x'.repeat(20000) }))
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(home, 'data/chats', `s-${i}.json`), JSON.stringify({ id: `s-${i}` }))
  fs.writeFileSync(path.join(home, 'config.json'), '{"theme":"dark"}')
  fs.writeFileSync(path.join(home, 'memory.json'), '{"version":2}')

  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(entry, `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}\n`)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'e.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })

  const script = path.join(root, 'w.cjs')
  fs.writeFileSync(
    script,
    `
process.env.DEVA_HOME = ${JSON.stringify(home)}
const { exportBundle } = require(${JSON.stringify(path.join(DIST, 'e.cjs'))})
const out = (o) => process.stdout.write('J:' + JSON.stringify(o) + '\\n')
;(async () => {
  for (let k = 0; k < ${n}; k++) {
    const p = ${JSON.stringify(path.join(root, 'out'))} + '-' + k + '.dbk'
    const r = await exportBundle({ targetPath: p })
    out({ k, ok: r.ok, files: r.files, bytes: r.bytes, code: r.code, msg: r.message, path: r.path })
  }
})()
`
  )
  const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results = (res.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('J:'))
    .map((l) => JSON.parse(l.slice(2)))

  const homeFiles = 40 + 600 + 30 + 2
  console.log(`home 应导文件数（media40 + cp600 + chats30 + 2）: ${homeFiles}`)
  let badCount = 0
  for (const r of results) {
    if (!r.ok) {
      console.log(`  [k=${r.k}] 导出报失败 :: ${r.code} ${r.msg}`)
      badCount++
      continue
    }
    const cd = readCD(r.path)
    if (cd.error) {
      console.log(`  [k=${r.k}] 包损坏 :: ${cd.error}`)
      badCount++
      continue
    }
    const bad = checkLocal(r.path, cd)
    const fileEntries = cd.entries.filter((e) => e.name.startsWith('home/'))
    const methods = {}
    for (const e of cd.entries) methods[e.method] = (methods[e.method] || 0) + 1
    const ok = fileEntries.length === homeFiles && bad.length === 0 && cd.parsedCount === cd.declaredCount
    console.log(
      `  [k=${r.k}] ${ok ? 'OK' : 'BAD'} :: 报告 files=${r.files} 包内 home 条目=${fileEntries.length} 声明=${cd.declaredCount} 实测解析=${cd.parsedCount} 尾部多余=${cd.trailingBytesAfterEOCD} methods=${JSON.stringify(methods)} 异常条目=${bad.length}`
    )
    if (bad.length) {
      console.log(`     异常明细（前 5）：${JSON.stringify(bad.slice(0, 5))}`)
      badCount++
    }
    if (fileEntries.length !== homeFiles) {
      const missing = []
      const set = new Set(fileEntries.map((e) => e.name))
      for (let i = 0; i < 40; i++) if (!set.has(`home/data/media/img-${i}.bin`)) missing.push(`media/img-${i}`)
      for (let i = 0; i < 600; i++) if (!set.has(`home/data/checkpoints/s-1/cp-${i}.json`)) missing.push(`cp-${i}`)
      console.log(`     缺失（前 10）：${JSON.stringify(missing.slice(0, 10))} 共 ${missing.length}`)
      badCount++
    }
  }
  console.log(`\n==CTR_RESULT== ${results.length} 次导出，异常 ${badCount} 次`)
  // 保留产物供人工检查
  console.log(`产物目录（未删除，供检查）：${root}`)
  process.exit(badCount === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
