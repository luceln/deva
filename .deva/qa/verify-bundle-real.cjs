#!/usr/bin/env node
/**
 * 备份包端到端验证：**导出 → 彻底删掉数据 → 还原 → 逐文件比对是否回到原样**。
 *
 * ## 为什么必须跑这个，而不是只跑源码护栏
 *
 * `check-bundle-wiring.cjs` 只证明"代码看着对"，不证明"导出的包真能还原回一模一样"。
 * 而这条链路上的失效全是安静的，而且每一个都对应一种真实事故：
 *   · 还原后文件数对，但 **mtime 是旧的** → 启动清扫把 checkpoints 当过期删掉（代码里记过 2219 个被全删）
 *   · 密钥段写进去了，但没重封装 → 界面显示"有密钥"，实际每个服务商都 401
 *   · 符号链接被当成普通文件搬 → 还原后技能与外部仓库脱钩，改外部仓库不生效
 *   · `_index.json` 被搬进包 → 会话列表用的是导出当天的快照
 *   · 第二次还原时覆盖了上次的备份 → 用户丢了唯一能退回去的那份
 *
 * ## 隔离（红线）
 *
 * 全部夹具在 `os.tmpdir()/deva-bundleverify-*` 下。`DEVA_HOME` 指到临时目录，
 * **绝不碰**真实 `~/.deva-plus`、`%APPDATA%/devaplus`。
 * 涉及 `safeStorage` 的用例在没有 Electron 环境下会被**跳过并明确标注**，不假报通过。
 *
 * ## 判据
 *   E1 导出的包是个有效 zip，含 manifest.json 且 format/schemaVersion 正确
 *   E2 包内文件集合 == home 内应导文件集合（派生/临时物不在内）
 *   E3 包内每个文件的 sha256 与源文件一致
 *   E4 媒体（二进制）字节完全一致
 *   E5 符号链接被记录（不是把内容当普通文件搬）
 *   E6 密钥段存在且是明文 JSON，内容与源密钥一致
 *   E7 还原后逐文件哈希与原始 home 一致
 *   E8 还原后 mtime 是新的（不是源文件的旧时间）
 *   E9 还原后 `_index.json` 不存在（派生索引应当重建，不能来自包）
 *   E10 目标非空时未确认 → 拒绝且**零写入**
 *   E11 目标非空且确认 → 先产出 `restore-backup-*` 备份目录
 *   E12 损坏包（改一个字节）→ 报 corrupt，且目标不被破坏
 *   E13 zip slip 包（条目名含 ..）→ 拒绝
 *   E14 密钥段被写坏 → corrupt，目标不被破坏
 *   E15 第二次还原同一包 → 结果与第一次一致（幂等）
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist')

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass += 1
  console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
}
const bad = (n, d) => {
  fail += 1
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const skip = (n, why) => console.log(`  SKIP ${n} :: ${why}`)

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/** 递归列出目录下所有文件（相对路径，正斜杠），跳过指定名字。 */
function listFiles(root, skipNames = new Set()) {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipNames.has(ent.name)) continue
      const abs = path.join(dir, ent.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (ent.isSymbolicLink()) {
        out.push({ rel, link: true })
        continue
      }
      if (ent.isDirectory()) walk(abs)
      else out.push({ rel, link: false })
    }
  }
  walk(root)
  return out
}

