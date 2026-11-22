#!/usr/bin/env node
/**
 * 破坏性验证：把关键保护**故意弄坏**，确认验证脚本真的会失败。
 *
 * 为什么必须做：一个从不失败的验证脚本等于没有验证。这里挑三处最容易"看起来对、实际没生效"的点，
 * 逐条注入缺陷、跑 verify-bundle-real.cjs、确认它报 FAIL，然后还原源码。
 *
 *   D1 去掉 mtime 刷新 → E8 必须失败（否则 checkpoint 会被启动清扫删光）
 *   D2 覆盖前不备份     → E11 必须失败（否则用户没有退路）
 *   D3 去掉 zip slip 校验 → E13 必须失败（否则能往目录外写文件）
 *
 * 每轮结束都用原文回写，并在最后核对文件哈希与开始时一致。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const IMPORT = path.join(REPO, 'apps', 'desktop', 'src', 'main', 'services', 'bundle-import.ts')
const MANIFEST = path.join(REPO, 'apps', 'desktop', 'src', 'main', 'services', 'bundle-manifest.ts')

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const origImport = fs.readFileSync(IMPORT, 'utf8')
const origManifest = fs.readFileSync(MANIFEST, 'utf8')
const hashImport = sha(IMPORT)
const hashManifest = sha(MANIFEST)

function runVerify() {
  try {
    execFileSync(process.execPath, [path.join(QA, 'verify-bundle-real.cjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000
    })
    return { ok: true, out: '' }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function restore() {
  fs.writeFileSync(IMPORT, origImport)
  fs.writeFileSync(MANIFEST, origManifest)
}

let fails = 0
const ok = (n, d) => console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
const bad = (n, d) => {
  fails += 1
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}

function check(name, expectFailTag, out) {
  if (out.ok) {
    bad(name, '注入缺陷后验证仍然全绿 —— 这条保护形同虚设')
    return
  }
  const hit = out.out.includes(expectFailTag)
  if (hit) ok(name, `按预期在 ${expectFailTag} 处失败`)
  else {
    // 失败在别的地方也算"坏了"，但不是我们要的那条，需要人看
    const lines = out.out.split('\n').filter((l) => l.includes('FAIL'))
    bad(name, `失败了但不是 ${expectFailTag}：${lines.slice(0, 3).join(' | ')}`)
  }
}

console.log('基线（未注入）…')
{
  const base = runVerify()
  if (base.ok) ok('基线全绿')
  else bad('基线就不绿，后面的破坏验证无意义', base.out.split('\n').filter((l) => l.includes('FAIL')).join(' | '))
}

/*
 * ── D1 mtime ──
 *
 * 第一版把 `utimes` 改成空操作，结果验证仍然全绿 —— 不是判据失效，而是**当前实现里
 * `utimes` 本来就是冗余的**：文件先 writeFile 到 staging 再 cp 过去，staging 是刚写的新文件，
 * mtime 天然是新的。真实事故（2219 个 checkpoint 被清扫）发生在 `copyFileSync` 直接复制源文件、
 * 保留旧 mtime 的写法上。
 *
 * 所以这里的注入不是"删掉 utimes"，而是**模拟那个会保留旧 mtime 的实现**：把产物的 mtime
 * 设成 2020 年。这样才能证明 E8 判据真的能抓住它 —— 判据有效，意味着将来若有人把落盘改成
 * 保留 mtime 的写法，验证会立刻红。
 */
console.log('\nD1 模拟「保留源 mtime」的落盘写法（mtime 设成 2020 年）…')
fs.writeFileSync(
  IMPORT,
  origImport.replace(
    'await utimes(dst, now, now).catch(() => undefined)',
    'await utimes(dst, new Date(2020, 0, 1), new Date(2020, 0, 1)).catch(() => undefined)'
  )
)
check('D1 mtime 判据有效', 'E8a', runVerify())
restore()

