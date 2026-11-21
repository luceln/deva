import { ipcMain } from 'electron'
import type { CompactModelConfig } from './compaction'
import { condenseMemories, type CondenseResult, type SkippedEntry } from './memory-consolidate'
import { GLOBAL_SCOPE, listMemories, type MemoryScope } from './memory'
import { resolveDefaultModel } from './model-resolve'
import { resolveAvailability } from './model-availability'
import { readSecret } from './secrets'
import { projectMemoryRootOf } from './worktree/scope'

/**
 * 「一键整理记忆」的 IPC（导入报告里那个按钮）。
 *
 * ## 为什么单独一个模块
 *
 * 归属判定与提示词在 `memory-consolidate.ts`，但「这个模型现在到底能不能用」属于另一件事：
 * 要看配置（provider / model 在不在、是否停用）、还要看密钥能不能读出来。把这些塞进 `memory.ts`
 * 会让那个模块反向依赖 model-resolve / secrets，而 `memory-consolidate` 已经依赖 `memory`——
 * 容易绕成环。这里只做**编排**：判可用性 → 组 CompactModelConfig → 调 condense。
 *
 * ## 为什么模型可用性要提前判，而且判得比 `resolveAvailability` 多一层
 *
 * `resolveAvailability` 只看配置（provider 存在、未停用、model 存在、未停用），**不看密钥**。
 * 而 `streamChat` 在发起请求时才 `readSecret`，密钥解不开会当场 yield 一个 auth 错误。
 * 用户点的是「一键整理」，如果密钥坏了却跑进去了，他会先等模型超时 / 拿到一个 401 才看到失败——
 * 而这个失败完全可以在点按钮的瞬间就说清楚。
 *
 * ⚠️ **`absent` 不能判成不可用**：`streamChat` 对 `absent` 是「以空串继续」——本地 Ollama 这类
 * 无钥服务靠它工作。这里若把 `absent` 当失败，本地模型用户就永远点不了这个按钮。
 * 只有 `unreadable`（有密文但解不开）与 `store-unreadable`（整份密钥库读不出来）才是真不可用，
 * 与 `streamChat` 的判定**保持同一口径**。
 */

/** 压缩结果的 IPC 形状：比内部的 `CondenseResult` 多带一份整理后的快照，界面不用再拉一次。 */
export type CondenseIpcResult =
  | {
      ok: true
      /** 压缩前：条数 / 字数。 */
      before: { count: number; used: number }
      /** 压缩后：条数 / 字数。 */
      after: { count: number; used: number }
      /** 腾出多少字（可能为负：模型没按要求压）。 */
      freed: number
      /** 被改动或删除的旧条目数。 */
      changed: number
      /** 是否真的腾出了空间。`false` 时界面**不要**说「已腾出空间」。 */
      freedSpace: boolean
      /**
       * 归纳结果里被跳过的条目：等待模型返回期间，这些条目被用户改过（`modified`）或删掉（`deleted`）。
       *
       * 必须回传：跳过意味着「这次整理对这几条没生效」。静默吞掉的话，用户看到「已整理」却发现
       * 某条既没被压、也没按他的新值显示，无从判断是模型没做还是系统挡了。
       */
      skipped: SkippedEntry[]
      /** 用哪个模型做的（`providerId:modelId`），便于用户确认。 */
      model: string
    }
  | {
      ok: false
      code: 'empty' | 'model-unavailable' | 'failed' | 'aborted' | 'concurrent-change' | 'over-limit'
      /** 给用户看的一句话（可直接显示；技术细节更全的说明放 detail）。 */
      reason: string
      /** 技术定位（provider id / 错误信息），供排查；界面可折叠显示。 */
      detail?: string
      /**
       * 只有 `concurrent-change` 会带：等待模型期间被改动 / 删除的条目 id。
       * 用户要知道是哪几条变了，否则「没提交」看起来像系统抽风。
       */
      changed?: string[]
    }

/**
 * 挑一个能用的模型来做整理。
 *
 * 为什么用「当前默认模型」（`config.models.activeModelId`）而不是让界面选：这个按钮的语义是
 * 「顺手帮我压一下」，用户不该先做一次模型选择。默认模型是他最近在用的那个，最可能可用。
 *
 * 三层判定，任一不过就返回原因：
 *  1. 配置里有没有这个 provider / model（`resolveDefaultModel` 严格解析，停用的也算没有）；
 *  2. 可用性（`resolveAvailability`，额外区分 malformed / missing / disabled / model-disabled）；
 *  3. 密钥能不能读（`readSecret` 的三态，`absent` 放行）。
 */
