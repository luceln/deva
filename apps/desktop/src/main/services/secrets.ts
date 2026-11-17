import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './atomic-write'
import { getDevaHome } from './config'

/**
 * 密钥安全存储（主进程）。
 * 用 Electron safeStorage 加密（OS 凭据体系：Win DPAPI / macOS Keychain / Linux libsecret），
 * 密文（base64）落盘 `~/.deva-plus/secrets.json`（与非敏感 config.json 同一根目录，可被 DEVA_HOME 覆盖）。
 * 即便放在点目录，也**始终保持加密、绝不明文**——DPAPI 密文绑定 OS 用户账户、与文件路径无关。
 * **明文永不出主进程**——不提供 get 给渲染层，解密只在主进程内被 provider 调用时发生。
 * 详见 docs/architecture/security.md。
 */

// providerId -> base64(密文)
let store: Record<string, string> = {}
let filePath = ''
let loaded = false

/** 从旧位置 userData/secrets.json 一次性迁移（密文原样搬运，加密不受路径影响）。 */
async function migrateLegacy(): Promise<void> {
  try {
    const legacy = join(app.getPath('userData'), 'secrets.json')
    const raw = await fs.readFile(legacy, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      store = parsed as Record<string, string>
      await persist() // 写到新位置 ~/.deva-plus/secrets.json（旧文件保留，作兜底，不删）
    }
  } catch {
    // 无旧文件 / 解析失败 —— 视为空库
    store = {}
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  filePath = join(getDevaHome(), 'secrets.json')
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') store = parsed as Record<string, string>
  } catch {
    // 新位置不存在：尝试从旧 userData 位置迁移一次
    await migrateLegacy()
  }
  loaded = true
}

async function persist(): Promise<void> {
  // 原子写（同步）：写到一半崩溃不会留下半截 JSON——那样下次载入解析失败即视为空库，全部密钥丢失。
  // 同步写还免得两次并发的 persist 同时写同一个临时文件。
  writeFileAtomic(filePath, JSON.stringify(store, null, 2))
}

/**
 * 取解密后的密钥，**三态**返回。
 *
 * ## 为什么不能再用 `string | null`
 *
 * 以前 `catch { return null }`，于是三种完全不同的情况同形：
 *  1. 没配过（`store` 里没有这个 key）；
 *  2. 这台机器没有可用加密（Linux 缺 libsecret）；
 *  3. **有密文但解不开**（换了 OS 账户 / 换机 / DPAPI 凭据损坏）。
 *
 * 第 3 种是本次导入最可能踩到的：密文从原版搬过来了，但 `decryptString` 抛错。返回 null 会让界面
 * 显示「没配过密钥」，用户去重填一遍——而实际是解不开，重填能解决，但他永远不知道原因；更糟的是
 * 请求侧会拿空串去请求，得到的 `401` 被归成「密钥错误」而不是「本地解不开」。
 *
 * 三态：
 *  - `absent`：真没配过。调用方按「无密钥」处理（本地 Ollama 这类可无钥的服务照常继续）；
 *  - `ok`：取到了明文；
 *  - `unreadable`：**有密文但解不出来**，或本机压根没有加密能力。调用方必须**明确报错**，不能静默用空值。
 *
 * 绝不经 IPC 返回渲染层（明文不出主进程这一条不变）；渲染层要看「配没配」用 `hasSecret`。
 */
export type SecretRead =
  | { kind: 'absent' }
  | { kind: 'ok'; value: string }
  /** `reason` 是给人看的原因，`code` 供调用方分类（`no-encryption` 可指引装 libsecret，`decrypt-failed` 指引重填）。 */
  | { kind: 'unreadable'; code: 'no-encryption' | 'decrypt-failed'; reason: string }

/**
 * @param key 键约定：provider 用 providerId；MCP 用 `mcp:<serverId>:<field>`；remote 用 `remote:<botId>:<field>`。
 */
export async function readSecret(key: string): Promise<SecretRead> {
  await ensureLoaded()
  const enc = store[key]
  // 没这个 key 才是「没配过」。注意 `!enc` 与「配了空值」区分：空值在 setSecret 里已被当作删除。
  if (!enc) return { kind: 'absent' }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      kind: 'unreadable',
      code: 'no-encryption',
      reason: '本机没有可用的加密存储（Linux 需 libsecret / gnome-keyring），已保存的密文无法解密'
    }
  }
  try {
    return { kind: 'ok', value: safeStorage.decryptString(Buffer.from(enc, 'base64')) }
  } catch (e) {
    /*
     * 解不开最典型的原因是**换了 OS 用户账户 / 换了机器**：DPAPI 密文绑定账户。
     * 这条必须让用户看到「是解不开，不是没配」——两者的处置不同（重填 vs 什么都不用做）。
     */
    return {
      kind: 'unreadable',
      code: 'decrypt-failed',
      reason: `密钥密文解不开（多半是换了 Windows 账户或换了机器），需要重新填写：${(e as Error)?.message ?? e}`
    }
  }
}

/*
 * ⚠️ 这里原先有一个 `getSecret(): Promise<string | null>` 兼容层（把 `unreadable` 折成 `null`）。
 * 本轮把所有调用点都迁到 `readSecret` 之后它已无调用者，随即删除——留着它，下一个人会顺手用回那个
 * 「解不开 = 没配过」的版本，而这正是这次要消灭的静默。凡是要密钥，一律 `readSecret` 并显式处理三态。
 */