// ── D2 覆盖前不备份 ──
console.log('\nD2 覆盖前不备份（跳过备份步骤）…')
fs.writeFileSync(
  IMPORT,
  origImport.replace('await cpPreservingLinks(home, previousBackup)', 'void previousBackup')
)
check('D2 备份判据有效', 'E11', runVerify())
restore()

// ── D3 去掉 zip slip 校验 ──
console.log('\nD3 去掉 zip slip 校验（isSafeEntryPath 恒真）…')
fs.writeFileSync(
  MANIFEST,
  origManifest.replace(/export function isSafeEntryPath\([\s\S]*?\n\}/, 'export function isSafeEntryPath(_p: string): boolean {\n  return true\n}')
)
check('D3 zip slip 判据有效', 'E13', runVerify())
restore()

/*
 * ── D4 把密钥解析挪到替换之后 ──
 *
 * 这条对应端到端抓出来的真 bug：坏包会先把用户数据覆盖掉，然后才报「密钥段损坏」。
 * 注入方式是把 `prepareSecrets` 的调用点挪到替换循环之后 —— 顺序判据（护栏 B9g）与
 * 端到端（E14）都应当报红。这里验端到端这一侧。
 */
console.log('\nD4 把密钥解析挪到替换用户数据之后…')
{
  // 源码可能是 CRLF（Windows 检出），锚点要按实际换行符拼，否则永远找不到
  const nl = origImport.includes('\r\n') ? '\r\n' : '\n'
  const call = `    const secretsPlan = await prepareSecrets(secretsBuf, manifest)${nl}`
  const marker = `    report('replace', manifest.files.length, manifest.files.length)${nl}`
  if (!origImport.includes(call) || !origImport.includes(marker)) {
    bad('D4 注入失败', '找不到锚点')
  } else {
    const moved = origImport.replace(call, '').replace(marker, `${marker}${call}`)
    fs.writeFileSync(IMPORT, moved)
    check('D4 密钥顺序判据有效', 'E14b', runVerify())
    restore()
  }
}

/*
 * ── D5 把 secrets.json 从排除清单里拿掉 ──
 *
 * 对应验收的 P0-1。注入后 E17a 必须报红（旧密文进包）。
 */
console.log('\nD5 把 secrets.json 从排除清单里拿掉…')
{
  const orig = fs.readFileSync(MANIFEST, 'utf8')
  if (!orig.includes("  'secrets.json',")) {
    bad('D5 注入失败', '找不到锚点')
  } else {
    fs.writeFileSync(MANIFEST, orig.replace("  'secrets.json',", ''))
    check('D5 旧密文不进包判据有效', 'E17a', runVerify())
    restore()
  }
}

/*
 * ── D6 关掉残留清理 ──
 *
 * 对应验收的 P0-2。注入后 E16a/E16b 必须报红（只覆盖不删除）。
 */
console.log('\nD6 关掉残留清理（stale 恒为空）…')
{
  const line = 'const stale = await findStaleEntries(home, keepSet)'
  if (!origImport.includes(line)) {
    bad('D6 注入失败', '找不到锚点')
  } else {
    fs.writeFileSync(IMPORT, origImport.replace(line, 'const stale: string[] = []'))
    check('D6 真正替换判据有效', 'E16a', runVerify())
    restore()
  }
}

// ── 收尾：源码必须与开始时逐字节一致 ──
console.log('\n收尾核对…')
if (sha(IMPORT) === hashImport) ok('bundle-import.ts 已复原')
else bad('bundle-import.ts 未复原', '源码被改坏了')
if (sha(MANIFEST) === hashManifest) ok('bundle-manifest.ts 已复原')
else bad('bundle-manifest.ts 未复原', '源码被改坏了')

console.log(fails === 0 ? '\n==RESULT== ALL PASS' : `\n==RESULT== ${fails} FAIL`)
process.exit(fails === 0 ? 0 : 1)
