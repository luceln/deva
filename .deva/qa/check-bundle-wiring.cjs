#!/usr/bin/env node
/**
 * 备份包（导出 / 还原）的接线与安全判据。
 *
 * 为什么需要这组判据：备份还原的失效几乎都是**安静的**。
 * 导出的包少了一半文件、还原时没刷 mtime、解压时被 zip slip 写到目录外、密钥没重封装——
 * 这些都能让界面显示「还原完成」，而用户要到几天后（清扫删了 checkpoint、某个服务商 401、
 * 或者磁盘上多了一堆陌生文件）才发现。所以把这几条钉在源码形状上，CI 能跑。
 *
 * 判据：
 *   B1  导出用流式 Zip，**不得**出现 zipSync（600MB 会顶爆内存）
 *   B2  导出先写 .part，成功后 rename（半截 zip 会被用户当成有效备份）
 *   B3  manifest 必须写 format + schemaVersion（否则无法判断"这是不是本应用的包"）
 *   B4  还原前必须校验条目路径（zip slip）
 *   B5  临时目录清理必须落在 finally（异常路径不清理会不断累积）
 *   B6  覆盖前必须先备份现有数据，且备份失败要中止
 *   B7  统一刷 mtime（不刷会被启动清扫按 mtime 删掉）
 *   B8  索引刷新只用 invalidateIndexOnly（用 invalidateIndex 会让之后所有 save() 静默失败）
 *   B9  密钥：包内是明文（无口令），但**磁盘上必须仍是密文**（导出解明文、导入重封装）
 *   B10 符号链接要记录，不能只搬内容
 *
 * 它**不能**证明的：真实导出/还原能不能跑通、包里内容对不对。那是 verify-bundle-real.cjs 的事。
 *
 * 判据一律"先断言命中数 ≥1 再判内容"：空集合上 every()/some() 恒真，会出假 PASS。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const MAIN = path.join(REPO, 'apps', 'desktop', 'src', 'main')
const EXPORT = path.join(MAIN, 'services', 'bundle-export.ts')
const IMPORT = path.join(MAIN, 'services', 'bundle-import.ts')
const MANIFEST = path.join(MAIN, 'services', 'bundle-manifest.ts')
const FORMAT = path.join(REPO, 'apps', 'desktop', 'src', 'shared', 'bundle-format.ts')
const IPC = path.join(MAIN, 'backup-ipc.ts')

let fails = 0
const pass = (name, detail) => console.log(`  PASS ${name}${detail ? ` :: ${detail}` : ''}`)
const fail = (name, detail) => {
  fails += 1
  console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}

function read(p) {
  if (!fs.existsSync(p)) {
    fail('文件存在', p)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

const srcExport = read(EXPORT)
const srcImport = read(IMPORT)
const srcManifest = read(MANIFEST)
const srcFormat = read(FORMAT)
const srcIpc = read(IPC)

const need = (name, src, re, msg) => {
  const hits = src.match(re) || []
  if (hits.length === 0) {
    fail(name, msg || `找不到 ${re}`)
    return false
  }
  pass(name, `${hits.length} 处`)
  return true
}

const forbid = (name, src, re, msg) => {
  const hits = src.match(re) || []
  if (hits.length > 0) {
    fail(name, msg || `不该出现 ${re}`)
    return false
  }
  pass(name)
  return true
}

// ── B1 流式 Zip ──
need('B1a 导出用流式 Zip', srcExport, /new Zip\(/, '没有 new Zip(')
forbid(
  'B1b 导出不得用 zipSync',
  srcExport,
  /\bzipSync\s*\(/,
  'zipSync 会把整个包拼在内存里；home 约 600MB，直接顶爆 Node 堆'
)
need('B1c 大件走 PassThrough 不压缩', srcExport, /new ZipPassThrough\(/, '媒体/大件应 store 而非 deflate')

// ── B2 .part + rename ──
need('B2a 先写 .part', srcExport, /\.part`/, '没有 .part 临时文件')
need('B2b 成功后 rename', srcExport, /await rename\(partPath, finalPath\)/, '没有 rename 到正式名')
need(
  'B2c 失败要清理 .part',
  srcExport,
  /rm\(partPath, \{ force: true \}\)/,
  '失败不清理会攒下半截文件，用户会拿它去还原'
)

// ── B3 manifest 字段 ──
need('B3a manifest 写 format', srcManifest, /format: BUNDLE_FORMAT/, 'manifest 没写 format')
need('B3b manifest 写 schemaVersion', srcManifest, /schemaVersion: BUNDLE_SCHEMA_VERSION/, '没写 schemaVersion')
need(
  'B3c 校验 schemaVersion 上界',
  srcManifest,
  /m\.schemaVersion > BUNDLE_SCHEMA_VERSION/,
  '没有拒绝「来自更新版本的包」'
)
need('B3d 逐文件 sha256', srcManifest, /sha256:\s*await hashFile|f\.sha256 = await hashFile/, '没有逐文件哈希')
need('B3e 记录符号链接', srcManifest, /symlinks\.push\(\{ path: rel, target/, '没记录符号链接')

// ── B4 zip slip ──
need('B4a 有路径安全判据', srcManifest, /export function isSafeEntryPath/, '缺 isSafeEntryPath')
need('B4b 拒绝 .. 段', srcManifest, /s === '\.\.'/, '没拒绝 ..')
need('B4c 拒绝绝对路径', srcManifest, /p\.startsWith\('\/'\)/, '没拒绝绝对路径')
need(
  'B4d 解压前校验全部条目名',
  srcImport,
  /for \(const name of Object\.keys\(entries\)\)[\s\S]{0,200}isSafeEntryPath\(name\)/,
  '没在写文件前校验条目名'
)

// ── B5 finally 清理 ──
const hasFinally = /finally \{[\s\S]{0,400}rm\(staging/.test(srcImport)
if (!hasFinally) fail('B5 临时目录在 finally 清理', 'staging 清理不在 finally 里')
else pass('B5 临时目录在 finally 清理')

// ── B6 覆盖前备份 ──
need('B6a 覆盖前备份现有数据', srcImport, /restore-backup-\$\{stamp\(\)\}/, '没有自动备份')
need(
  'B6b 备份失败要中止',
  srcImport,
  /备份现有数据失败，已中止/,
  '备份失败还继续覆盖 = 没有退路的破坏'
)
need('B6c 非空目标要确认', srcImport, /overwriteConfirmed/, '没有覆盖确认')

// ── B7 mtime ──
need(
  'B7 统一刷 mtime',
  srcImport,
  /utimes\(dst, now, now\)/,
  'cp 会保留源 mtime；不刷的话 checkpoints/media/subagents 会被启动清扫当过期删除'
)

// ── B8 索引刷新 ──
need('B8a 用 invalidateIndexOnly', srcImport, /invalidateIndexOnly\(\)/, '没用 invalidateIndexOnly')
/**
 * 去掉注释再判：注释里常常**提及**被禁止的写法（「不能用 invalidateIndex()」正是如此），
 * 直接正则匹配会把"提醒不要用"误判成"用了"。这是源码形状护栏的常见假阳性来源。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const codeImport = stripComments(srcImport)
const codeExport = stripComments(srcExport)

forbid(
  'B8b 不得用 invalidateIndex',
  codeImport,
  /invalidateIndex(?!Only)/,
  'invalidateIndex 会清 sessionCache，之后所有 save() 静默返回 not-saved'
)

// ── B9 密钥：包内明文、磁盘密文 ──
need('B9a 导出解出明文', srcExport, /safeStorage\.decryptString/, '没解明文 → 旧密文跨环境必然解不开')
need('B9c 导入重新封装', srcImport, /safeStorage\.encryptString/, '没重封装 → 还原后密钥全是坏密文')
need('B9d 无加密能力时不写明文', srcImport, /noEncryption: true/, '本机无加密时应报 noEncryption 而不是退化成明文')
forbid(
  'B9e 不得保留口令加密',
  stripComments(srcExport),
  /encryptSecrets|newKdf|checkPassphrase/,
  '用户明确要求不要口令；残留会把明文又加密回去，还原时还得让用户输口令'
)
forbid(
  'B9f 不得有口令校验通道',
  stripComments(srcIpc),
  /check-passphrase|verifyPassphrase/,
  '没有口令可校，留着会让界面以为需要输口令'
)
/*
 * 顺序判据（这条是端到端 E14 抓出来的真 bug）：
 * 密钥段**必须在替换用户数据之前**解析，否则坏包会在覆盖完数据之后才暴露，
 * 用户剩下的唯一退路是那份自动备份。
 */
{
  const iPrepare = srcImport.indexOf('prepareSecrets(entries, manifest)')
  const iReplace = srcImport.indexOf("report('replace', 0, manifest.files.length)")
  if (iPrepare < 0 || iReplace < 0) fail('B9g 密钥解析在替换之前', '找不到判据锚点')
  else if (iPrepare < iReplace) pass('B9g 密钥解析在替换用户数据之前')
  else fail('B9g 密钥解析在替换之前', '坏包会先覆盖数据再报错，用户只能靠自动备份退回')
}

