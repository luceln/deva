/**
 * 真机验证：工作区页「根目录设置」的 IPC 往返。
 *
 * ## 验证什么
 *
 * `redesign/WorktreeRootSetting.tsx` 调 `window.deva.worktree.root()` / `setRoot(value)`，
 * 主进程侧是 `worktree:root` / `worktree:root-set`，实现落在 `services/worktree/root-setting.ts`。
 * 「界面」成员实现时**明确说了没在真实 Electron 里跑过这个往返**，这里补上。
 *
 * ## 为什么必须跑真机而不是 mock
 *
 * `getDevaHome()` / `getConfig()` 都有模块级缓存，`app.setPath` 与 `DEVA_HOME` 只在
 * Electron 主进程真正初始化之后才生效。在 node 里 mock 一遍等于测自己写的 mock。
 *
 * ## 隔离（沿用 `.deva/qa/realmachine/main-runner.ts` 已验证的做法）
 *
 *   1. electron.exe 用**真实** USERPROFILE/APPDATA 启动 —— 启动前改会让 Electron 33
 *      静默退出 0x80000003（实测过）。
 *   2. `app.whenReady()` 之后改写 `process.env.USERPROFILE` / `HOME`，
 *      让 `upstreamHome()` = `join(os.homedir(), '.deva')` 指向临时目录。
 *   3. `app.setPath('appData')` **与** `setPath('userData')` 同时指到临时目录
 *      （只改 userData 会让导入闸门抛 `Failed to get 'appData' path`）。
 *   4. `DEVA_HOME` 由 run-nodepath.cjs 在 spawn 时指到临时目录（那边在 Electron 起来前设，
 *      因为 `getDevaHome()` 第一次读就缓存）。
 *
 * 结果：真实 `C:\Users\lucel\.deva`、`C:\Users\lucel\.deva-plus`、`%APPDATA%\@deva` 一个字节不碰。
 *
 * ## 重启持久化怎么验
 *
 * 同一个进程内无法验证「重启后还在」（缓存会骗人）。所以本脚本分两阶段，由
 * `run-real.cjs` 起两次 Electron：阶段 `write` 设自定义根，阶段 `verify` 只读并核对。
 * `setRoot(undefined)` 的清除同样用 `write` + `verify` 各一轮。
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const RESULT = process.env.QA_RESULT as string
const ROOT = process.env.QA_ROOT as string
const PHASE = process.env.QA_PHASE as string

let fails = 0
const log = (s: string): void => {
  console.log(s)
  try {
    fs.appendFileSync(RESULT, `${s}\n`)
  } catch {}
}
const pass = (n: string, d = ''): void => log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const info = (n: string, d = ''): void => log(`INFO ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n: string, d = ''): void => {
  fails++
  log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const check = (n: string, c: boolean, d = ''): boolean => (c ? pass(n, d) : fail(n, d), c)

/** 归一化比较：Windows 大小写不敏感、尾斜杠不敏感。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 是否落在**真实用户数据**目录里。
 *
 * 注意不能拿「是否在 `C:\Users\lucel` 下」当判据 —— `%TEMP%` 本身就在
 * `C:\Users\lucel\AppData\Local\Temp` 下，那样会把正确的隔离判成违规（本脚本第一版就错了）。
 * 真正不能碰的只有两个数据目录本身。
 */
function underRealUserData(p: string): boolean {
  const norm = (x: string): string => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase()
  const target = norm(p)
  const forbidden = ['C:\\Users\\lucel\\.deva-plus', 'C:\\Users\\lucel\\.deva']
  return forbidden.some((f) => target === norm(f) || target.startsWith(norm(f) + '\\'))
}

const FAKE_HOME = path.join(ROOT, 'home')
const FAKE_APPDATA = path.join(ROOT, 'appdata')
const DEVA_HOME = path.join(ROOT, 'deva-home')
/** 自定义根的候选（在临时目录内、且在 DEVA_HOME 外）。 */
const CUSTOM_ROOT = path.join(ROOT, 'custom-worktrees')

