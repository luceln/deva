/**
 * 跨应用密钥重加密的 helper（**由主进程以原版应用的 userData 起一个 Electron 子进程**）。
 *
 * ## 为什么需要单独一个进程
 *
 * `safeStorage` 的密钥材料在 `app.getPath('userData')/Local State` 里（Windows 是 DPAPI 包着的
 * AES-256-GCM 密钥；macOS 是 Keychain 项、按应用隔离）。本进程已经把 userData 定成 DevaPlus 的，
 * 改不回去（`safeStorage` 的行为在 ready 时就定下），所以**必须另起一个进程**，
 * 在 `whenReady()` **之前**把 userData 指到原版的目录，才能解原版的密文。
 *
 * 实测：`app.setPath('userData', <原版目录>)` 在 ready 前调用即可，**不需要**换成原版的 app 名
 * （换 name 还得造一份 package.json，多一个落盘物）。
 *
 * ## 为什么输入走 argv、输出走 stdout（不用 stdin）
 *
 * 试过 stdin：**Electron 以 app 模式启动脚本时，管道里的 stdin 读不到**（实测 `len=0`）。
 * stdin 的 `end` 事件在 `whenReady()` 之前就发生了，且 Chromium 初始化期间不消费管道。
 * argv 没有这个问题，且**密文本身不是敏感数据**（没有正确的 Local State 密钥解不开它），
 * 所以放命令行是安全的；**明文只走 stdout**，绝不进 argv（那会出现在进程列表里，任何本机进程可见）。
 *
 * ## 输入 / 输出
 *
 * `electron <helper.cjs> <userDataPath> <base64-密文1> [<base64-密文2> ...]`
 * stdout 一行 JSON：`{ ok: true, plaintexts: (string|null)[] }` 或 `{ ok: false, code }`
 *
 * 单条解不开时对应位置给 `null`（不整体失败）：一条坏密文不该让其余能解的都作废。
 * 本文件里**任何日志都只输出长度或错误码**，绝不打印明文。
 */
const { app, safeStorage } = require('electron')

/**
 * 输出一行 JSON 并退出。
 *
 * 必须等 write 的回调再退出：管道上的 stdout 是异步刷的，紧接着 `app.exit()` 会把还没冲出去的
 * JSON 直接丢掉（父进程那边表现成「没有任何输出」）。`app.quit()` 走正常退出流程更容易冲干净，
 * 再加一个 500ms 的兜底强退，避免 quit 被残留句柄拦住让父进程等到超时。
 */
function replyAndQuit(obj) {
  const done = () => {
    app.quit()
    setTimeout(() => app.exit(0), 500).unref?.()
  }
  try {
    process.stdout.write(JSON.stringify(obj) + '\n', done)
  } catch {
    done()
  }
}

/*
 * `process.argv` = [electron 可执行文件, 脚本路径, userData, 密文...]，所以要 `slice(2)`。
 * （`slice(1)` 会把脚本自己的路径当成 userData，于是 setPath 到脚本文件上，app 直接崩。）
 */
const argv = process.argv.slice(2)
const userDataPath = argv[0]
const ciphertexts = argv.slice(1)

/*
 * 顺序要紧：**必须先 setPath 再碰 safeStorage**。
 *
 * `whenReady` 里第一件事就是设它，且本文件在此之前没有调用过任何 safeStorage API。
 * 如果放到 ready 之后、又已经调过 safeStorage，密钥就会被本应用的 Local State 锁死，
 * 后面再 setPath 也没用（那正是「换个目录就解不开」的原因）。
 */
if (userDataPath) app.setPath('userData', userDataPath)

app.whenReady().then(() => {
  if (!userDataPath || ciphertexts.length === 0) {
    replyAndQuit({ ok: false, code: 'bad-input' })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    replyAndQuit({ ok: false, code: 'no-encryption' })
    return
  }

  const plaintexts = []
  for (const c of ciphertexts) {
    if (typeof c !== 'string' || !c) {
      plaintexts.push(null)
      continue
    }
    try {
      plaintexts.push(safeStorage.decryptString(Buffer.from(c, 'base64')))
    } catch {
      // 单条解不开：给 null，不整体失败
      plaintexts.push(null)
    }
  }
  replyAndQuit({ ok: true, plaintexts })
})