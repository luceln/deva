/**
 * 验收者自建 stub 包装：转发生成 stubs/electron.cjs，但把「加密能力」开关
 * 接到 globalThis 上 —— 因为 esbuild alias 会把 stub 内联进 bundle，
 * 夹具里 require 到的是另一个模块实例，直接改它的内部变量影响不到 bundle 内的那份。
 */
const real = require('./stubs/electron.cjs')

const safeStorage = {
  isEncryptionAvailable: () =>
    globalThis.__QA_ENC_AVAILABLE === undefined ? real.safeStorage.isEncryptionAvailable() : Boolean(globalThis.__QA_ENC_AVAILABLE),
  encryptString: (p) => real.safeStorage.encryptString(p),
  decryptString: (b) => real.safeStorage.decryptString(b)
}

module.exports = {
  ...real,
  safeStorage,
  // 兼容原来直接调用 __setEncryptionAvailable 的写法
  __setEncryptionAvailable: (v) => { globalThis.__QA_ENC_AVAILABLE = v }
}