async function main(): Promise<void> {
  info('electron', process.versions.electron ?? '(非 Electron)')
  info('阶段', PHASE)

  const { registerConfigIpc, getDevaHome } = await import(
    '../../../apps/desktop/src/main/services/config'
  )
  const { readWorktreeRoot, setWorktreeRoot } = await import(
    '../../../apps/desktop/src/main/services/worktree/root-setting'
  )
  const { defaultWorktreeRoot, MAX_PATH_LEN } = await import(
    '../../../apps/desktop/src/main/services/worktree/paths'
  )

  // IPC 注册要一个能过类型的最小窗口；本验证直接调函数，注册只为贴近真实启动顺序。
  registerConfigIpc(() => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as any)

  // ── 隔离自检（不通过就立刻停，绝不往真实目录写） ──
  info('被测代码看到的 DEVA_HOME', getDevaHome())
  const isolated = check(
    '隔离生效：DEVA_HOME 在临时目录',
    samePath(getDevaHome(), DEVA_HOME),
    `实际=${getDevaHome()} 期望=${DEVA_HOME}`
  )
  check(
    '隔离生效：DEVA_HOME 不在真实 .deva / .deva-plus 里',
    !underRealUserData(getDevaHome()),
    getDevaHome()
  )
  check(
    '隔离生效：临时根本身也不在真实 .deva / .deva-plus 里',
    !underRealUserData(ROOT),
    ROOT
  )
  if (!isolated) {
    log('=== 隔离未生效，中止（不写任何东西）===')
    app.exit(1)
    return
  }

  if (PHASE === 'write-custom') {
    await phaseWriteCustom()
  } else if (PHASE === 'verify-custom') {
    await phaseVerifyCustom()
  } else if (PHASE === 'write-reset') {
    await phaseWriteReset()
  } else if (PHASE === 'verify-reset') {
    await phaseVerifyReset()
  } else if (PHASE === 'main') {
    await phaseMain()
  } else {
    fail('未知阶段', PHASE)
  }

  log(`=== 阶段 ${PHASE} 结束：FAIL ${fails} ===`)
  app.exit(fails ? 1 : 0)

  // ── 各阶段 ──────────────────────────────────────────────

  /** 第 1 项：`root()` 往返。 */
  async function phaseMain(): Promise<void> {
    const view = readWorktreeRoot()
    info('root() 返回', JSON.stringify(view))
    const expectedDefault = defaultWorktreeRoot()
    check(
      '1. defaultRoot = <DEVA_HOME>/worktrees',
      samePath(view.defaultRoot, path.join(DEVA_HOME, 'worktrees')),
      `实际=${view.defaultRoot}`
    )
    check(
      '1. defaultRoot 与 paths.ts 的 defaultWorktreeRoot() 一致',
      samePath(view.defaultRoot, expectedDefault),
      `view=${view.defaultRoot} fn=${expectedDefault}`
    )
    check('1. 初始 isDefault = true（配置里没这个键）', view.isDefault === true, `isDefault=${view.isDefault}`)
    check('1. 初始 root = defaultRoot', samePath(view.root, view.defaultRoot), `root=${view.root}`)

    // ── 第 2 项：setRoot(自定义) ──
    fs.mkdirSync(CUSTOM_ROOT, { recursive: true })
    const res2: any = setWorktreeRoot(CUSTOM_ROOT)
    info('setRoot(自定义) 返回', JSON.stringify(res2))
    check('2. setRoot(自定义) ok=true', res2?.ok === true, JSON.stringify(res2))
    check('2. 返回 isDefault=false', res2?.isDefault === false, `isDefault=${res2?.isDefault}`)
    check('2. 返回 root = 设置值', res2?.ok === true && samePath(res2.root, CUSTOM_ROOT), `实际=${res2?.root}`)

    const view2 = readWorktreeRoot()
    info('设完再 root()', JSON.stringify(view2))
    check('2. root() 读到 isDefault=false', view2.isDefault === false, `isDefault=${view2.isDefault}`)
    check('2. root() 读到自定义路径', samePath(view2.root, CUSTOM_ROOT), `实际=${view2.root}`)
    check(
      '2. defaultRoot 仍是默认值（不被覆盖）',
      samePath(view2.defaultRoot, path.join(DEVA_HOME, 'worktrees')),
      `实际=${view2.defaultRoot}`
    )

    // 配置文件里应真的写下这个键
    const cfgPath = path.join(DEVA_HOME, 'config.json')
    check('2. config.json 落盘', fs.existsSync(cfgPath), cfgPath)
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      info('config.json 里的 worktreeRoot', String(cfg.worktreeRoot))
      check(
        '2. config.json 的 worktreeRoot = 设置值',
        typeof cfg.worktreeRoot === 'string' && samePath(cfg.worktreeRoot, CUSTOM_ROOT),
        `实际=${cfg.worktreeRoot}`
      )
    }

    // ── 第 4 项：非法路径被拒 ──
    /*
     * 注意实际契约：`setRoot` 的拒绝 reason 是 `outside-repo-required`，
     * 而 `path-outside-root` 是 **precheck**（创建时）的 reason，两者不是同一个枚举。
     * 任务书写的 `path-outside-root` 指向的是 precheck；这里按 setRoot 的真实契约验
     * `outside-repo-required`，并把两者的区别写进报告。
     *
     * 前置条件：`$DEVA_HOME/worktrees.json` 里必须有**一条字段齐全**的记录，否则
     * `knownRepoRoots()` 是空集，任何路径都不会被拒 —— 那样「通过」是假的。
     * 记录由 run-real.cjs 在启动前写好（store 在模块加载时读进内存，进程内写无效）。
     */
    const { listRecords } = await import('../../../apps/desktop/src/main/services/worktree/store')
    const recs = listRecords()
    info('listRecords 条数（第 4 项前置条件）', String(recs.length))
    check(
      '4. 前置条件：已登记仓库被 store 读到',
      recs.length > 0,
      recs.length === 0 ? 'worktrees.json 的记录被逐条校验跳过了，第 4 项无法成立' : `${recs.length} 条`
    )

    const repoInside = path.join(REPO_ROOT, 'apps')
    info('将被拒绝的候选根（仓库内）', repoInside)
    const res4: any = setWorktreeRoot(repoInside)
    info('setRoot(仓库内部) 返回', JSON.stringify(res4).slice(0, 600))
    check(
      '4. 仓库内路径被拒（ok=false）',
      res4?.ok === false,
      `实际=${JSON.stringify(res4).slice(0, 300)}`
    )
    check(
      '4. 拒绝 reason = outside-repo-required',
      res4?.reason === 'outside-repo-required',
      `实际=${res4?.reason}`
    )
    check(
      '4. message 含具体仓库路径',
      typeof res4?.message === 'string' && res4.message.includes(REPO_ROOT),
      String(res4?.message ?? '').slice(0, 300)
    )

    // 拒绝后当前根不得被改动（此时应仍是第 2 项设的自定义根 —— 被拒不等于被清空）
    const viewAfterReject = readWorktreeRoot()
    check(
      '4. 被拒后当前根未被改动（仍是第 2 项设的自定义根）',
      viewAfterReject.isDefault === false && samePath(viewAfterReject.root, CUSTOM_ROOT),
      `root=${viewAfterReject.root} isDefault=${viewAfterReject.isDefault} 期望=${CUSTOM_ROOT}`
    )

    /*
     * 再验一条**同类但不同 reason** 的拒绝：路径深到让
     * `<root>/<repoKey>/<40 字符 slug>-zzzz` 超过 MAX_PATH_LEN(180)。
     * 这条不依赖「仓库内」，但同样需要 knownRepoRoots() 非空才跑得到（校验 2 遍历 repos）。
     */
    const deep = path.join(ROOT, 'deep', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40))
    info('超深候选根长度', String(deep.length))
    const res4b: any = setWorktreeRoot(deep)
    info('setRoot(超深路径) 返回', JSON.stringify(res4b).slice(0, 500))
    check('4b. 超深路径被拒（ok=false）', res4b?.ok === false, `实际=${JSON.stringify(res4b).slice(0, 200)}`)
    check('4b. reason = path-too-long', res4b?.reason === 'path-too-long', `实际=${res4b?.reason}`)
    check(
      '4b. message 含试算出的超限样例路径',
      typeof res4b?.message === 'string' && /[A-Za-z]:\\/.test(res4b.message),
      String(res4b?.message ?? '').slice(0, 300)
    )

    // ── 第 3 项：setRoot(undefined) 恢复默认 ──
    const res3: any = setWorktreeRoot(undefined)
    info('setRoot(undefined) 返回', JSON.stringify(res3))
    check('3. setRoot(undefined) ok=true', res3?.ok === true, JSON.stringify(res3))
    check('3. 返回 isDefault=true', res3?.isDefault === true, `isDefault=${res3?.isDefault}`)
    check(
      '3. 返回 root = defaultRoot',
      res3?.ok === true && samePath(res3.root, path.join(DEVA_HOME, 'worktrees')),
      `实际=${res3?.root}`
    )

    const view3 = readWorktreeRoot()
    info('恢复默认后 root()', JSON.stringify(view3))
    check('3. 恢复后 root() isDefault=true', view3.isDefault === true, `isDefault=${view3.isDefault}`)
    check('3. 恢复后 root() = defaultRoot', samePath(view3.root, view3.defaultRoot), `root=${view3.root}`)

    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      check(
        '3. config.json 里 worktreeRoot 键已被删除（不是空串）',
        !('worktreeRoot' in cfg),
        `键存在=${'worktreeRoot' in cfg} 值=${JSON.stringify(cfg.worktreeRoot)}`
      )
    }

    info('MAX_PATH_LEN', String(MAX_PATH_LEN))
    log(`INFO 真实用户目录未被触碰（本脚本只用 ${ROOT}）`)
  }

  async function phaseWriteCustom(): Promise<void> {
    fs.mkdirSync(CUSTOM_ROOT, { recursive: true })
    const res: any = setWorktreeRoot(CUSTOM_ROOT)
    info('setRoot(自定义) 返回', JSON.stringify(res))
    check('5. 写入自定义根 ok', res?.ok === true, JSON.stringify(res))
    check('5. 写入后 isDefault=false', res?.isDefault === false, `isDefault=${res?.isDefault}`)
    info('重启前 root()', JSON.stringify(readWorktreeRoot()))
  }

  async function phaseVerifyCustom(): Promise<void> {
    const view = readWorktreeRoot()
    info('重启后 root()', JSON.stringify(view))
    check(
      '5. 重启后自定义根仍在',
      view.isDefault === false && samePath(view.root, CUSTOM_ROOT),
      `root=${view.root} isDefault=${view.isDefault}`
    )
    check(
      '5. 重启后 defaultRoot 仍指向 DEVA_HOME 下',
      samePath(view.defaultRoot, path.join(DEVA_HOME, 'worktrees')),
      `实际=${view.defaultRoot}`
    )
  }

  async function phaseWriteReset(): Promise<void> {
    const before = readWorktreeRoot()
    info('恢复前 root()', JSON.stringify(before))
    check('5b. 恢复前确实是自定义态（前置条件）', before.isDefault === false, `isDefault=${before.isDefault}`)
    const res: any = setWorktreeRoot(undefined)
    info('setRoot(undefined) 返回', JSON.stringify(res))
    check('5b. 恢复默认 ok', res?.ok === true, JSON.stringify(res))
  }

  async function phaseVerifyReset(): Promise<void> {
    const view = readWorktreeRoot()
    info('重启后 root()', JSON.stringify(view))
    check(
      '5b. 重启后已回到默认',
      view.isDefault === true && samePath(view.root, view.defaultRoot),
      `root=${view.root} isDefault=${view.isDefault}`
    )
    const cfgPath = path.join(DEVA_HOME, 'config.json')
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      check('5b. config.json 里已无 worktreeRoot 键', !('worktreeRoot' in cfg), JSON.stringify(cfg.worktreeRoot))
    }
  }
}

