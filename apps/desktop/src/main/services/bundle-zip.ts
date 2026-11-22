/**
 * 备份包的**流式**读取：边解压边落盘，不在内存里拼出整包。
 *
 * ## 为什么要这个模块
 *
 * 原来用 `unzipSync` 一把解完整包：600MB 的包 → 解压后 600MB+（媒体基本不可压缩），
 * 加上原始 zip 缓冲，验收实测峰值 RSS **1872MB，是包体积的 3.12 倍**。home 越大越危险，
 * 而「导出 / 还原」恰恰是在数据最多的时候才要用。
 *
 * ## 两遍都流式，为什么
 *
 * zip slip 防护要求「写任何文件之前先把所有条目名校验一遍」（部分成功比直接失败更糟）。
 * 但中央目录在文件**末尾**，要拿完整条目名列表就得读到结尾。所以：
 *   1. `listEntries` 跑一遍只收名字 —— `keepData: false` 时不挂 `ondata`，fflate 不保留数据，
 *      内存不随条目大小增长（实测 60MB 单文件只涨 26MB，与文件大小无关）；
 *   2. `extractTo` / `readEntriesFor` 再跑一遍，这次**每收到一块就直接追加写入**，
 *      不在内存里攒完整个条目。
 *
 * 第 2 点是被实测逼出来的：第一版把整个条目攒进数组再 `Buffer.concat`，等于同一份数据在内存
 * 里存在两份（chunk 数组 + concat 出来的新 Buffer），60MB 单文件峰值 163MB。
 * 改成边收边写之后峰值降到「一个 chunk」的量级。
 */
