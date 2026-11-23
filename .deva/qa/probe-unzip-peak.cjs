/**
 * 实测 unzipSync 的内存峰值（RSS / heap / external 分开看）。
 *
 * 为什么单独写：restoreBundle 内部是同步 unzipSync，一次 tick 内完成，setInterval 采不到峰值。
 * 这里复现它的内存形态：readFile → unzipSync → 一直持有 entries（与 bundle-import.ts:207-214 一致）。
 *
 * 用法：
 *   node probe-unzip-peak.cjs <包路径>            # 完整 readFile + unzipSync
 *   node probe-unzip-peak.cjs <包路径> read-only  # 只 readFile，作对照基线
 */
const fs = require('fs')
const path = require('path')

const bundle = process.argv[2]
const mode = process.argv[3] || 'unzip'
const mb = (n) => Math.round(n / 1048576)
const bundleMB = mb(fs.statSync(bundle).size)

if (mode === 'read-only') {
  const before = process.memoryUsage()
  const buf = fs.readFileSync(bundle)
  const after = process.memoryUsage()
  console.log(
    JSON.stringify({
      mode,
      bundleMB,
      rssMB: mb(after.rss),
      rssDeltaMB: mb(after.rss - before.rss),
      heapMB: mb(after.heapUsed),
      externalMB: mb(after.external),
      bufMB: mb(buf.length)
    })
  )
  process.exit(0)
}

const fflatePath = require.resolve('fflate', { paths: [path.resolve(__dirname, '../..')] })
const { unzipSync } = require(fflatePath)

const before = process.memoryUsage()
const buf = fs.readFileSync(bundle)
const afterRead = process.memoryUsage()
const entries = unzipSync(new Uint8Array(buf))
// 解压完立即取一次（restoreBundle 在这一刻的内存形态就是如此：zipBuf + entries 同时在堆上）
const afterUnzip = process.memoryUsage()
let entryBytes = 0
let entryCount = 0
for (const v of Object.values(entries)) {
  entryBytes += v.length
  entryCount += 1
}
console.log(
  JSON.stringify({
    mode: 'unzip',
    bundleMB,
    entryCount,
    entryTotalMB: mb(entryBytes),
    rssBeforeMB: mb(before.rss),
    rssAfterReadMB: mb(afterRead.rss),
    rssMB: mb(afterUnzip.rss),
    heapMB: mb(afterUnzip.heapUsed),
    externalMB: mb(afterUnzip.external),
    arrayBuffersMB: mb(afterUnzip.arrayBuffers)
  })
)
process.exit(0)
