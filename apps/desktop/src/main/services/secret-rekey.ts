import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

/**
 * 跨应用密钥重加密（导入时把原版 Deva 的密文转成本应用可解的）。
 *
 * ## 为什么必须重加密（而不是复制密文）
 *
 * `safeStorage` 在 Windows 上产出 `v10` + AES-256-GCM 密文，那把 AES 密钥用 DPAPI 保护后存在
 * **各应用自己的** `userData/Local State` 的 `os_crypt.encrypted_key` 里；macOS 则是按应用隔离的
 * Keychain 项。原版 Deva（`name: @deva/desktop` → `Roaming/@deva/desktop`）与 DevaPlus
 * （`Roaming/DevaPlus`）是两个 app，密钥不同，**复制过去的密文必然解不开**。
 *
 * 实测证据：两者 `os_crypt.encrypted_key` 逐字节不同；用 DevaPlus 身份 `decryptString` 解原版密文抛
 * `Error while decrypting the ciphertext`，而把 userData 指到原版目录后立刻解密成功。
 *
 * ## 为什么要起子进程
 *
 * 本进程的 userData 已经定死（改不回去，`safeStorage` 的密钥在 ready 时就绑上了），所以只能另起一个
 * Electron 进程，在它 `whenReady()` 之前把 userData 指到原版目录 —— 见 `resources/secret-rekey-helper.cjs`。
 *
 * ## 失败一律降级，不抛
 *
 * 原版没装 / 目录不在 / helper 超时 / 解密失败，全部返回结构化的失败码，由导入报告**明确告知**
 * 用户去「设置 › 模型」重填。绝不静默写进一堆解不开的密文——那正是这次要修的 bug。
 */

