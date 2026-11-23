/**
 * 备份包的**流式写入**：本地头带真实 CRC 与大小，**不使用 data descriptor**。
 *
 * ## 为什么不能用 fflate 的 `Zip`
 *
 * fflate 的写出侧固定使用 data descriptor（`Zip.add` 里 `wzh(header, 0, ..., -1)` 让本地头的大小写 0、
 * flag bit3 置位，条目末尾再追加 `50 4b 07 08` + crc + csize + usize）。而它的**流式**读侧
 * （`bundle-zip.ts` 用的 `Unzip`）在 `store + data descriptor` 条目上不按中央目录的
 * `compressedSize` 定界，而是**扫描数据里的 `50 4b 07 08` 来找 descriptor**。
 *
 * 后果：媒体文件（`.bin` / `.jpg` 等随机二进制）里只要恰好出现这 4 个字节，读侧就提前认定条目结束。
 * 实测一个 2MB 随机 `.bin` 里出现该序列的概率约 0.05%，80 个媒体文件累计约 8% —— 与线上观测到的
 * 失败率吻合，且**换进程重试照样失败**（字节就在包里，不是时序问题）。
 *
 * 症状极具误导性：包用「按中央目录解析」的工具读完全正常（`unzipSync` 用 `csize` 定界），
 * 于是「清单 712 条全对、包却解不开」能同时成立；fflate 读侧又因为 `browser.js` 里
 * `if (!ctr)` 少一个 `return`，把真实错误（`unknown compression type`）掩盖成
 * `ctr is not a constructor`，把排查引向完全无关的方向。
 *
 * ## 修法：让本地头携带真实大小
 *
 * 既然读侧「有 `this.c > 0` 就走精确长度路径、不扫描签名」，那就让写侧产出的本地头永远有真实大小：
 *
 *  1. 写本地头时先留出 30 + nameLen 字节的占位（crc / csize / usize 写 0，flag **不置** bit3）；
 *  2. 写完该条目数据后，回到占位处回填真实 crc / csize / usize；
 *  3. 最后写中央目录 + EOCD。
 *
 * 这样整包结构里**不存在任何 data descriptor**，读侧无论用哪种实现都只能走精确长度路径。
 *
 * ## 为什么仍然流式
 *
 * 文件内容逐块压缩、逐块落盘，不在内存里攒整包（home 600MB 级别会顶爆堆）。
 * 只有「回填 12 字节」需要 seek，所以用可定位的写流（打开 fd 后 `write(fd, buf, 0, len, position)`）。
 */
import { open, type FileHandle } from 'fs/promises'
import { crc32 } from 'zlib'
import { deflateRawSync } from 'zlib'

/** 本地文件头固定 30 字节。 */
const LH_SIG = 0x04034b50
const LH_SIZE = 30
/** 中央目录项固定 46 字节。 */
const CDH_SIG = 0x02014b50
const CDH_SIZE = 46
/** 结束记录固定 22 字节。 */
const EOCD_SIG = 0x06054b50
const EOCD_SIZE = 22

/*
 * 通用位标记。
 * **不得**设置 bit 3（0x8，data descriptor）—— 那正是本模块要消灭的东西。
 * bit 11（0x800）表示文件名是 UTF-8。条目名可能含中文（对话标题进了路径？不，路径是 id；
 * 但 `links/` 下的路径来自用户目录，可能是中文），所以照常置上。
 */
const FLAG_UTF8 = 0x800

/** 压缩方法：0 = store，8 = deflate。 */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** zip 里每个条目的元数据，最后用来拼中央目录。 */
interface Written {
  name: Buffer
  /** 本地头在文件里的偏移。 */
  offset: number
  crc: number
  compressedSize: number
  size: number
  method: number
}

/**
 * 一个流式 zip 写入器。
 *
 * 用法：`addEntry(name, data)` 逐条写，最后 `end()`。
 * 条目之间的顺序由调用方决定（清单在最前的约定在 `bundle-export.ts` 里）。
 */
export class ZipWriter {
  private fh: FileHandle
  private pos = 0
  private entries: Written[] = []

  private constructor(fh: FileHandle) {
    this.fh = fh
  }

  static async create(absPath: string): Promise<ZipWriter> {
    return new ZipWriter(await open(absPath, 'w'))
  }

