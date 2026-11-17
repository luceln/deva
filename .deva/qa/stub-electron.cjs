/**
 * electron 桩：仅供导入器测试用。路径全部来自环境变量，绝不指向真实用户目录。
 *   TEST_HOME    → app.getPath('home') / os.homedir() 的替代（由测试进程设 USERPROFILE）
 *   TEST_APPDATA → app.getPath('appData')（原版 lockfile 就拼在这里）
 *   DEVA_HOME    → 目标数据目录（被测代码自己读，不经过桩）
 */
const path = require('path')

const env = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`stub-electron: 缺少环境变量 ${k}`)
  return v
}

/** 记录所有 IPC 发送，测试据此断言「广播了什么、payload 是什么」。 */
const sent = []
/** 记录本进程内每次 setConfig 落盘次数（由 monkey patch 无效，改为记录 config 文件写入的 mtime 变化另算）。 */
const ipcHandlers = new Map()

const app = {
  getPath(k) {
    if (k === 'home') return env('TEST_HOME')
    if (k === 'appData') return env('TEST_APPDATA')
    if (k === 'userData') return path.join(env('TEST_APPDATA'), 'devaplus')
    if (k === 'temp') return process.env.TEST_TMP || process.env.TEMP || '/tmp'
    throw new Error('stub-electron: 未预期的 getPath ' + k)
  },
  getAppPath: () => process.env.TEST_APP_PATH || process.cwd(),
  getName: () => 'devaplus',
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  on() {},
  once() {},
  quit() {},
  setPath() {}
}

const ipcMain = {
  handle(ch, fn) {
    ipcHandlers.set(ch, fn)
  },
  handleOnce(ch, fn) {
    ipcHandlers.set(ch, fn)
  },
  on() {},
  once() {},
  off() {},
  removeHandler(ch) {
    ipcHandlers.delete(ch)
  }
}

const safeStorage = {
  // TEST_NO_ENCRYPTION=1 模拟「这台机器没有可用加密」（Linux 无 libsecret / 换了 OS 账户）
  isEncryptionAvailable: () => process.env.TEST_NO_ENCRYPTION !== '1',
  // 桩的密文：enc:<明文> 的 base64。写进 secrets.json 后仍是「不可读明文」，足以验证「密文原样搬运」。
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  /**
   * `TEST_DECRYPT_FAILS=1` 模拟**真机换账户后 DPAPI 解不开**：密文还在，decryptString 抛错。
   *
   * 这是本机唯一能验的方式——真 DPAPI 依赖 OS 账户，测试里造不出来。它至少能证明代码路径正确：
   * `readSecret` 必须返回 `unreadable/decrypt-failed`，而不是 `absent`（以前两者都是 null，无法区分）。
   */
  decryptString: (b) => {
    if (process.env.TEST_DECRYPT_FAILS === '1') {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    }
    return b.toString('utf8').replace(/^enc:/, '')
  }
}

/** 假窗口：webContents.send 记进 sent，供测试断言广播。 */
function makeWindow(name = 'main') {
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sent.push({ name, channel, payload })
      }
    }
  }
}

module.exports = {
  app,
  ipcMain,
  safeStorage,
  BrowserWindow: class BrowserWindow {},
  shell: { openExternal: () => Promise.resolve() },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '' }) },
  Notification: class Notification {
    show() {}
  },
  // 测试辅助（被测代码不会用到）
  __test: { sent, ipcHandlers, makeWindow }
}
