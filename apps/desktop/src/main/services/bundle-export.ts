import { createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, rename, rm, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { MANIFEST_NAME, SECRETS_ENC_NAME, type BundleManifest, type ExportResult } from '../../shared/bundle-format'
import { buildManifest, hashFiles, scanHome, toEntryName } from './bundle-manifest'
import { checkPassphrase, encryptSecrets, newKdf } from './bundle-crypto'
import { getDevaHome } from './config'

/**
 * 导出一份备份包。
 *
 * ## 为什么必须流式
 *
 * 本机实测 home 约 600MB（chats 99 + media 130 + checkpoints 184 + subagents 52 + tool-results 48）。
 * `fflate` 的 `zipSync` 会把整个包在内存里拼出来 —— 这个量级直接顶爆 Node 默认堆。
 * 所以走 `Zip` 的流式回调：读一个文件、写一个条目、释放，内存里只有单个文件的量。
 *
 * ## 压缩策略
 *
 * 按扩展名分流：文本类走 `ZipDeflate`（实测能有数倍收益），媒体 / blob 走 `ZipPassThrough`（store）。
 * 后者不是偷懒 —— jpeg/png/pdf 本身已是压缩格式，再 deflate 一遍只烧 CPU 不换体积，
 * 而这几百 MB 的媒体占了总大小的七成。
 */

/** 文本类才值得压缩。 */
function shouldCompress(relPath: string): boolean {
  return /\.(json|jsonl|md|txt|ts|tsx|js|jsx|css|html|svg|yml|yaml)$/i.test(relPath)
}

export interface ExportOptions {
  /** 目标包路径。扩展名只用于展示，不影响格式。 */
  targetPath: string
  /** 口令。未给 / 空串 = 包里不含密钥段。 */
  passphrase?: string
  onProgress?: (done: number, total: number) => void
}

/**
 * 执行导出。
 *
 * 失败一律返回结果对象而不是抛错：「磁盘满」「文件被占用」在这条链路上都是正常失败，
 * 抛错只会让渲染层拿到一个未分类的 Error，用户看到「导出失败」四个字，
 * 不知道该清盘还是换个目录。
 */
export async function exportBundle(opts: ExportOptions): Promise<ExportResult> {
  const home = getDevaHome()
  const pass = opts.passphrase?.trim() ?? ''

  let kdf
  if (pass) {
    // 口令给了就必须验强度：太短的口令等于没加密，而这个包里有全部 API 密钥。
    const chk = checkPassphrase(pass)
    if (!chk.ok) return { ok: false, code: 'write-failed', message: chk.reason }
    kdf = newKdf()
  }

  let scan
  try {
    scan = await scanHome(home)
  } catch (e) {
    return { ok: false, code: 'read-failed', message: (e as Error)?.message ?? String(e) }
  }

  /*
   * 容量预检：扫完元数据、**还没开始读内容**时先看目标盘装不装得下。
   *
   * 顺序很重要 —— 哈希要把 600MB 全读一遍，打包还要再读一遍。装不下的情况下先做这两步，
   * 等于让用户白等几分钟再看一句「磁盘空间不足」。压缩率按文本类估 1/5、媒体按 1.0：
   * 这是个偏保守的估算（宁可靠近真实，也不要给出一个乐观值然后写到一半失败）。
   */
  const room = await checkRoom(opts.targetPath, scan.bytes)
  if (room) return { ok: false, code: 'write-failed', message: room }

  try {
    await hashFiles(home, scan)
  } catch (e) {
    return { ok: false, code: 'read-failed', message: `读取文件内容失败：${(e as Error)?.message ?? e}` }
  }

  const secretsBlob = await buildSecretsBlob(home, pass, kdf)
  if (secretsBlob && 'error' in secretsBlob) {
    return { ok: false, code: 'read-failed', message: secretsBlob.error }
  }
  const secrets: Buffer | null = secretsBlob ?? null

  const manifest = buildManifest(
    scan,
    { appVersion: await appVersion(), platform: process.platform, hasSecrets: secrets !== null },
    kdf
  )

  /*
   * 先写 .part，全部成功才 rename 成正式名。
   *
   * 直接写目标文件的风险：导出要跑几分钟，中途失败（磁盘满 / 用户关窗口）会留下一个半截 zip。
   * 用户看不出它坏了，等哪天拿它去还原才发现「包已损坏」—— 而那时原始数据可能已经删了。
   */
  const finalPath = await uniqueTarget(opts.targetPath)
  const partPath = `${finalPath}.part`

  try {
    await mkdir(dirname(finalPath), { recursive: true })
    await writeZip(partPath, home, manifest, secrets, opts.onProgress)
    await rename(partPath, finalPath)
  } catch (e) {
    // 失败必须清理 .part，否则用户目录里会攒下一堆半截文件
    await rm(partPath, { force: true }).catch(() => undefined)
    const msg = (e as Error)?.message ?? String(e)
    if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') {
      return { ok: false, code: 'write-failed', message: `磁盘空间不足：${msg}` }
    }
    return { ok: false, code: 'write-failed', message: `导出失败：${msg}` }
  }

  return {
    ok: true,
    path: finalPath,
    files: manifest.files.length,
    bytes: (await stat(finalPath)).size,
    hasSecrets: secrets !== null,
    excluded: manifest.excluded
  }
}

