/**
 * 真机验证（方案 C，最接近用户实际场景）：
 * **完整跑一次 runImport()，在导入进行中真的往一个会话里发消息并落盘。**
 *
 * 如何做到隔离（不改源码）：
 *   - 源：`upstreamHome()` = `join(os.homedir(), '.deva')`，而 `os.homedir()` 在 Windows 上读进程的
 *     `USERPROFILE`。所以**在 Electron 启动之后**（GUI 已初始化，不受影响）改写 `process.env.USERPROFILE`，
 *     就能让被测代码的源指向临时目录。
 *   - lockfile：`upstreamLockPath()` = `app.getPath('appData') + '@deva/desktop/lockfile'`。用
 *     `app.setPath('appData', ...)` 指到临时目录，闸门就不会碰到真实原版那个正被占用的锁。
 *   - 目标：`DEVA_HOME` 指到临时目录（被测代码自己支持）。
 * 这样真实 `~/.deva` / `~/.deva-plus` 一个字节都不会被碰。
 *
 * 这不是模拟：runImport 是真函数整个跑完，save() 是真实 chat-store，文件系统是真的，
 * 跑在 electron.exe 主进程里。唯一的「非 GUI」之处是没有渲染层界面。
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const RESULT = process.env.QA_RESULT as string
const ROOT = process.env.QA_ROOT as string

let fails = 0
const log = (s: string): void => {
  console.log(s)
  try {
    fs.appendFileSync(RESULT, `${s}\n`)
  } catch {}
}
const pass = (n: string, d = ''): void => log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n: string, d = ''): void => {
  fails++
  log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const info = (n: string, d = ''): void => log(`INFO ${n}${d ? ` :: ${d}` : ''}`)
const check = (n: string, c: boolean, d = ''): boolean => (c ? pass(n, d) : fail(n, d), c)
const eq = (n: string, a: unknown, e: unknown): boolean => {
  const A = JSON.stringify(a)
  const E = JSON.stringify(e)
  return check(n, A === E, A === E ? A : `实际=${A} 期望=${E}`)
}
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}
function writeJson(p: string, v: unknown): void {
  mkdirp(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}

const FAKE_HOME = path.join(ROOT, 'home')
const FAKE_APPDATA = path.join(ROOT, 'appdata')
const DST = path.join(ROOT, 'dst')
const SRC = path.join(FAKE_HOME, '.deva')

async function main(): Promise<void> {
  info('electron', process.versions.electron ?? '(非 Electron)')

  const { runImport } = await import('../../../apps/desktop/src/main/importer')
  const { registerConfigIpc, getDevaHome } = await import('../../../apps/desktop/src/main/services/config')
  const { ensureSession, save, listSessions, invalidateIndexOnly } = await import(
    '../../../apps/desktop/src/main/services/chat-store'
  )
  const { canImport, upstreamHome } = await import('../../../apps/desktop/src/main/importer-gate')

  info('被测代码看到的源（upstreamHome）', upstreamHome())
  info('被测代码看到的目标（getDevaHome）', getDevaHome())
  eq('隔离生效：源在临时目录', upstreamHome(), SRC)
  eq('隔离生效：目标在临时目录', getDevaHome(), DST)

  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)

  // ── 造源数据：让导入有实际工作量（每一类都有一点） ──
  writeJson(path.join(SRC, 'config.json'), {
    models: {
      providers: [
        { id: 'imp-a', name: 'A', apiHost: 'https://a.invalid', models: [{ id: 'm1', name: 'm1' }] },
        { id: 'imp-b', name: 'B', apiHost: 'https://b.invalid', models: [] }
      ],
      activeModelId: 'imp-a:m1'
    }
  })
  writeJson(path.join(SRC, 'secrets.json'), { 'imp-a': Buffer.from('enc:sk-a').toString('base64') })
  writeJson(path.join(SRC, 'memory.json'), { version: 1, entries: [{ id: 'm_1', content: '源里的记忆' }] })
  mkdirp(path.join(SRC, 'personas'))
  fs.writeFileSync(path.join(SRC, 'personas', 'role-x.md'), '---\nid: role-x\nname: X\n---\nhi')
  for (let i = 0; i < 12; i++) {
    writeJson(path.join(SRC, 'data', 'chats', `up-${i}.json`), {
      id: `up-${i}`,
      title: `up ${i}`,
      messages: [{ role: 'user', content: `hello ${i}` }],
      updatedAt: Date.now()
    })
  }
  mkdirp(path.join(SRC, 'data', 'media'))
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(SRC, 'data', 'media', String(i).padStart(64, 'a')), `blob-${i}`)
  }
  for (const kind of ['checkpoints', 'subagents', 'tool-results']) {
    const d = path.join(SRC, 'data', kind, 'up-0')
    mkdirp(d)
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(d, `f${i}`), `x${i}`)
  }

  // 闸门应当在源就位后放行（临时 appData 里没有 lockfile）
  const gate: any = await canImport()
  info('闸门', JSON.stringify(gate).slice(0, 200))
  check('闸门放行（源已就位、没被真实原版的 lockfile 干扰）', gate.ok === true, JSON.stringify(gate).slice(0, 160))
  check('闸门确认源就是临时目录', gate.ok === true && path.resolve(gate.sourceHome ?? '') === path.resolve(SRC), JSON.stringify(gate.sourceHome))

  // ── 真机起点：一个正在跑的对话（与 chat-turns.ts:341 同款：持有对象引用） ──
  mkdirp(DST)
  const live = ensureSession('live-during-import')
  live.messages.push({ role: 'user', content: 'A：导入开始前发的' } as any)
  save('live-during-import')
  const chatFile = path.join(DST, 'data', 'chats', 'live-during-import.json')
  eq('起点：A 已落盘', JSON.parse(fs.readFileSync(chatFile, 'utf8')).messages.length, 1)

  // ── 真跑完整导入，在进度回调里（= 导入进行中）发消息并落盘 ──
  const during: string[] = []
  let n = 1
  const report: any = await runImport((p) => {
    // 每一次进度推进都是一次「导入正跑着」的真实时刻；在这里写消息
    const text = `导入进行中(${p.step})第${n}条`
    live.messages.push({ role: 'assistant', content: text } as any)
    save('live-during-import')
    during.push(text)
    n++
  })
  info('导入期间写入次数', String(during.length))
  info('导入报告', JSON.stringify({ ok: report.ok, providers: report.providers?.copied, sessions: report.sessions?.copied?.length, assoc: report.assoc }))

  check('导入成功', report.ok === true, JSON.stringify(report.failures).slice(0, 200))
  check('导入期间确实写过多条（测试有效）', during.length >= 3, `during=${during.length}`)

  // 收尾之后再写一条
  const after = '收尾之后发的'
  live.messages.push({ role: 'user', content: after } as any)
  save('live-during-import')

  // ── 从磁盘读回 ──
  const disk = JSON.parse(fs.readFileSync(chatFile, 'utf8'))
  const contents: string[] = disk.messages.map((m: any) => m.content)
  info('磁盘条数', String(contents.length))
  info('磁盘前两条', JSON.stringify(contents.slice(0, 2)))
  info('磁盘最后两条', JSON.stringify(contents.slice(-2)))

  eq('真机：总条数 = 1 + 导入期间 + 收尾后', contents.length, 1 + during.length + 1)
  const missing = during.filter((t) => !contents.includes(t))
  check('真机：导入期间写的消息一条没丢', missing.length === 0, `缺=${JSON.stringify(missing.slice(0, 3))}`)
  check('真机：收尾之后的消息也写进去了', contents.includes(after))
  eq('真机：内存对象与磁盘一致', live.messages.length, contents.length)

  // ── 导入成果同时在盘上 ──
  const dstChats = fs.readdirSync(path.join(DST, 'data', 'chats')).filter((x) => x.endsWith('.json') && x !== '_index.json')
  info('目标会话文件数', String(dstChats.length))
  eq('导入成果：12 个会话 + 自己那 1 个', dstChats.length, 13)
  eq('导入成果：服务商都进来了', report.providers.copied.sort(), ['imp-a', 'imp-b'])
  eq('导入成果：media 全部进来', report.assoc.media, 30)

  // ── 列表刷新（索引失效后能扫到导入的会话） ──
  invalidateIndexOnly()
  const listed = listSessions()
  info('listSessions 数量', String(listed.length))
  eq('列表能扫到导入的全部会话', listed.length, 13)
  check('列表里能看到导入的 up-0', listed.some((s) => s.id === 'up-0'))

  log(`=== 真机场景结束：FAIL ${fails} ===`)
  app.exit(fails ? 1 : 0)
}

app
  .whenReady()
  .then(() => {
    // 关键：Electron 已初始化完毕，此时改这两个才有隔离效果且不破坏启动
    process.env.USERPROFILE = FAKE_HOME
    process.env.HOME = FAKE_HOME
    try {
      app.setPath('appData', FAKE_APPDATA)
    } catch (e) {
      log(`INFO app.setPath('appData') 失败：${(e as Error).message}`)
    }
    return main()
  })
  .catch((e) => {
    fail('真机场景抛异常', (e as Error)?.stack?.split('\n').slice(0, 8).join(' / ') ?? String(e))
    log(`=== 真机场景结束：FAIL ${fails} ===`)
    app.exit(1)
  })