/**
 * 主进程内部使用：写入 / 更新密钥（空串视为删除）。加密不可用时拒绝写入（绝不静默存明文）。
 * 供 secrets:set IPC 与 MCP 连接层（mcp:<id>:<field>）共用。
 */
export async function setSecret(
  key: string,
  value: string
): Promise<{ ok: boolean; available: boolean }> {
  await ensureLoaded()
  const available = safeStorage.isEncryptionAvailable()
  if (!value) {
    delete store[key]
    await persist()
    return { ok: true, available }
  }
  if (!available) return { ok: false, available }
  store[key] = safeStorage.encryptString(value).toString('base64')
  await persist()
  return { ok: true, available }
}

/** 是否已配置某密钥（布尔，不回显明文）。 */
export async function hasSecret(key: string): Promise<boolean> {
  await ensureLoaded()
  return Boolean(store[key])
}

/**
 * 导入专用：**原样写入一段已有密文**（base64），不加密也不解密。
 *
 * 为什么要这个入口：从原版 Deva 导入密钥时手里只有密文（DPAPI 密文绑账户不绑路径，同机同账户直接可用），拿不到也
 * 不该拿到明文。而直接往 secrets.json 写文件是错的——`store` 是进程内缓存，`ensureLoaded` 只在首次载入，
 * 绕开它写盘会让本进程继续用旧内存态，导入的密钥「导了但用不上」，要重启才生效。
 *
 * 加密不可用时拒绝（与 setSecret 同口径：绝不静默存明文）；已有同 key 不覆盖（调用方先 hasSecret 判断）。
 *
 * **四种失败各有原因，必须分开报**：以前统一返回 boolean，调用方（导入器）只能把它们一起算成「跳过」——
 * 于是**写盘失败穿上「已存在」的衣服**，界面「跳过 N」把真失败盖住。这与记忆那条是同一个病：返回值粒度不足。
 */
export type ImportSecretResult =
  /** 已写入目标 secrets.json */
  | { ok: true }
  /** 目标已有同名 key：保留本地的，属于正常跳过 */
  | { ok: false; code: 'exists' }
  /** key / 密文为空：源数据有问题，跳过 */
  | { ok: false; code: 'invalid' }
  /** 系统未提供加密（无 DPAPI / keychain）：不能存明文，只能跳过 */
  | { ok: false; code: 'no-encryption' }
  /** 内存里写进去了但没落盘：这是**真失败**，重启后密钥就没了 */
  | { ok: false; code: 'write-failed' }

export async function importEncryptedSecret(
  key: string,
  cipherTextBase64: string
): Promise<ImportSecretResult> {
  await ensureLoaded()
  /*
   * `trim()` 而不是裸 `!cipherTextBase64`：纯空白 `"   "` 是非空字符串，以前会被当成密文写进 store，
   * 重启后解密失败、请求拿到空值 401，而界面显示「已配置」。导入器入口已挡一次，这里是**第二层**——
   * 这个函数是公开 API，将来别的调用方（批量导入、迁移工具）不该靠调用方自觉。
   */
  if (!key.trim() || !cipherTextBase64.trim()) return { ok: false, code: 'invalid' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, code: 'no-encryption' }
  if (key in store) return { ok: false, code: 'exists' }
  store[key] = cipherTextBase64
  try {
    await persist()
  } catch (e) {
    // 落盘失败：把内存态退回原状再报错，否则本次进程内 getSecret 能取到、重启后消失（最难查的一种）。
    delete store[key]
    console.warn('[secrets] 导入的密钥写盘失败：', (e as Error)?.message ?? e)
    return { ok: false, code: 'write-failed' }
  }
  return { ok: true }
}

/** 删除某密钥（幂等）。 */
export async function deleteSecret(key: string): Promise<void> {
  await ensureLoaded()
  if (key in store) {
    delete store[key]
    await persist()
  }
}

/** 删除某前缀下的所有密钥（如删除 MCP 服务时清 `mcp:<id>:` 全部字段）。 */
export async function deleteSecretsByPrefix(prefix: string): Promise<void> {
  await ensureLoaded()
  let changed = false
  for (const k of Object.keys(store)) {
    if (k.startsWith(prefix)) {
      delete store[k]
      changed = true
    }
  }
  if (changed) await persist()
}

export function registerSecretsIpc(): void {
  // 写入 / 更新密钥；空串视为删除。加密不可用时拒绝写入（绝不静默存明文）。
  ipcMain.handle(
    'secrets:set',
    async (_e, providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> => {
      await ensureLoaded()
      const available = safeStorage.isEncryptionAvailable()
      if (!key) {
        delete store[providerId]
        await persist()
        return { ok: true, available }
      }
      if (!available) return { ok: false, available }
      store[providerId] = safeStorage.encryptString(key).toString('base64')
      await persist()
      return { ok: true, available }
    }
  )

  // 是否已配置密钥（布尔，不回显明文）
  ipcMain.handle('secrets:has', async (_e, providerId: string): Promise<boolean> => {
    await ensureLoaded()
    return Boolean(store[providerId])
  })

  ipcMain.handle('secrets:delete', async (_e, providerId: string): Promise<{ ok: true }> => {
    await ensureLoaded()
    delete store[providerId]
    await persist()
    return { ok: true }
  })

  // 已配置密钥的 providerId 列表
  ipcMain.handle('secrets:list', async (): Promise<string[]> => {
    await ensureLoaded()
    return Object.keys(store)
  })

  // 当前环境是否支持加密（用于 UI 降级提示）
  ipcMain.handle('secrets:available', (): boolean => safeStorage.isEncryptionAvailable())
}
