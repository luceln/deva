import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import type { AssocReport } from '../shared/import-protocol'

/**
 * 导入第 ⑦ 步：四类附件（media / checkpoints / subagents / tool-results，约 170 MB）。
 *
 * ⚠️ **必须在会话落盘之后调用，且同一轮内完成**。启动时有三个清扫（index.ts 的 sweepCheckpoints /
 * sweepSubagents / sweepMedia）：它们删「id 不在会话列表里的」目录与「没被任何会话引用的」blob，宽限期只有 1 小时。
 * 先搬附件、会话还没到位的话，下次启动这些附件就被当垃圾清掉——不报错，用户只看到图片变成「数据已丢失」、
 * 回滚面板说「备份已缺失」。
 *
 * 目录名规则（都与 chat-store 的 safeId 同一白名单）：
 *  - `checkpoints/<safeId(sessionId)>/…`（checkpoints.ts）
 *  - `subagents/<safeId(sessionId)>/*.json`（subagent-store.ts）
 *  - `tool-results/<safeName(sessionId)>/*.txt`（tool-results.ts，空 id 归 `_misc`）
 *  - `media/<sha256>`：内容寻址的 blob，按文件名复制即可，天然不会冲突
 *
 * 一律「目标已存在就跳过」，不做内容比对——与其它步骤同一套幂等口径。
 */

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

/** 复制目录下所有**直接子项**（文件按字节、目录递归），返回复制了几项顶层条目。 */
function copyChildren(srcDir: string, dstDir: string): number {
  let names: string[]
  try {
    names = readdirSync(srcDir)
  } catch {
    return 0 // 源目录不存在
  }
  let n = 0
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch {
    return 0
  }
  for (const name of names) {
    if (!safeName(name) && name !== '_misc') continue // 只收白名单名，防穿越
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    try {
      const st = statSync(from)
      if (st.isDirectory()) {
        if (existsSync(to)) continue // 已有该会话的目录：不合并覆盖
        cpSync(from, to, { recursive: true })
        n++
      } else if (st.isFile()) {
        if (existsSync(to)) continue
        copyFileSync(from, to)
        n++
      }
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  return n
}

/**
 * 复制四类附件。返回各类实际复制的条目数（各层的"顶级条目"：一个会话目录算 1、一个 blob 算 1）。
 * 不做引用过滤：全量复制最简单也最安全（引用扫描是优化项，不是第一版验收项）。
 */
export function copyAssoc(
  srcHome: string,
  onProgress?: (done: number, total: number) => void
): AssocReport {
  const srcData = join(srcHome, 'data')
  const dstData = join(getDevaHome(), 'data')
  const report: AssocReport = { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 }

  // media：单个 blob 文件，量大（数百个），逐个报进度
  const srcMedia = join(srcData, 'media')
  let mediaNames: string[] = []
  try {
    mediaNames = readdirSync(srcMedia)
  } catch {
    mediaNames = []
  }
  if (mediaNames.length) {
    const dstMedia = join(dstData, 'media')
    try {
      mkdirSync(dstMedia, { recursive: true })
    } catch {
      /* 建不出就没法复制，下面逐个 try 兜底 */
    }
    let done = 0
    for (const name of mediaNames) {
      onProgress?.(done, mediaNames.length)
      done++
      const to = join(dstMedia, name)
      try {
        if (existsSync(to)) continue
        copyFileSync(join(srcMedia, name), to)
        report.media++
      } catch {
        /* 单个 blob 失败：对应的图片就是缺失，但不该中断整轮 */
      }
    }
    onProgress?.(mediaNames.length, mediaNames.length)
  }

  // checkpoints / subagents / tool-results：按会话目录为单位
  report.checkpoints = copyChildren(join(srcData, 'checkpoints'), join(dstData, 'checkpoints'))
  report.subagents = copyChildren(join(srcData, 'subagents'), join(dstData, 'subagents'))
  report.toolResults = copyChildren(join(srcData, 'tool-results'), join(dstData, 'tool-results'))
  return report
}