async function pickModel(): Promise<
  { ok: true; model: CompactModelConfig; ref: string } | { ok: false; reason: string; detail: string }
> {
  const resolved = resolveDefaultModel()
  if (!resolved) {
    return {
      ok: false,
      reason: '当前没有可用的默认模型，请先在「设置 › 模型」里选一个',
      detail: 'config.models.activeModelId 为空或指向不存在的服务商/模型'
    }
  }
  const ref = `${resolved.providerId}:${resolved.model}`
  const avail = await resolveAvailability(ref)
  if (!avail.ok) {
    /*
     * 文案分两种：`kind` 是给界面出 i18n 的，但这里只有主进程，所以直接给一句人能读的话。
     * `model-disabled` 与 `disabled` 的处置完全不同（一个去启用模型，一个去启用服务商），分开说。
     */
    const why =
      avail.kind === 'disabled'
        ? '服务商被停用了'
        : avail.kind === 'model-disabled'
          ? '这个模型被停用了'
          : '服务商或模型不存在'
    return {
      ok: false,
      reason: `默认模型不可用（${why}），请先在「设置 › 模型」里换一个`,
      detail: `${ref}：${avail.detail ?? avail.kind}`
    }
  }
  const secret = await readSecret(resolved.providerId)
  if (secret.kind === 'unreadable' || secret.kind === 'store-unreadable') {
    /*
     * 与 streamChat 同口径：这两种才拦。`absent` 放行（本地模型）。
     * 提示要指向「重填密钥」而不是「换模型」——换模型解决不了密钥坏掉这件事。
     */
    return {
      ok: false,
      reason: `读不出「${resolved.providerId}」的密钥，请在「设置 › 模型」里重新填一次`,
      detail: `${ref}：${secret.reason}`
    }
  }
  return {
    ok: true,
    ref,
    model: {
      adapter: resolved.adapter,
      providerId: resolved.providerId,
      baseURL: resolved.baseURL,
      model: resolved.model
    }
  }
}

/** 与 memory.ts 的 `ipcScope` 同一口径：省略 root = 全局记忆；给出 = 该项目工作区的项目私有记忆。 */
function ipcScope(root: unknown): MemoryScope {
  if (root === undefined || root === null) return GLOBAL_SCOPE
  if (typeof root === 'string' && root.trim()) {
    const trimmed = root.trim()
    return { kind: 'project', root: projectMemoryRootOf(trimmed) ?? trimmed }
  }
  throw new Error('memory: invalid root')
}

/**
 * 注册「一键整理记忆」。
 *
 * 参数与 `memory:list` / `memory:clear` 同一形状（末位可选 root），界面按现有约定传即可。
 *
 * ⚠️ **这是破坏性操作**（会改 / 删用户的记忆条目）。返回值因此把「动了什么」全部带出来：
 * 压缩前后条数与字数、动了几条、有没有真腾出空间。界面必须如实显示 `freedSpace === false`
 * 的情况——模型没压下去时说「已腾出空间」比不压更糟。
 */
export function registerMemoryCondenseIpc(): void {
  ipcMain.handle(
    'memory:condense',
    async (_e, root?: string): Promise<CondenseIpcResult> => {
      const scope = ipcScope(root)
      /*
       * 先看有没有东西可压：空作用域连模型都不用挑。放在 pickModel 之前——
       * 「项目记忆还是空的」这种提示比「模型不可用」更贴近用户此刻的处境。
       */
      if (listMemories(scope).length === 0) {
        return { ok: false, code: 'empty', reason: '这里还没有记忆条目，不需要整理' }
      }
      const picked = await pickModel()
      if (!picked.ok) {
        return { ok: false, code: 'model-unavailable', reason: picked.reason, detail: picked.detail }
      }
      let r: CondenseResult
      try {
        r = await condenseMemories(scope, picked.model)
      } catch (e) {
        // condenseMemories 内部已兜住大部分失败，这里只接住意外（例如 listMemories 抛错）
        return {
          ok: false,
          code: 'failed',
          reason: '整理过程中出错，记忆未被修改',
          detail: (e as Error)?.message ?? String(e)
        }
      }
      if (!r.ok) {
        return {
          ok: false,
          code: r.code,
          reason: r.code === 'empty' ? '这里还没有记忆条目，不需要整理' : r.reason,
          ...(r.changed ? { changed: r.changed } : {})
        }
      }
      return {
        ok: true,
        before: r.before,
        after: r.after,
        freed: r.freed,
        changed: r.changed,
        freedSpace: r.freedSpace,
        skipped: r.skipped,
        model: picked.ref
      }
    }
  )
}