/** 仓库根（用于构造「根落在仓库内」）。由 run-real.cjs 通过 env 传入。 */
const REPO_ROOT = (process.env.QA_REPO_ROOT as string) || ''

app
  .whenReady()
  .then(() => {
    /*
     * 关键：Electron 已初始化完毕。此时改 USERPROFILE/HOME 与 appData/userData 才有隔离效果，
     * 且不会破坏启动（启动前改会让 Electron 33 静默退出 0x80000003）。
     */
    process.env.USERPROFILE = FAKE_HOME
    process.env.HOME = FAKE_HOME
    for (const key of ['appData', 'userData'] as const) {
      try {
        app.setPath(key, FAKE_APPDATA)
      } catch (e) {
        log(`INFO app.setPath('${key}') 失败：${(e as Error).message}`)
      }
    }
    fs.mkdirSync(FAKE_HOME, { recursive: true })
    fs.mkdirSync(FAKE_APPDATA, { recursive: true })
    fs.mkdirSync(DEVA_HOME, { recursive: true })
    return main()
  })
  .catch((e) => {
    fail('真机场景抛异常', (e as Error)?.stack?.split('\n').slice(0, 8).join(' / ') ?? String(e))
    log(`=== 阶段 ${PHASE} 结束：FAIL ${fails} ===`)
    app.exit(1)
  })