/** 造一个「像真的一样」的 home：会话+分片、媒体、checkpoints、角色、技能（含符号链接）、配置、任务、已读态。 */
function makeHome(root) {
  const home = path.join(root, 'home')
  const mk = (p) => fs.mkdirSync(path.join(home, p), { recursive: true })

  mk('data/chats')
  mk('data/media')
  mk('data/checkpoints/s-1')
  mk('data/subagents/s-1')
  mk('data/tool-results')
  mk('personas/avatars')
  mk('personas/memory')
  mk('projects/abc123')
  mk('skills/demo')
  mk('profile')

  // 会话主档 + 分片
  const session = {
    id: 's-1',
    title: '测试会话',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' }
    ],
    compacted: { count: 2, file: 's-1.compacted-1.jsonl' }
  }
  fs.writeFileSync(path.join(home, 'data/chats/s-1.json'), JSON.stringify(session, null, 2))
  fs.writeFileSync(
    path.join(home, 'data/chats/s-1.compacted-1.jsonl'),
    [{ role: 'user', content: '早' }, { role: 'assistant', content: '早' }]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join('')
  )

  // 媒体：二进制，验证不被文本处理破坏
  const mediaBytes = crypto.randomBytes(4096)
  const mediaHash = crypto.createHash('sha256').update(mediaBytes).digest('hex')
  fs.writeFileSync(path.join(home, `data/media/${mediaHash}`), mediaBytes)

  // checkpoints / subagents / tool-results
  fs.writeFileSync(path.join(home, 'data/checkpoints/s-1/cp1.json'), JSON.stringify({ n: 1 }))
  fs.writeFileSync(path.join(home, 'data/subagents/s-1/run1.json'), JSON.stringify({ r: 1 }))
  fs.writeFileSync(path.join(home, 'data/tool-results/tr1.txt'), 'tool output\n'.repeat(10))

  // 角色 + 记忆 + 头像
  fs.writeFileSync(path.join(home, 'personas/general.md'), '# 通用角色\n')
  fs.writeFileSync(path.join(home, 'personas/avatars/general.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(home, 'personas/memory/general.json'), JSON.stringify({ entries: [] }))
  fs.writeFileSync(path.join(home, 'projects/abc123/memory.json'), JSON.stringify({ entries: [] }))

  // 配置类
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify(
      {
        models: { providers: [{ id: 'p1', apiHost: 'https://x' }], activeModelId: 'p1:m1', activeEffort: 'high' },
        locale: 'zh-CN',
        theme: 'dark',
        layout: { sidebarWidth: 320 },
        personas: { enabled: { general: true }, seeded: { general: true } }
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({ version: 2, entries: [] }))
  fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  fs.writeFileSync(
    path.join(home, 'tasks.json'),
    JSON.stringify({ version: 1, tasks: [{ id: 't1', cron: '0 9 * * *' }] })
  )
  fs.writeFileSync(path.join(home, 'read-state.json'), JSON.stringify({ 's-1': 1700000000000 }))
  /*
   * 密钥库夹具必须用 fake safeStorage **加密后的**值，不能塞一串假密文。
   *
   * 导出侧的设计是：`decryptString` 解不开的条目**跳过、不放进包里**（因为重装后同样解不开，
   * 放进去只会让用户以为密钥还在）。所以夹具若给一段假密文，导出会正确地什么都不导 ——
   * 那时 E6 失败是夹具的问题，不是实现的问题。
   */
  {
    const stub = require(path.join(QA, 'stubs', 'electron.cjs'))
    const encrypted = stub.safeStorage.encryptString('sk-plaintext-qa-key-123').toString('base64')
    fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ p1: encrypted }))
  }

  // 技能：一个普通文件 + 一个符号链接（指向外部仓库）
  fs.writeFileSync(path.join(home, 'skills/demo/SKILL.md'), '# demo\n')
  const external = path.join(root, 'external-skill')
  fs.mkdirSync(external, { recursive: true })
  fs.writeFileSync(path.join(external, 'SKILL.md'), '# linked skill\n')
  try {
    fs.symlinkSync(external, path.join(home, 'skills/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    /* 没有权限建链接：E5 会记 SKIP */
  }

  // 用户头像
  fs.writeFileSync(path.join(home, 'profile/avatar.png'), Buffer.from([1, 2, 3, 4]))

  // 派生/临时物：**不该进包**
  fs.writeFileSync(path.join(home, 'data/chats/_index.json'), '{"stale":true}')
  fs.writeFileSync(path.join(home, 'data/chats/_index.dirty'), '')
  fs.writeFileSync(path.join(home, 'import.lock'), '')

  return { home, mediaHash, mediaBytes, external }
}

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry-bundle.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle, RestoreError } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
export { scanHome, validateManifest, isSafeEntryPath } from ${JSON.stringify(
      path.join(SRC, 'main/services/bundle-manifest.ts')
    )}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'bundleverify.cjs'),
    // electron 换成 QA 替身：safeStorage 在纯 Node 下不存在。
    // 替身只模拟「本机能解/外机不能解」这一语义，判据不受影响，详见 stubs/electron.cjs。
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"test"' }
  })
  return require(path.join(DIST, 'bundleverify.cjs'))
}

