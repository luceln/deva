import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { scryptAsync } from '@noble/hashes/scrypt'
import { randomBytes } from '@noble/hashes/utils'
import type { SecretsKdf } from '../../shared/bundle-format'

/**
 * 备份包里的密钥段加密。
 *
 * ## 为什么密钥不能原样带走
 *
 * `secrets.json` 里的密文是 `safeStorage.encryptString` 的产物。Windows 上它由 Chromium OSCrypt 实现：
 * 一把 32 字节 AES key 经 DPAPI 加密后存在 `userData/Local State`（本机实测 `%APPDATA%/devaplus/Local State`）。
 * 「彻底卸载」会连 `userData` 一起删（`installer-uninstall.nsh:500-509`），重装后 Electron 生成**新 key**，
 * 旧密文永久解不开。卸载器自己的提示文案也写明了这点（`:95`）。
 *
 * 所以导出时必须先解出明文，再用**不依赖本机凭据**的方式重新封装。这里选口令派生：
 *  - 口令在用户脑子里，不随任何目录被删而消失；
 *  - 顺带让这个包**换台机器也能还原**，比只支持同机划算。
 *
 * ## 算法
 *
 * `scrypt` + `chacha20poly1305`，两者都是项目已有依赖
 * （`@noble/hashes/scrypt`、`@noble/ciphers/chacha`，`shared/remote-crypto.ts:1-6` 已在用同一套），
 * 纯 JS、无原生编译，**不引入新依赖**。
 *
 * AEAD 是关键：口令错时 `decrypt` 抛错（`invalid tag`），而不是解出一堆乱码再当密钥写盘。
 * 那正是最坏的静默失效 —— 「还原成功」但所有服务商 401。
 */

/**
 * scrypt 参数。N=2^15 在桌面端约 100ms：足够拖慢暴力破解，又不至于让用户点完按钮干等。
 *
 * **参数随包存**（`manifest.secretsKdf`），不在代码里写死 —— 将来调强度不会让旧包解不开。
 */
const KDF_DEFAULTS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const

/** chacha20poly1305 要求 12 字节 nonce。 */
const NONCE_LEN = 12

/** 生成一份新的 KDF 参数。每次导出都换 salt：同一个口令导两次，密文也不相同。 */
export function newKdf(): SecretsKdf {
  return {
    algo: 'scrypt',
    salt: Buffer.from(randomBytes(16)).toString('base64'),
    ...KDF_DEFAULTS
  }
}

/**
 * 口令长度下限。不给强口令就形同虚设 —— 这个包里有全部 API 密钥。
 * 8 个字符是下限而非建议值；界面里要明确提示「忘了就再也解不开」。
 */
export const MIN_PASSPHRASE_LENGTH = 8

export function checkPassphrase(pass: string): { ok: true } | { ok: false; reason: string } {
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, reason: `口令至少 ${MIN_PASSPHRASE_LENGTH} 个字符` }
  }
  return { ok: true }
}

function deriveKey(pass: string, kdf: SecretsKdf): Promise<Uint8Array> {
  // 异步版：scrypt 是内存硬函数，同步版会把主进程卡住 100ms 以上（界面直接卡帧）
  return scryptAsync(new TextEncoder().encode(pass), Buffer.from(kdf.salt, 'base64'), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: kdf.dkLen
  })
}

/**
 * 加密密钥段。输出布局：`nonce(12) || 密文+tag`。
 *
 * nonce 每次随机且**绝不复用** —— chacha20poly1305 对同一把 key 复用 nonce 会直接崩掉机密性，
 * 这比口令弱更致命。
 */
export async function encryptSecrets(plain: string, pass: string, kdf: SecretsKdf): Promise<Buffer> {
  const key = await deriveKey(pass, kdf)
  const nonce = randomBytes(NONCE_LEN)
  const sealed = chacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plain))
  return Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)])
}

/**
 * 解密密钥段。口令错 / 包被篡改 → 抛错，**绝不返回半截明文**。
 *
 * 调用方必须把它翻成「口令不对」的明确提示，而不是「密钥没配过」——
 * 两者的用户动作完全不同（重新输一遍 vs 去设置里重填）。
 */
export async function decryptSecrets(blob: Buffer, pass: string, kdf: SecretsKdf): Promise<string> {
  if (blob.length <= NONCE_LEN) throw new Error('密钥段长度不足')
  const key = await deriveKey(pass, kdf)
  const nonce = blob.subarray(0, NONCE_LEN)
  const body = blob.subarray(NONCE_LEN)
  const opened = chacha20poly1305(key, nonce).decrypt(body)
  return new TextDecoder().decode(opened)
}

/**
 * 口令是否与某个已加密的密钥段匹配 —— **不真正解密内容**，只验证认证标签。
 *
 * 用途：界面在用户输完口令、点「还原」之前就能给出「口令不对」的即时反馈，
 * 而不是等到解压完 600MB、替换完文件之后才在密钥那一步报错。
 *
 * 注意这**不是**安全边界：能验证标签就说明口令对，这是 AEAD 的固有性质，不算泄露。
 */
export async function verifyPassphrase(blob: Buffer, pass: string, kdf: SecretsKdf): Promise<boolean> {
  try {
    await decryptSecrets(blob, pass, kdf)
    return true
  } catch {
    return false
  }
}