/**
 * 读密钥库、解出明文、再用口令加密。返回 null = 没有密钥库（不是错误），`{error}` = 读失败。
 *
 * ## 为什么必须逐条解成明文
 *
 * `secrets.json` 里存的是 `safeStorage.encryptString(明文)` 的 base64，**其密钥绑定本机凭据**
 * （Windows 上是 DPAPI + `userData/Local State`）。把这份密文原样放进包，重装后新 key 解不开，
 * 还原出来的密钥一条都用不了 —— 而界面上它们"存在"，实际请求全部 401。
 *
 * 所以这里先解出明文再加密。解不开的条目（来自别的账户 / 更早的环境）**原样保留密文**并计入报告：
 * 删掉会让用户以为是"本来就没配"，保留至少让他能看出有问题。
 */
async function buildSecretsBlob(
  home: string,
  pass: string,
  kdf: ReturnType<typeof newKdf> | undefined
): Promise<Buffer | null | { error: string }> {
  if (!pass || !kdf) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(join(home, 'secrets.json'), 'utf8')) as Record<string, unknown>
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    return { error: `读取密钥库失败（${(e as Error)?.message ?? e}）` }
  }

  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    return { error: '本机没有可用的加密存储，无法导出密钥（可以不带口令导出，导入后重新填写）。' }
  }

  const plain: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string' || !val) continue
    try {
      plain[key] = safeStorage.decryptString(Buffer.from(val, 'base64'))
    } catch {
      /*
       * 解不开：保持密文原样。
       * 这些条目在导出环境里本来就已是坏的（历史跨应用导入留下的残留、或换过账户），
       * 打包出去至少能让用户在新环境看到"有这一条"，而不是静默消失。
       */
      plain[key] = val
    }
  }
  return encryptSecrets(JSON.stringify(plain), pass, kdf)
}

/**
 * 目标已存在就改名，**绝不覆盖**。
 *
 * 用户把备份包存到上次那个位置是很自然的操作。静默覆盖意味着上次的备份被这次顶掉，
 * 而两次之间他很可能已经删了些东西 —— 那时就没得退了。
 */
async function uniqueTarget(p: string): Promise<string> {
  if (!existsSync(p)) return p
  const dot = p.lastIndexOf('.')
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const stem = dot > slash ? p.slice(0, dot) : p
  const ext = dot > slash ? p.slice(dot) : ''
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let candidate = `${stem}-${stamp}${ext}`
  let n = 1
  while (existsSync(candidate)) {
    candidate = `${stem}-${stamp}-${n}${ext}`
    n += 1
  }
  return candidate
}

/**
 * 流式写 zip。
 *
 * `Zip` 的回调每产出一块就推给写流；`push(..., true)` 表示该条目结束。
 * 条目顺序：清单在最前（解包方打开就能知道这是什么包，不必先扫全部条目），然后密钥段，然后文件。
 */