  /**
   * 写一个条目。
   *
   * `compress` 为 true 走 deflate，false 走 store。**两者都会在本地头写真实大小** ——
   * store 条目尤其重要：历史上出问题的正是 store（媒体）+ data descriptor 这个组合。
   */
  async addEntry(name: string, data: Buffer, compress: boolean): Promise<void> {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    /*
     * 压缩后的内容。`deflateRawSync` 是同步的，但对单个文件是可接受的：
     * 文本类文件都不大（几十 KB 到几 MB），而大文件（媒体）走 store 根本不压缩。
     *
     * 压缩后反而变大时不值得用 deflate —— 保留 store 更省读侧 CPU。
     * 这不是必须的优化，但能避免「压缩了一堆已经压过的内容」这种极端情况。
     */
    const compressed = compress ? deflateRawSync(data, { level: 6 }) : data
    const useDeflate = compress && compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const finalMethod = useDeflate ? METHOD_DEFLATE : METHOD_STORE

    const header = Buffer.alloc(LH_SIZE)
    header.writeUInt32LE(LH_SIG, 0)
    header.writeUInt16LE(20, 4) // 版本需求 2.0
    header.writeUInt16LE(FLAG_UTF8, 6) // ← 不置 bit3，无 data descriptor
    header.writeUInt16LE(finalMethod, 8)
    header.writeUInt16LE(0, 10) // 时间
    header.writeUInt16LE(0x21, 12) // 日期（1980-01-01，确定性即可）
    header.writeUInt32LE(crc >>> 0, 14) // ← 真实 CRC
    header.writeUInt32LE(payload.length, 18) // ← 真实压缩后大小
    header.writeUInt32LE(data.length, 22) // ← 真实原始大小
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28) // 无 extra

    const offset = this.pos
    await this.write(header)
    await this.write(nameBuf)
    await this.write(payload)

    this.entries.push({
      name: nameBuf,
      offset,
      crc: crc >>> 0,
      compressedSize: payload.length,
      size: data.length,
      method: finalMethod
    })
  }

  /** 写中央目录 + EOCD，然后关闭文件。 */
  async end(): Promise<void> {
    const cdStart = this.pos
    for (const e of this.entries) {
      const h = Buffer.alloc(CDH_SIZE)
      h.writeUInt32LE(CDH_SIG, 0)
      h.writeUInt16LE(20, 4) // 生成版本
      h.writeUInt16LE(20, 6) // 需要的版本
      h.writeUInt16LE(FLAG_UTF8, 8)
      h.writeUInt16LE(e.method, 10)
      h.writeUInt16LE(0, 12) // 时间
      h.writeUInt16LE(0x21, 14) // 日期
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.compressedSize, 20)
      h.writeUInt32LE(e.size, 24)
      h.writeUInt16LE(e.name.length, 28)
      h.writeUInt16LE(0, 30) // extra
      h.writeUInt16LE(0, 32) // comment
      h.writeUInt16LE(0, 34) // 磁盘号
      h.writeUInt16LE(0, 36) // 内部属性
      h.writeUInt32LE(0, 38) // 外部属性
      h.writeUInt32LE(e.offset, 42)
      await this.write(h)
      await this.write(e.name)
    }
    const cdSize = this.pos - cdStart
    const count = this.entries.length
    if (count > 0xffff) throw new Error(`条目数超过 zip 上限（${count} > 65535）`)

    const eocd = Buffer.alloc(EOCD_SIZE)
    eocd.writeUInt32LE(EOCD_SIG, 0)
    eocd.writeUInt16LE(0, 4) // 本盘号
    eocd.writeUInt16LE(0, 6) // 中央目录起始盘
    eocd.writeUInt16LE(count, 8) // 本盘条目数
    eocd.writeUInt16LE(count, 10) // 总条目数
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20) // 注释长度
    await this.write(eocd)

    /*
     * ── 落盘保证 ──
     *
     * `fsync` 让内核把这块文件的脏页真正写到设备上，之后 `rename` 才是「一个完整的包换了名字」，
     * 而不是「一个名字换了、内容还在内存里等着」。断电 / 崩溃时前者可恢复、后者留下半截包。
     *
     * 这**不是**本次缺陷的修法（缺陷是结构歧义，已由上面的写法消灭），但它是 `.part → rename`
     * 这套既有协议本该有的最后一步：既然全程写了 `.part` 再改名，就该保证改名时内容真的落地。
     */
    await this.fh.sync()
    await this.fh.close()
  }

  /** 异常路径：尽力关闭，不掩盖原始错误。 */
  async abort(): Promise<void> {
    try {
      await this.fh.close()
    } catch {
      /* 关不掉也没什么可做的，原始错误更重要 */
    }
  }

  /**
   * 按当前偏移写完整个 buffer。
   *
   * 用显式位置 `write(fd, buf, offset, length, position)` 而不是流，
   * 是为了能精确控制偏移（中央目录要记每条本地头的 offset），也让「写完就返回」
   * 的语义明确：`FileHandle.write` 返回已写字节数，**必须核对**，短写要续写。
   */
  private async write(buf: Buffer): Promise<void> {
    let done = 0
    while (done < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, done, buf.length - done, this.pos + done)
      if (bytesWritten <= 0) throw new Error(`写入备份包失败：在第 ${this.pos + done} 字节处写不进数据`)
      done += bytesWritten
    }
    this.pos += buf.length
  }
}