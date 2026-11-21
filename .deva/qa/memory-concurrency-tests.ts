type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/**
 * 记忆归纳的并发写回（第二批·二）。
 *
 * 三个实证：
 *  ①用户改 A，模型把 A+B 合并到 A：候选保留用户 A 却删了 B，还报 ok:true；
 *  ②预算不足触发归纳，等待期间用户改 / 删 A：归纳正确记为 modified/deleted，但**仍然写回**，
 *    覆盖用户改动或以新 id 复活；
 *  ③最终合并集合 4051/4000 仍写盘成功。
 *
 * 契约：任一已有 id 被改 / 被删，或出现新增 id → **整轮拒绝提交**，原因码与「超限」「模型失败」分开。
 * 无并发冲突时保留原有归纳能力（允许合并、允许删 id）。
 *
 * 这一段跑在 `memcond` 的真实 HTTP 模型桩上（同一个独立进程、同一台本地服务），故由那个场景调用。
 */
export interface MemCondenseHooks {
  /** 重置该作用域为空。 */
  clear: () => void
  /** 新增一条记忆，返回 id（写不进去则抛）。 */
  write: (content: string) => string
  /** 按 id 改写一条（模拟用户在面板里编辑，写不进去则抛）。 */
  update: (id: string, content: string) => void
  list: () => Array<{ id: string; content: string }>
  /** 设下一次模型返回的 JSON。 */
  setReply: (json: string) => void
  /** 模型请求到达、还没回结果的那段时间里执行（模拟用户并发操作）。 */
  setBeforeReply: (fn: (() => void) | null) => void
  /** 调一次「一键整理」IPC。 */
  condense: () => Promise<Record<string, unknown>>
  /** 删一条（模拟用户并发删除）。 */
  remove: (id: string) => void
  /** 直接落一份给定的记忆集合（造「盘上已经超限」这类 writeMemory 拦不住的状态）。 */
  seed: (entries: Array<{ id: string; content: string; createdAt: number; updatedAt: number }>) => void
  eq: Eq
}

export async function memoryConcurrency(h: MemCondenseHooks): Promise<void> {
  const { eq } = h

  // ── ① 等待期间用户改了 A：整轮拒绝，A 保留用户版本，B 一条不少 ──
  {
    h.clear()
    const a = h.write('A：用户原本写的内容')
    const b = h.write('B：另一条要点')
    h.setReply(JSON.stringify({ entries: [{ id: a, content: 'A+B 合并后的版本' }] }))
    h.setBeforeReply(() => {
      // 用户在这条上继续编辑
      h.update(a, 'A：用户刚改过的新内容')
    })
    const r = await h.condense()
    h.setBeforeReply(null)
    eq('memory concurrency: modified entry rejects the whole round', r.ok, false)
    eq('memory concurrency: reason code is concurrent-change', r.ok ? null : r.code, 'concurrent-change')
    eq('memory concurrency: changed ids reported', r.ok ? undefined : r.changed, [a])
    const after = h.list()
    eq('memory concurrency: user edit survives', after.find((e) => e.id === a)?.content, 'A：用户刚改过的新内容')
    eq(
      'memory concurrency: merged-away entry is not silently deleted',
      after.find((e) => e.id === b)?.content,
      'B：另一条要点'
    )
    eq('memory concurrency: model output never written', after.some((e) => /A\+B/.test(e.content)), false)
  }

  // ── ② 等待期间用户删了 A：整轮拒绝，A 不复活，其他条目不被归纳结果改写 ──
  {
    h.clear()
    h.write('C：第一条')
    const doomed = h.write('D：将被用户删掉')
    h.write('E：第三条')
    h.setReply(JSON.stringify({ entries: [{ id: null, content: 'D：将被用户删掉' }] }))
    h.setBeforeReply(() => h.remove(doomed))
    const r = await h.condense()
    h.setBeforeReply(null)
    eq('memory deleted: whole round rejected', r.ok, false)
    eq('memory deleted: reason code is concurrent-change', r.ok ? null : r.code, 'concurrent-change')
    const after = h.list()
    eq('memory deleted: entry stays deleted', after.some((e) => e.id === doomed), false)
    eq('memory deleted: content does not come back under a new id', after.some((e) => e.content === 'D：将被用户删掉'), false)
    eq('memory deleted: other entries untouched', after.length, 2)
  }

  // ── ③ 等待期间别的会话新增一条：整轮拒绝，新条目不能被整体替换抹掉 ──
  {
    h.clear()
    h.write('F：第一条')
    h.write('G：第二条')
    h.setReply(JSON.stringify({ entries: [] }))
    h.setBeforeReply(() => {
      h.write('H：并发写入的新条目')
    })
    const r = await h.condense()
    h.setBeforeReply(null)
    eq('memory added: whole round rejected', r.ok, false)
    eq('memory added: reason code is concurrent-change', r.ok ? null : r.code, 'concurrent-change')
    const after = h.list()
    eq('memory added: concurrent entry survives', after.some((e) => e.content === 'H：并发写入的新条目'), true)
    eq('memory added: nothing was deleted by the rejected round', after.length, 3)
  }

  // ── ④ 无并发：归纳照常生效（允许合并成一条，条目数下降） ──
  {
    h.clear()
    h.write('I：同主题要点一')
    h.write('J：同主题要点二')
    h.write('K：同主题要点三')
    h.setReply(JSON.stringify({ entries: [{ id: null, content: 'IJK：合并成一条同主题要点' }] }))
    const r = await h.condense()
    eq('memory clean: round succeeds', r.ok, true)
    const after = h.list()
    eq('memory clean: merged to one entry', after.length, 1)
    eq('memory clean: merged content written', after[0]?.content, 'IJK：合并成一条同主题要点')
  }

  // ── ⑤ 最终集合仍超预算（含 incoming 预留）：不提交，原因与并发冲突分开 ──
  {
    /*
     * 用 `writeMemory` 造不出超限状态（它自己会拦）。而真实的触发场景正是「盘上已经超了」——
     * 手改文件、旧版本数据、预算被调小，都会得到这种状态。所以这里直接落一份超限文件。
     */
    h.clear()
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: `m_${String(i).padStart(8, '0')}`,
      // 每条 290 字：15 条 ≈ 4500 字，越过 4000 的全局预算
      content: `条目${i}：`.padEnd(290, 'w'),
      createdAt: i + 1,
      updatedAt: i + 1
    }))
    h.seed(entries)
    h.setReply(JSON.stringify({ entries: entries.map((e) => ({ id: e.id, content: e.content })) }))
    const r = await h.condense()
    eq('memory over limit: not committed', r.ok, false)
    eq('memory over limit: reason code is over-limit', r.ok ? null : r.code, 'over-limit')
    eq('memory over limit: entries unchanged', h.list().length, 15)
  }
}