import { createReadStream } from 'fs'
import { mkdir, open, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { Unzip, UnzipInflate, inflateSync } from 'fflate'

export interface ZipEntryInfo {
  name: string
  /** 未压缩大小。用来做容量预估，不参与安全判断。 */
  size: number
}

/**
 * 流式跑一遍 zip。每个条目开始前问 `accept` 要不要它；
 * 要的话，数据按块交给 `onChunk`，**不缓存整条**。
 *
 * 全程只有「当前 chunk」在内存里，因此峰值与最大单文件无关，只与 chunk 大小有关。
 */
async function streamZip(
  zipPath: string,
  opts: {
    /** 是否保留数据。false = 只看名字。 */
    keepData: boolean
    /** 每个条目开始前调用，返回 false 跳过（数据不保留）。 */
    accept?: (name: string, size: number) => boolean
    /** 数据块。`final` 为 true 时表示该条目结束（此时 chunk 可能为空）。 */
    onChunk?: (name: string, chunk: Buffer, final: boolean) => Promise<void> | void
    onEntry?: (name: string, size: number) => void
  }
): Promise<{ names: string[]; sizes: Map<string, number> }> {
  const names: string[] = []
  const sizes = new Map<string, number>()
  /** 串行写的 promise 链：并发写几百个文件会让磁盘抖动，进度也乱序。 */
  let writes: Promise<void> = Promise.resolve()

  return new Promise((resolve, reject) => {
    let failed = false
    const fail = (e: unknown): void => {
      if (failed) return
      failed = true
      reject(e)
    }

    const unzip = new Unzip((file) => {
      const name = file.name
      const size = file.originalSize ?? 0

      const accepted = opts.accept ? opts.accept(name, size) : true
      opts.onEntry?.(name, size)
      if (!accepted) {
        // 明确跳过：仍然要让 fflate 前进，但不保留任何字节
        file.ondata = () => undefined
        file.start()
        return
      }

      names.push(name)
      sizes.set(name, size)

      if (!opts.keepData || !opts.onChunk) {
        file.ondata = () => undefined
        file.start()
        return
      }

      file.ondata = (err, chunk, final) => {
        if (err) return fail(err)
        // 每块都排进串行链，**不在本地攒数组**
        writes = writes
          .then(() => opts.onChunk?.(name, Buffer.from(chunk), Boolean(final)))
          .catch(fail)
        if (final && chunk.length === 0) {
          // 有些条目最后会来一个空块，交给上面的链处理即可
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)

    const stream = createReadStream(zipPath)
    stream.on('error', fail)
    stream.on('data', (chunk) => {
      if (failed) return
      try {
        unzip.push(chunk as Buffer, false)
      } catch (e) {
        fail(e)
        stream.destroy()
      }
    })
    stream.on('end', () => {
      if (failed) return
      try {
        unzip.push(new Uint8Array(0), true)
      } catch (e) {
        fail(e)
        return
      }
      writes.then(() => resolve({ names, sizes })).catch(fail)
    })
  })
}

/** 第一遍：只收条目名与大小，不保留任何数据。 */
export function listEntries(zipPath: string): Promise<{ names: string[]; sizes: Map<string, number> }> {
  return streamZip(zipPath, { keepData: false })
}

/**
 * 读 zip 中央目录，返回每个条目的名字、压缩方式、压缩后大小与本地头偏移。
 *
 * zip 规范（PKWARE APPNOTE 4.3.12 / 4.3.16）：EOCD 在文件尾部，其最后 4 字节给出
 * 中央目录的大小与偏移；中央目录里每条固定 46 字节头 + 变长的名字/扩展/注释。
 * 全是纯元数据，不解压任何数据。
 *
 * 返回 `null` 表示不是有效 zip。
 */
async function readCentralDirectory(zipPath: string): Promise<
  | { name: string; size: number; method: number; compressedSize: number; localOffset: number }[]
  | null
> {
  const EOCD_SIG = 0x06054b50
  const CDH_SIG = 0x02014b50
  /** EOCD 定长 22 字节 + 最多 64KB 注释。 */
  const TAIL = 22 + 0xffff

  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(zipPath, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    if (size < 22) return null
    const tailLen = Math.min(TAIL, size)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)

    // 从尾部往前找 EOCD（注释长度可变，不能按固定偏移取）
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (!count || cdSize === 0 || cdOff + cdSize > size) return null

    const cdBuf = Buffer.alloc(cdSize)
    await fh.read(cdBuf, 0, cdSize, cdOff)

    const out: {
      name: string
      size: number
      method: number
      compressedSize: number
      localOffset: number
    }[] = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cdBuf.length; i++) {
      if (cdBuf.readUInt32LE(p) !== CDH_SIG) break
      const method = cdBuf.readUInt16LE(p + 10)
      const compressedSize = cdBuf.readUInt32LE(p + 20)
      const usize = cdBuf.readUInt32LE(p + 24)
      const nameLen = cdBuf.readUInt16LE(p + 28)
      const extraLen = cdBuf.readUInt16LE(p + 30)
      const cmtLen = cdBuf.readUInt16LE(p + 32)
      const localOffset = cdBuf.readUInt32LE(p + 42)
      const name = cdBuf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      out.push({ name, size: usize, method, compressedSize, localOffset })
      p += 46 + nameLen + extraLen + cmtLen
    }
    return out.length ? out : null
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * 只读**中央目录**拿条目名与大小 —— 不解压任何数据。
 *
 * `listEntries` 虽然不保留数据，但 fflate 的流式 `Unzip` 遇到不想要的条目仍然会**执行解压**
 * 再把结果丢掉（`ondata` 是空的也得走完 inflate）。600MB 的包光这一遍就白解 600MB。
 * 中央目录是纯元数据，读几十 KB 就够了。
 *
 * 返回 `null` 表示不是有效 zip（交给调用方报 not-a-bundle）。
 */
export async function listEntriesFast(
  zipPath: string
): Promise<{ names: string[]; sizes: Map<string, number> } | null> {
  const cd = await readCentralDirectory(zipPath)
  if (!cd) return null
  return {
    names: cd.map((e) => e.name),
    sizes: new Map(cd.map((e) => [e.name, e.size]))
  }
}

/**
 * 第二遍：把 `want` 里的条目解压到 `destRoot`，边解边写。
 *
 * 调用方必须已经用 `listEntries` 校验过全部路径（zip slip）。
 * `want` 之外的条目直接丢弃，不落盘。
 */
export async function extractTo(
  zipPath: string,
  destRoot: string,
  want: Set<string>,
  onEntry?: (done: number, total: number) => void
): Promise<{ written: number }> {
  let written = 0
  /** 每个条目一个打开的句柄，第一次收到数据时创建，final 时关闭。 */
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>()
  const total = want.size

  const finish = async (name: string): Promise<void> => {
    const h = handles.get(name)
    if (!h) return
    handles.delete(name)
    await h.close()
    written += 1
    onEntry?.(written, total)
  }

  try {
    await streamZip(zipPath, {
      keepData: true,
      accept: (name) => want.has(name),
      onChunk: async (name, chunk, final) => {
        let h = handles.get(name)
        if (!h) {
          const abs = join(destRoot, name)
          await mkdir(dirname(abs), { recursive: true })
          h = await open(abs, 'w')
          handles.set(name, h)
        }
        if (chunk.length) await h.write(chunk)
        if (final) await finish(name)
      }
    })
    // 兜底：没收到 final 的条目（零字节条目常见）也要落一个空文件
    for (const name of [...handles.keys()]) await finish(name)
  } finally {
    // 异常路径：把还开着的句柄关掉，别把文件锁留在 staging 里
    for (const h of handles.values()) await h.close().catch(() => undefined)
    handles.clear()
  }

  return { written }
}

/**
 * 只取出指定的几个**小**条目（`manifest.json`、`secrets.enc`）并留在内存里。
 *
 * ## 为什么不用 streamZip 过滤
 *
 * 流式 `Unzip` 没法真正跳过条目：`accept` 返回 false 时它仍然会走完 inflate 再把结果丢掉。
 * 为拿一个几十 KB 的 `manifest.json` 而解压整个 80MB 包，实测让还原峰值多出约 100MB
 * —— 这是 `verify-bundle-memory.cjs` 的趋势判据抓出来的（体积 ×2 时峰值 ×1.5，不够平）。
 *
 * 现在用中央目录里的 `localHeaderOffset` / `compressedSize` 直接 seek 到该条目，
 * 只读那一小段压缩字节，就地 inflate。开销与包体积无关。
 *
 * 只返回实际找到的条目；缺失的键交给调用方判断（manifest 缺失 = 不是本应用的包）。
 */
export async function readEntriesFor(zipPath: string, names: string[]): Promise<Map<string, Buffer>> {
  const want = new Set(names)
  const out = new Map<string, Buffer>()

  // 先拿中央目录，得到每个条目的位置与压缩方式
  const cd = await readCentralDirectory(zipPath)
  if (!cd) return out

  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(zipPath, 'r')
    for (const e of cd) {
      if (!want.has(e.name)) continue
      if (e.method !== 0 && e.method !== 8) continue // 只支持 store / deflate
      /*
       * `localOffset` 指向**本地文件头**起点，数据在它后面：
       * 本地头固定 30 字节 + 该条目自己的文件名长度 + 扩展字段长度。
       * 中央目录里的 nameLen / extraLen 可能与本地的不同，必须读本地头取真实值。
       */
      const lh = Buffer.alloc(30)
      await fh.read(lh, 0, 30, e.localOffset)
      const lhNameLen = lh.readUInt16LE(26)
      const lhExtraLen = lh.readUInt16LE(28)
      const dataStart = e.localOffset + 30 + lhNameLen + lhExtraLen
      const data = Buffer.alloc(e.compressedSize)
      await fh.read(data, 0, e.compressedSize, dataStart)
      out.set(e.name, e.method === 0 ? data : Buffer.from(inflateSync(data)))
    }
  } catch {
    // 读失败就当没这个条目，交给调用方按"缺 manifest"处理
  } finally {
    await fh?.close().catch(() => undefined)
  }

  return out
}

/** 从 Buffer 直接解出指定条目（给探包等只读场景用，避免重复读盘）。 */
export async function readEntriesFromBuffer(buf: Buffer, names: string[]): Promise<Map<string, Buffer>> {
  const want = new Set(names)
  const out = new Map<string, Buffer>()
  const parts = new Map<string, Buffer[]>()

  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip((file) => {
      if (!want.has(file.name)) {
        file.ondata = () => undefined
        file.start()
        return
      }
      file.ondata = (err, chunk, final) => {
        if (err) return reject(err)
        const arr = parts.get(file.name) ?? []
        arr.push(Buffer.from(chunk))
        parts.set(file.name, arr)
        if (final) out.set(file.name, Buffer.concat(arr))
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    try {
      unzip.push(buf, true)
      resolve()
    } catch (e) {
      reject(e)
    }
  })

  return out
}

/** 写一小段数据到文件（探包等场景一次性写用）。 */
export async function writeSmallFile(absPath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, data)
}