/** helper 脚本位置：开发时在 `resources/`，打包后在 `process.resourcesPath`（extraResources 复制过去）。 */
function helperPath(): string {
  const packed = join(process.resourcesPath ?? '', 'secret-rekey-helper.cjs')
  if (existsSync(packed)) return packed
  /*
   * 开发 / 未打包：仓库里的 `apps/desktop/resources/`。
   *
   * `app.getAppPath()` 在打包运行时是 `…/resources/app.asar`（旁边就是 extraResources 落地的
   * `secret-rekey-helper.cjs`，上面那行已经命中）；在开发与 QA 进程里它可能是仓库根，
   * 而资源实际在 `apps/desktop/resources/` 下——两个都试一遍，比猜一个准。
   */
  const candidates = [
    join(app.getAppPath(), 'resources', 'secret-rekey-helper.cjs'),
    join(app.getAppPath(), 'apps', 'desktop', 'resources', 'secret-rekey-helper.cjs'),
    join(__dirname, '..', '..', '..', 'resources', 'secret-rekey-helper.cjs')
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/**
 * 原版 Deva 的 userData 目录。
 *
 * 原版 `apps/desktop/package.json` 的 `name` 是 `@deva/desktop`（Electron 用 `app.getName()` 定 userData，
 * 有 productName 时用 productName、否则用 name；原版没有 productName）。实测本机确实存在
 * `Roaming/@deva/desktop/Local State`，且用它能解开 `~/.deva/secrets.json` 里的密文。
 *
 * 同时试 `Deva` / `deva-desktop` 两个历史名字：Electron 早期版本与上游改名前可能留下过别的目录，
 * 多探两个不花什么代价，少探一个就可能判成「原版没装」。
 */
export function legacyUserDataCandidates(): string[] {
  const appData = app.getPath('appData')
  return [
    join(appData, '@deva', 'desktop'),
    join(appData, 'Deva'),
    join(appData, 'deva-desktop')
  ].filter((p) => existsSync(join(p, 'Local State')))
}

export type RekeyFailCode =
  /** 找不到原版的 userData（原版没装 / 没运行过） */
  | 'legacy-not-found'
  /** helper 脚本缺失（打包漏了 extraResources） */
  | 'helper-missing'
  /** 本机没有可用的加密存储 */
  | 'no-encryption'
  /** helper 起不来 / 超时 / 崩溃 */
  | 'helper-failed'
  /** helper 返回了不合协议的东西 */
  | 'helper-bad-output'

export type RekeyResult =
  | { ok: true; plaintexts: Array<string | null>; legacyUserData: string }
  | { ok: false; code: RekeyFailCode; detail?: string }

/** 超时：解开 N 条密文是纯 CPU，正常几十毫秒；给 15 秒容忍冷启动 + 杀软扫描。 */
const HELPER_TIMEOUT_MS = 15_000

/**
 * 在**原版上下文**里解密一批密文。
 *
 * 返回的 `plaintexts` 与输入等长，单条解不开的位置是 `null`（不影响其余）。
 * **调用方拿到后必须立刻用本应用的 safeStorage 重新加密，不要落盘、不要记日志。**
 */
export async function decryptAsLegacy(
  ciphertexts: string[],
  opts: { legacyUserData?: string; execPath?: string } = {}
): Promise<RekeyResult> {
  if (!ciphertexts.length) return { ok: true, plaintexts: [], legacyUserData: '' }
  const candidates = opts.legacyUserData ? [opts.legacyUserData] : legacyUserDataCandidates()
  if (!candidates.length) return { ok: false, code: 'legacy-not-found' }

  const script = helperPath()
  if (!existsSync(script)) return { ok: false, code: 'helper-missing', detail: script }

  /*
   * `execPath` 默认就是当前进程的可执行文件（打包后是 DevaPlus.exe，即 Electron 主二进制），
   * 这是唯一能保证「版本与当前应用一致」的来源。
   *
   * 但有两个场景它**不是** Electron：开发期用 `tsx` / `node` 直接跑主进程代码、以及 QA 套件
   * （`.deva/qa` 全是 node 脚本，`safeStorage` 也是桩）。这时 `require('electron')` 在子进程里
   * 拿到 undefined，helper 直接崩。所以留 `DEVA_ELECTRON_BIN` 让调用方指定二进制
   * （与 `clearSizeCacheForTest` 等测试专用出口同一风格）。
   */
  const execPath = opts.execPath ?? process.env.DEVA_ELECTRON_BIN ?? process.execPath

  /*
   * 逐个候选目录试：第一个能解开**至少一条**的就用它。
   * 为什么要试多个：历史版本的 app 名可能不同（`@deva/desktop` / `Deva`），猜错一个就判
   * 「原版没装」太武断——那会让本来能修好的密钥白白落进 `unrecoverable`。
   */
  let lastFail: RekeyResult = { ok: false, code: 'helper-failed' }
  for (const userData of candidates) {
    const r = await runHelper(execPath, script, userData, ciphertexts)
    if (!r.ok) {
      lastFail = r
      continue
    }
    if (r.plaintexts.some((p) => p !== null))
      return { ok: true, plaintexts: r.plaintexts, legacyUserData: userData }
    // 全是 null：这个目录不对（或密文真的坏了），换下一个候选
    lastFail = { ok: false, code: 'helper-failed', detail: 'all-null' }
  }
  return lastFail
}

/** 起一个 Electron 子进程跑 helper，把请求从 stdin 送进去、从 stdout 读一行 JSON。 */
function runHelper(
  execPath: string,
  script: string,
  userData: string,
  ciphertexts: string[]
): Promise<RekeyResult> {
  return new Promise((resolve) => {
    let child
    try {
      /*
       * 必须把 `ELECTRON_RUN_AS_NODE` 从 env 里**删掉**，不能设成 `undefined`：
       * Node 的 spawn 会把 `undefined` 字符串化成 `"undefined"`，而 Electron 只判断「这个变量在不在」
       * ——在就是以纯 node 模式启动，`require('electron')` 拿到的是路径字符串，`app` 为 undefined，
       * helper 直接崩在 `app.whenReady()`。
       *
       * 场景：用户从本应用内部触发导入时，父进程本身可能带着这个变量（utility process / 测试环境），
       * 不删就会把它传下去。
       */
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      /* 密文走 argv（不敏感：没有对应的 Local State 密钥解不开）；**明文只走 stdout** —— 放 argv 会进
       * 进程列表，任何本机进程都能看到。 */
      child = spawn(execPath, [script, userData, ...ciphertexts], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      resolve({ ok: false, code: 'helper-failed', detail: (e as Error)?.message ?? String(e) })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const finish = (r: RekeyResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, code: 'helper-failed', detail: 'timeout' }),
      HELPER_TIMEOUT_MS
    )
    timer.unref?.()

    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
    })
    // stderr 只用来判断「崩没崩」，内容不进返回值（可能含路径）
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 4000) err += b.toString()
    })
    child.on('error', (e) =>
      finish({ ok: false, code: 'helper-failed', detail: e.message.slice(0, 200) })
    )
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'))
      if (!line) {
        finish({ ok: false, code: 'helper-bad-output', detail: err.slice(0, 200) })
        return
      }
      let parsed: { ok?: boolean; plaintexts?: unknown; code?: string }
      try {
        parsed = JSON.parse(line) as typeof parsed
      } catch {
        finish({ ok: false, code: 'helper-bad-output' })
        return
      }
      if (parsed.ok !== true) {
        const code = parsed.code === 'no-encryption' ? 'no-encryption' : 'helper-failed'
        finish({ ok: false, code, detail: parsed.code })
        return
      }
      const arr = Array.isArray(parsed.plaintexts) ? parsed.plaintexts : []
      // 长度必须对上：对不上说明协议错，宁可判失败也不要错位配对（会写错密钥）
      if (arr.length !== ciphertexts.length) {
        finish({ ok: false, code: 'helper-bad-output', detail: 'length-mismatch' })
        return
      }
      finish({
        ok: true,
        plaintexts: arr.map((v) => (typeof v === 'string' ? v : null)),
        legacyUserData: userData
      })
    })

    /*
     * 不往 stdin 写东西：Electron 以 app 模式启动时读不到管道 stdin（实测 len=0，
     * `end` 事件在 whenReady 之前就发生了）。输入全在 argv 里。
     */
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
  })
}