// ── B10 符号链接还原 ──
need('B10a 还原时重建链接', srcImport, /await symlink\(link\.target/, '没重建符号链接')
need('B10b 目标不存在要报告', srcImport, /symlinkAsCopy\.push/, '降级为副本时必须报告，不能静默')

/*
 * B11 secrets.json 必须被排除出普通文件清单。
 *
 * 验收实测的 P0-1：盘上那份是本机 safeStorage 密文，绑死当前 Windows 账户的 DPAPI。
 * 原样搬进包，重装后解不开；更糟的是它会在替换阶段写回目标，把用户新填的密钥顶成坏密文，
 * 而界面还显示"已配置"，实际所有服务商 401。密钥只走 secrets.enc 这一条路。
 */
{
  const inExcluded = /EXCLUDED_EXACT = new Set\(\[[\s\S]*?'secrets\.json'[\s\S]*?\]\)/.test(srcManifest)
  if (inExcluded) pass('B11a secrets.json 在排除清单里')
  else fail('B11a secrets.json 在排除清单里', '旧密文会被当普通文件搬进包并覆盖目标')
  need(
    'B11b 还原时 secrets.json 不计入残留清理',
    srcImport,
    /keepSet\.add\('secrets\.json'\)/,
    '不加进 keep 会被当残留删掉，而密钥段随后才写'
  )
}

/*
 * B12 必须是「替换」而不是「覆盖写入」。
 *
 * 只写不删时，重装后应用生成的种子数据（内置角色等）会和还原的数据混在一起，
 * 用户看到的不是卸载前的样子。验收实测：包里 4 个文件，还原后目录 7 个。
 */
{
  need('B12a 有残留清理步骤', srcImport, /findStaleEntries\(home, keepSet\)/, '没有清理 → 只是覆盖不是替换')
  need(
    'B12b worktrees 永不删',
    srcImport,
    /if \(top === 'worktrees'\) continue/,
    '删用户工作区代码是红线'
  )
  need('B12c 清理项要报告', srcImport, /removedStale\.push/, '不报告用户不知道少了什么')
  need(
    'B12d 清理范围白名单化',
    srcImport,
    /const RESTORE_SCOPE = new Set\(/,
    '不能整个目录 rm -rf，只清备份明确的那些顶层项'
  )
}

/*
 * B13 密钥库写盘结果必须检查。
 *
 * `replaceAllSecrets` 会返回 {ok:false}（库损坏 / 写盘失败）。忽略它就会在一条都没落盘时
 * 报「已还原 N 条密钥」，用户以为好了。
 */
{
  const m = stripComments(srcImport)
  if (/replaceAllSecrets\(out\)/.test(m) && /if \(!written\.ok\)/.test(m)) pass('B13 密钥写盘结果被检查')
  else fail('B13 密钥写盘结果被检查', '忽略返回值会在写盘失败时仍报成功')
  need(
    'B13b 还原前重置密钥库内存态',
    srcImport,
    /resetForRestore\(\)/,
    '不清会撞 loadKind=corrupt 而拒绝写入（用户正因旧库坏了才来还原）'
  )
}

// ── 契约：format 常量 ──
need('C1 format 常量', srcFormat, /BUNDLE_FORMAT = 'devaplus-backup'/, '常量不对')
need('C2 有 schemaVersion', srcFormat, /BUNDLE_SCHEMA_VERSION = \d+/, '缺版本常量')

// ── 契约：IPC 通道与 preload 一致 ──
for (const ch of ['backup:export', 'backup:inspect', 'backup:restore']) {
  const inIpc = srcIpc.includes(`'${ch}'`)
  const pre = path.join(REPO, 'apps', 'desktop', 'src', 'preload', 'backup.ts')
  const srcPre = fs.existsSync(pre) ? fs.readFileSync(pre, 'utf8') : ''
  const inPre = srcPre.includes(`'${ch}'`)
  if (inIpc && inPre) pass(`C3 通道 ${ch} 主进程与 preload 都有`)
  else fail(`C3 通道 ${ch}`, `主进程=${inIpc} preload=${inPre}`)
}

// ── 锁：导出/还原都要拿锁 ──
need('C4 导出拿锁', srcIpc, /acquireLock\(getDevaHome\(\)\)/, '不拿锁会与导入互相踩')

console.log(fails === 0 ? '\n==RESULT== ALL PASS' : `\n==RESULT== ${fails} FAIL`)
process.exit(fails === 0 ? 0 : 1)
