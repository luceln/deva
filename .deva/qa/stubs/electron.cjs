/**
 * `electron` 的测试替身 —— **只给 QA 脚本用，不进产品代码**。
 *
 * `bundle-export` / `bundle-import` 通过 `safeStorage` 解/加密钥，而 `safeStorage` 在纯 Node
 * 下不存在。这里用一个固定密钥的 AES-256-CBC 模拟它的行为（等价于 DPAPI：同一台机器能解开、
 * 换机器解不开），语义足够验证三件事：
 *   1. 导出时**确实解出了明文**（否则跨环境必出坏密文）
 *   2. 导入时**确实用本机能力重新封装了**（而不是把旧密文原样搬回去）
 *   3. 本机无加密能力时**明确拒绝**而不是退化成明文
 *
 * 判据依赖的是"能不能解开/解开对不对"，与真 DPAPI 的算法无关，所以替身不会掩盖问题。
 * 真正的 safeStorage 行为属于打包/装机验证的范围，不在这个脚本的结论里。
 */
const crypto = require('crypto')

// 固定密钥：模拟"这台机器上的 DPAPI 主密钥"
const KEY = crypto.createHash('sha256').update('deva-qa-fake-dpapi-master-key').digest()
const PREFIX = 'FAKE_DPAPI_V1:'

let available = true

const safeStorage = {
  isEncryptionAvailable: () => available,
  encryptString: (plain) => {
    if (!available) throw new Error('Encryption is not available')
    const iv = crypto.randomBytes(16)
    const c = crypto.createCipheriv('aes-256-cbc', KEY, iv)
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return Buffer.from(PREFIX + Buffer.concat([iv, enc]).toString('base64'), 'utf8')
  },
  decryptString: (buf) => {
    if (!available) throw new Error('Encryption is not available')
    const s = Buffer.from(buf).toString('utf8')
    if (!s.startsWith(PREFIX)) throw new Error('not encrypted by this machine')
    const raw = Buffer.from(s.slice(PREFIX.length), 'base64')
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, raw.subarray(0, 16))
    return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8')
  }
}

/** 测试用：打开/关闭"本机加密能力"，验证无能力时的降级路径。 */
function __setEncryptionAvailable(v) {
  available = v
}

module.exports = {
  safeStorage,
  __setEncryptionAvailable,
  // 其余 API 只在 IPC/窗口相关模块里用到，这里不需要实现
  /*
   * `app.getPath('userData')` 是 `secrets.ts` 的 `migrateLegacy()` 要用的：新位置没有
   * secrets.json 时会去旧位置找一次。返回一个**必然不存在**的临时路径，让那条分支安静地
   * 走到 ENOENT → absent。若这里抛错，会被 `ensureLoaded` 归类成 `corrupt`，
   * 于是 `replaceAllSecrets` 拒绝写入 —— 那是替身的锅，不是产品的。
   */
  app: {
    getVersion: () => '0.0.0-qa',
    getPath: (name) => require('path').join(require('os').tmpdir(), 'deva-qa-no-such-userdata', String(name))
  },
  dialog: {},
  ipcMain: {},
  BrowserWindow: class {},
  shell: {}
}