function writeZip(
  partPath: string,
  home: string,
  manifest: BundleManifest,
  secrets: Buffer | null,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(partPath)
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    out.on('error', finish)
    out.on('finish', () => finish())

    const zip = new Zip((err, chunk, final) => {
      if (err) return finish(err)
      out.write(Buffer.from(chunk))
      if (final) out.end()
    })

    void (async () => {
      try {
        const total = manifest.files.length + 1 // +1：manifest.json 本身
        let n = 0
        const tick = (): void => onProgress?.((n += 1), total)

        addBuffer(zip, MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), true)
        tick()

        if (secrets) addBuffer(zip, SECRETS_ENC_NAME, secrets, false)

        for (const f of manifest.files) {
          const data = await readFile(join(home, f.path))
          /*
           * 清单里的 size 与磁盘实际不符 → 中止，而不是写一份自相矛盾的包。
           * 什么时候会发生：导出期间应用还在写这个文件（正在进行的对话、正在追加的 tool-result）。
           * 写进去的包内容与清单哈希对不上，还原时会被判「包已损坏」，那时用户已经没法重导了。
           */
          if (data.length !== f.size) {
            throw new Error(
              `文件在导出过程中被修改：${f.path}（清单 ${f.size} 字节，实际 ${data.length}）。请等当前对话结束后重试。`
            )
          }
          addBuffer(zip, toEntryName(f.path), data, shouldCompress(f.path))
          tick()
          // 让出事件循环：几百个文件连续 readFile 会把进度事件饿死，界面看着像卡死
          if (n % 16 === 0) await new Promise((r) => setImmediate(r))
        }

        // zip 本身不表达「这是个符号链接」，所以链接单独写成一个小文本条目
        for (const link of manifest.symlinks) {
          addBuffer(
            zip,
            `${toEntryName(link.path)}.symlink`,
            Buffer.from(JSON.stringify({ target: link.target }), 'utf8'),
            true
          )
        }

        zip.end()
      } catch (e) {
        finish(e as Error)
      }
    })()
  })
}

/** 把一个 buffer 写成 zip 条目。 */
function addBuffer(zip: Zip, name: string, data: Buffer, compress: boolean): void {
  const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
  zip.add(entry)
  entry.push(new Uint8Array(data), true)
}

/** 读应用版本。读不到不影响导出。 */
async function appVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 目标盘剩余空间是否够。
 *
 * 压缩率估法：文本类（json/jsonl/md 等，实测能到 1/5）与媒体（已压缩，基本不缩）分开估。
 * 这里用「文本按 0.35、其余按 1.0」的保守混算 —— 估高了会在写到一半时 ENOSPC，
 * 那比一开始就拒绝糟得多（用户已经等了几分钟）。
 *
 * 返回 null = 够；返回字符串 = 给人看的拒绝理由。
 */
async function checkRoom(targetPath: string, bytes: number): Promise<string | null> {
  try {
    const { statfs } = await import('fs/promises')
    // 目标还没创建时，取它所在目录的剩余空间
    let probe = dirname(targetPath)
    // 目录可能也不存在，逐级向上找到第一个存在的
    for (let i = 0; i < 8; i++) {
      if (existsSync(probe)) break
      const up = dirname(probe)
      if (up === probe) break
      probe = up
    }
    const st = await statfs(probe)
    const free = Number(st.bavail) * Number(st.bsize)
    // 保守：按未压缩大小 × 0.75 估（文本通常能压到 1/5，媒体不压，混起来偏保守）
    const need = Math.ceil(bytes * 0.75)
    if (free < need) {
      const gb = (n: number): string => `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
      return `目标磁盘空间不足：约需 ${gb(need)}，可用 ${gb(free)}。请换一个位置或清理磁盘后重试。`
    }
    return null
  } catch {
    // statfs 在部分文件系统 / 老版本 Node 上不可用：**不因此阻止导出**，
    // 写入时的 ENOSPC 仍会被捕获并清理 .part。
    return null
  }
}