async function main() {
  const root = path.join(os.tmpdir(), `deva-bundleverify-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  // DEVA_HOME 指到临时目录：getDevaHome() 读它，绝不动真实数据
  const { home, mediaHash, mediaBytes, external } = makeHome(root)
  process.env.DEVA_HOME = home
  // 记录原始 mtime，用于后面验证"还原后 mtime 必须是新的"
  const oldTime = new Date('2020-01-01T00:00:00Z')
  for (const f of ['data/checkpoints/s-1/cp1.json', 'data/media/' + mediaHash]) {
    fs.utimesSync(path.join(home, f), oldTime, oldTime)
  }

  const api = await build()

  // ── E1~E6 导出 ──
  const bundlePath = path.join(root, 'backup.dbk')
  const exp = await api.exportBundle({ targetPath: bundlePath })
  if (!exp.ok) {
    bad('E1 导出成功', JSON.stringify(exp))
    return done()
  }
  ok('E1 导出成功', `${exp.files} 文件, ${exp.bytes} 字节`)

  const { unzipSync } = require('fflate')
  const entries = unzipSync(new Uint8Array(fs.readFileSync(bundlePath)))

  // E1b manifest 正确
  const mRaw = entries['manifest.json']
  if (!mRaw) bad('E1b manifest 存在')
  else {
    const m = JSON.parse(Buffer.from(mRaw).toString('utf8'))
    const v = api.validateManifest(m)
    if (v.ok && m.format === 'devaplus-backup' && m.schemaVersion === 1) ok('E1b manifest format/schemaVersion 正确')
    else bad('E1b manifest 内容', JSON.stringify(m).slice(0, 120))
  }

  // E2 排除项不该进包
  const homeFiles = listFiles(home).filter((f) => !f.link)
  /*
   * secrets.json 必须在这一列里 —— 它是验收实测出的 P0：
   * 盘上那份是本机 safeStorage 密文，绑死当前 Windows 账户。原样搬进包，重装后解不开；
   * 更糟的是它会在替换阶段被写回目标，把用户新填的密钥顶成坏密文，而界面还显示"已配置"。
   */
  const excludedExpected = [
    'data/chats/_index.json',
    'data/chats/_index.dirty',
    'import.lock',
    'secrets.json'
  ]
  const missingExcluded = excludedExpected.filter((p) => entries[`home/${p}`])
  if (missingExcluded.length === 0) ok('E2a 派生/临时物未进包', excludedExpected.join(', '))
  else bad('E2a 派生/临时物进了包', missingExcluded.join(', '))

  const expectedFiles = homeFiles.filter((f) => !excludedExpected.includes(f.rel))
  const packed = Object.keys(entries).filter((n) => n.startsWith('home/') && !n.endsWith('.symlink'))
  if (packed.length === expectedFiles.length) ok('E2b 包内文件数与应导集合一致', `${packed.length}`)
  else bad('E2b 文件数不符', `包内 ${packed.length}，应为 ${expectedFiles.length}`)

  // E3 逐文件哈希
  let hashBad = 0
  for (const f of expectedFiles) {
    const got = crypto.createHash('sha256').update(Buffer.from(entries[`home/${f.rel}`])).digest('hex')
    const want = sha256File(path.join(home, f.rel))
    if (got !== want) hashBad += 1
  }
  if (hashBad === 0) ok('E3 包内每个文件哈希与源一致', `${expectedFiles.length} 个`)
  else bad('E3 有文件哈希不符', `${hashBad} 个`)

  // E4 媒体字节一致
  const mediaPacked = entries[`home/data/media/${mediaHash}`]
  if (mediaPacked && Buffer.compare(Buffer.from(mediaPacked), mediaBytes) === 0) ok('E4 媒体二进制完全一致')
  else bad('E4 媒体不一致')

  // E5 符号链接被记录
  const hasLink = Object.keys(entries).some((n) => n.endsWith('.symlink'))
  if (hasLink) {
    const linkRaw = entries[Object.keys(entries).find((n) => n.endsWith('.symlink'))]
    const t = JSON.parse(Buffer.from(linkRaw).toString('utf8')).target
    ok('E5 符号链接已记录', `target=${t}`)
  } else skip('E5 符号链接', '本环境无法创建符号链接（Windows 需开发者模式/管理员）')

  /*
   * E6 密钥段。
   *
   * **语义变了**：以前是"必须不是明文、要口令才解得开"；现在用户明确要求不要口令 —
   * 包里就是明文 JSON，省掉记忆和输入口令。所以判据要反过来断言"能直接读出明文"，
   * 并且断言**读出来的就是原密钥**（否则还原后密钥是错的，比没有更糟）。
   *
   * 同时必须确认：明文只在包内，磁盘上的 `secrets.json` 仍然是密文（见 E7d）。
   */
  const sec = entries['secrets.enc']
  if (!sec) bad('E6a 密钥段存在')
  else {
    const text = Buffer.from(sec).toString('utf8')
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      bad('E6b 密钥段是合法 JSON', text.slice(0, 80))
    }
    if (parsed) {
      if (parsed.p1 === 'sk-plaintext-qa-key-123') ok('E6b 密钥段是明文且内容正确')
      else bad('E6b 密钥段内容不对', JSON.stringify(parsed).slice(0, 100))
      if (typeof parsed.p1 === 'string' && !parsed.p1.startsWith('FAKE_DPAPI')) {
        ok('E6c 密钥段里是解出来的明文，不是本机密文')
      } else bad('E6c 密钥段里还是密文', '跨环境还原后必然解不开')
    }
    const mm = JSON.parse(Buffer.from(mRaw).toString('utf8'))
    if (mm.hasSecrets === true && mm.secretsKdf === undefined) ok('E6d manifest 不再声明 KDF（没有口令了）')
    else bad('E6d manifest 残留 KDF 声明', JSON.stringify({ hasSecrets: mm.hasSecrets, kdf: mm.secretsKdf }))
  }

  // ── 模拟「彻底卸载」：删掉整个 home ──
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  // ── E7~E9 还原 ──
  const res = await api.restoreBundle({ bundlePath })
  if (!res.ok) {
    bad('E7 还原成功', JSON.stringify(res))
    return done()
  }
  ok('E7a 还原成功', `${res.files} 文件`)

  let mismatch = 0
  for (const f of expectedFiles) {
    const dst = path.join(home, f.rel)
    if (!fs.existsSync(dst)) {
      mismatch += 1
      continue
    }
    if (sha256File(dst) !== sha256File(path.join(home, f.rel))) mismatch += 0 // 上面已比过内容，这里只查存在
  }
  if (mismatch === 0) ok('E7b 还原后文件齐全', `${expectedFiles.length} 个`)
  else bad('E7b 有文件缺失', `${mismatch} 个`)

  // 内容一致性：用打包时的哈希比对
  /*
   * secrets.json 必须**排除**在"内容一致"之外，而且必须是排除而不是"预料它不同"。
   * 还原时密钥要用本机 safeStorage 重新封装，密文必然与原包不同 —— 若这里要求字节一致，
   * 就只能说明还原时把旧密文原样搬回来了，那才是真 bug（换台机器/重装后全是坏密文）。
   * 密钥的正确性由 E6c（能解回原文）+ E7d（还原后能解出同一份明文）保证。
   */
  let contentBad = 0
  for (const f of expectedFiles) {
    const got = sha256File(path.join(home, f.rel))
    const want = crypto.createHash('sha256').update(Buffer.from(entries[`home/${f.rel}`])).digest('hex')
    if (got !== want) contentBad += 1
  }
  if (contentBad === 0) ok('E7c 还原后内容与原文件一致（密钥段除外，它须被重封装）')
  else bad('E7c 内容不一致', `${contentBad} 个`)

  /*
   * E7d：还原后的 secrets.json 必须能被**本机** safeStorage 解开，且内容等于导出时的明文。
   * 这是"重装后密钥还能用"的等价断言 —— 只看文件存在是不够的。
   */
  {
    const stub = require(path.join(QA, 'stubs', 'electron.cjs'))
    /*
     * secrets.json 现在是**由密钥段生成**的（它已被排除出普通文件清单，见 P0-1）。
     * 所以这里同时断言两件事：文件确实被重封装写回来了，且能用本机凭据解开。
     */
    const secPath = path.join(home, 'secrets.json')
    if (!fs.existsSync(secPath)) {
      bad('E7d 还原后密钥可用本机凭据解开', 'secrets.json 根本没被写回 —— 密钥段没落盘')
    }
    const restored = fs.existsSync(secPath) ? JSON.parse(fs.readFileSync(secPath, 'utf8')) : {}
    const map = restored.secrets ?? restored
    let decodedOk = 0
    let decodedBad = 0
    for (const v of Object.values(map)) {
      if (typeof v !== 'string' || !v.length) continue
      try {
        stub.safeStorage.decryptString(Buffer.from(v, 'base64'))
        decodedOk += 1
      } catch {
        decodedBad += 1
      }
    }
    if (decodedBad === 0 && decodedOk > 0) ok('E7d 还原后密钥可用本机凭据解开', `${decodedOk} 条`)
    else bad('E7d 还原后密钥解不开', `ok=${decodedOk} bad=${decodedBad}`)
  }

  // E8 mtime 必须是新的
  const cpMtime = fs.statSync(path.join(home, 'data/checkpoints/s-1/cp1.json')).mtimeMs
  if (cpMtime > oldTime.getTime() + 86400000) ok('E8a checkpoint mtime 已刷新', new Date(cpMtime).toISOString())
  else bad('E8a mtime 是旧的', `会被启动清扫当过期删掉：${new Date(cpMtime).toISOString()}`)
  const mediaMtime = fs.statSync(path.join(home, `data/media/${mediaHash}`)).mtimeMs
  if (mediaMtime > oldTime.getTime() + 86400000) ok('E8b 媒体 mtime 已刷新')
  else bad('E8b 媒体 mtime 是旧的', '1 小时后会被清扫删掉')

  // E9 派生索引不该被还原进来
  if (!fs.existsSync(path.join(home, 'data/chats/_index.json'))) ok('E9 派生索引未还原（会重建）')
  else bad('E9 派生索引被还原了', '会用导出当天的快照覆盖真实会话列表')

  /*
   * E16 还原必须**删掉包里有、目标多出来**的用户数据，否则只是覆盖不是替换。
   *
   * 造一份「还原前就存在、包里没有」的文件，还原后它必须消失。
   * 这条对应验收实测的 P0-2：重装后应用会先生成种子角色，只写不删会变成"卸载前 + 一份新的"。
   */
  {
    const stalePersona = path.join(home, 'personas/builtin-seeded.md')
    fs.writeFileSync(stalePersona, '# 应用启动时自动种下的角色')
    const staleChat = path.join(home, 'data/chats/never-in-bundle.json')
    fs.writeFileSync(staleChat, '{"stale":true}')
    // 用户代码目录：绝不能被删
    fs.mkdirSync(path.join(home, 'worktrees/proj'), { recursive: true })
    fs.writeFileSync(path.join(home, 'worktrees/proj/main.ts'), 'export const x = 1')

    const r16 = await api.restoreBundle({ bundlePath, overwriteConfirmed: true })
    if (!r16.ok) bad('E16a 还原成功', JSON.stringify(r16).slice(0, 120))
    else {
      if (!fs.existsSync(stalePersona)) ok('E16a 包里没有的角色文件被清掉（真正替换）')
      else bad('E16a 残留未清理', 'personas/builtin-seeded.md 还在 —— 只覆盖不删除')
      if (!fs.existsSync(staleChat)) ok('E16b 包里没有的会话文件被清掉')
      else bad('E16b 残留未清理', 'data/chats/never-in-bundle.json 还在')
      if (fs.existsSync(path.join(home, 'worktrees/proj/main.ts')))
        ok('E16c 用户工作区代码未被删（红线）')
      else bad('E16c 删了用户工作区代码', 'worktrees/ 必须永远保留')
      if (Array.isArray(r16.removedStale) && r16.removedStale.length > 0)
        ok('E16d 清理项有报告', r16.removedStale.join(', '))
      else bad('E16d 清理项未报告', '用户不知道少了什么')
    }
  }

  /*
   * E17 包内**不得**含 home/secrets.json（旧机器密文）。
   *
   * 这是验收实测的 P0-1：盘上那份密文绑死当前 Windows 账户的 DPAPI，原样搬进包重装后解不开；
   * 更糟的是它会在替换阶段写回目标，把用户新填的密钥顶成坏密文，界面却还显示"已配置"。
   * 密钥只能走 secrets.enc 这一条路。
   */
  {
    const packedSecretFile = Object.keys(entries).filter((n) => n === 'home/secrets.json')
    if (packedSecretFile.length === 0) ok('E17a 包内不含 home/secrets.json（旧密文不进包）')
    else bad('E17a 包内带了旧密文 secrets.json', '还原后会把新填的密钥顶成解不开的坏密文')

    // 还原后 disk 上的 secrets.json 必须是密文（明文只许存在于包内）
    const diskSec = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'))
    const vals = Object.values(diskSec.secrets ?? diskSec)
    const plainOnDisk = vals.some((v) => typeof v === 'string' && v === 'sk-plaintext-qa-key-123')
    if (!plainOnDisk) ok('E17b 磁盘上的密钥是密文，明文未落盘')
    else bad('E17b 明文密钥落到了磁盘上')
  }

  // E10 目标非空且未确认 → 拒绝且零写入
  const before = sha256File(path.join(home, 'config.json'))
  const r10 = await api.restoreBundle({ bundlePath, overwriteConfirmed: false })
  if (!r10.ok && r10.code === 'cancelled') {
    const after = sha256File(path.join(home, 'config.json'))
    if (before === after) ok('E10 非空目标未确认 → 拒绝且零写入')
    else bad('E10 拒绝了但已经改了文件')
  } else bad('E10 应当拒绝', JSON.stringify(r10).slice(0, 100))

  // E11 确认后应产出 restore-backup-*
  const r11 = await api.restoreBundle({ bundlePath, overwriteConfirmed: true })
  if (r11.ok && r11.backupOfPrevious && fs.existsSync(r11.backupOfPrevious)) {
    ok('E11 覆盖前自动备份', path.basename(r11.backupOfPrevious))
  } else bad('E11 没有自动备份', JSON.stringify(r11).slice(0, 120))

  /*
   * E15 幂等：把同一个包再还原一次，结果必须与**包内容**一致。
   *
   * 判据刻意不写成"与上一次还原的结果相同"：那样只要两次都错成同一个样子就会 PASS。
   * 以包为基准才能同时抓住"第一次对、第二次被污染"和"两次都少了同样的东西"。
   */
  const cfgHash1 = sha256File(path.join(home, 'config.json'))
  const r15 = await api.restoreBundle({ bundlePath, overwriteConfirmed: true })
  const cfgHash2 = sha256File(path.join(home, 'config.json'))
  if (!r15.ok) bad('E15a 第二次还原成功', JSON.stringify(r15).slice(0, 120))
  else {
    const diff = []
    for (const f of expectedFiles) {
      if (f.rel === 'secrets.json') continue // 每次都用本机凭据重封装，密文必然不同
      const dst = path.join(home, f.rel)
      if (!fs.existsSync(dst)) {
        diff.push(`${f.rel}:缺失`)
        continue
      }
      const want = crypto.createHash('sha256').update(Buffer.from(entries[`home/${f.rel}`])).digest('hex')
      if (sha256File(dst) !== want) diff.push(`${f.rel}:变了`)
    }
    if (diff.length === 0) ok('E15a 第二次还原后内容仍与包一致（幂等）')
    else bad('E15a 第二次还原后偏离包内容', diff.join(' | '))
    if (cfgHash1 === cfgHash2) ok('E15b 两次还原产出的 config.json 字节相同')
    else bad('E15b config.json 两次不同', '同样的包不应产出不同的配置')
  }

  // ── E12 损坏包 ──
  const corruptPath = path.join(root, 'corrupt.dbk')
  {
    const src = fs.readFileSync(bundlePath)
    // 改中间一个字节：zip 结构还在，内容哈希必然不符
    const idx = Math.floor(src.length / 2)
    src[idx] = src[idx] ^ 0xff
    fs.writeFileSync(corruptPath, src)
  }
  const beforeC = sha256File(path.join(home, 'config.json'))
  const r12 = await api.restoreBundle({ bundlePath: corruptPath, overwriteConfirmed: true })
  const afterC = sha256File(path.join(home, 'config.json'))
  if (!r12.ok && (r12.code === 'corrupt' || r12.code === 'not-a-bundle' || r12.code === 'extract-failed')) {
    if (beforeC === afterC) ok('E12 损坏包被拒且目标未被破坏', r12.code)
    else bad('E12 损坏包被拒但目标已被改动')
  } else bad('E12 损坏包被接受了', JSON.stringify(r12).slice(0, 120))

  // ── E13 zip slip ──
  const slipPath = path.join(root, 'slip.dbk')
  {
    const { zipSync } = require('fflate')
    const evil = {
      'manifest.json': new Uint8Array(
        Buffer.from(
          JSON.stringify({
            format: 'devaplus-backup',
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            appVersion: 'x',
            platform: 'x',
            files: [],
            symlinks: [],
            excluded: [],
            hasSecrets: false
          })
        )
      ),
      '../../evil.txt': new Uint8Array(Buffer.from('pwned'))
    }
    fs.writeFileSync(slipPath, Buffer.from(zipSync(evil)))
  }
  const r13 = await api.restoreBundle({ bundlePath: slipPath, overwriteConfirmed: true })
  if (!r13.ok && r13.code === 'unsafe-path') ok('E13 zip slip 被拒', '../../evil.txt')
  else bad('E13 zip slip 没被拦住', JSON.stringify(r13).slice(0, 120))

  /*
   * ── E14 密钥段损坏 ──
   *
   * 没有口令了，"口令错"这个失败模式消失，但"密钥段坏了"还在（磁盘位翻转、传输截断）。
   * 它必须在**动密钥库之前**被挡住：否则会用一份坏数据覆盖掉用户现有的可用密钥。
   */
  const badSecPath = path.join(root, 'badsecrets.dbk')
  {
    const { zipSync } = require('fflate')
    const m = JSON.parse(Buffer.from(mRaw).toString('utf8'))
    const evil = {
      'manifest.json': mRaw,
      'secrets.enc': new Uint8Array(Buffer.from('{ this is not json')),
      ...Object.fromEntries(
        Object.entries(entries).filter(([k]) => k.startsWith('home/'))
      )
    }
    fs.writeFileSync(badSecPath, Buffer.from(zipSync(evil)))
    void m
  }
  /*
   * **必须让"被覆盖"产生可观测的差异，否则判据抓不住任何东西。**
   *
   * 第一版直接比还原前后的 `config.json` 哈希，可坏包里带的正是同一份 config —— 覆盖了也
   * 一模一样，于是"先替换数据、后报密钥错"的注入照样 PASS。这是在验一个恒真命题。
   *
   * 正确做法：还原前把目标改成一份**与包内不同**的内容。如果实现顺序对了（先验密钥段，
   * 报错即退出），这份用户数据必须原封不动；顺序反了就会被包里的内容盖掉，哈希必然变化。
   * 同时造一个包里没有的会话文件 —— 残留清理若已执行也会把它删掉，多一条观测点。
   */
  const beforeE = sha256File(path.join(home, 'secrets.json'))
  const beforeConfig = ['config-local-marker', 'theme:light']
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ local: beforeConfig }))
  fs.writeFileSync(path.join(home, 'data/chats/only-local.json'), '{"localOnly":true}')
  const beforeData = sha256File(path.join(home, 'config.json'))
  const r14 = await api.restoreBundle({ bundlePath: badSecPath, overwriteConfirmed: true })
  const afterE = sha256File(path.join(home, 'secrets.json'))
  const afterData = sha256File(path.join(home, 'config.json'))
  const localChatAlive = fs.existsSync(path.join(home, 'data/chats/only-local.json'))
  if (!r14.ok && r14.code === 'corrupt') {
    ok('E14a 密钥段损坏被拦住', r14.code)
    if (beforeData === afterData && localChatAlive) {
      ok('E14b 用户数据未被覆盖（坏包在动数据之前就被挡住）')
    } else {
      bad(
        'E14b 用户数据被覆盖了',
        `config 已变=${beforeData !== afterData}，本地会话被删=${!localChatAlive} ` +
          '—— 坏包先覆写数据再报错，用户只剩自动备份可退'
      )
    }
    if (beforeE === afterE) ok('E14c 现有密钥未被破坏')
    else bad('E14c 损坏被拒了但密钥库已被改动')
  } else bad('E14 损坏的密钥段没被拦住', JSON.stringify(r14).slice(0, 120))

  // ── 清场 ──
  fs.rmSync(root, { recursive: true, force: true })
  console.log(`  （已清理临时目录 ${root}）`)
  done()
}

let finished = false
function done() {
  if (finished) return
  finished = true
  console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('  ERROR', e)
  finishFail()
})
function finishFail() {
  if (finished) return
  finished = true
  console.log(`\n==RESULT== ${pass} PASS / ${fail + 1} FAIL（异常中止）`)
  process.exit(1)
}
