# 主进程测试的信任边界：electron 桩比真实现宽松在哪

> 面向：所有用 `.deva/qa/stub-electron.cjs` 跑的主进程测试。
> 一句话结论：**看到「测试通过」时，下面这些行为一概没被证明。**
>
> 桩文件：`.deva/qa/stub-electron.cjs`（86 行）。被测到的模块：`importer-*.ts`、
> `services/config.ts`、`services/secrets.ts`（经 `importer-config.ts` 间接）。

## 清单

| # | 桩做了什么简化 | 真实 Electron 会怎样 | 会掩盖什么 bug |
| --- | --- | --- | --- |
| 1 | `safeStorage.encryptString(s)` 返回 `Buffer("enc:" + 明文)`；`decryptString` 直接剥掉前缀 | 走 OS 凭据体系：Win 用 DPAPI（绑当前用户账户 + 机器）、macOS Keychain（绑 keychain 项）、Linux libsecret（绑 keyring）。密文不可跨账户/跨机器解 | **换账户 / 换机器后密钥全解不开**——`skipsec`、`importEncryptedSecret`、`copySecrets` 的「密文原样搬运」只验了字节搬运，没验「搬过去的密文在新环境能不能解开」。同一台机器同一个账户下测永远绿。这是本清单里风险最高的一条 |
| 2 | `isEncryptionAvailable()` 只看环境变量 `TEST_NO_ENCRYPTION` | 真实返回值取决于 OS：`basic_text` 后端（Linux 无 libsecret/无 keyring）恒为 false；Windows 上通常 true 但**账户无凭据访问权**时会抛 | 「加密可用性判断」这类分支在真机上可能与测试里相反。测试里 `TEST_NO_ENCRYPTION=1` 造出的「无加密」分支是真的，但**没造出来**的「有加密但 decrypt 抛异常」分支（DPAPI 换了账户会抛，而不是返回空）一行都没跑过 |
| 3 | `decryptString` 遇到非 `enc:` 前缀的字节不抛错，`replace` 不匹配就原样返回 | 真实实现在密文损坏 / 换了账户时**抛异常** | **已核实的现场**：`services/secrets.ts:76-80` 的 `getSecret` 是 `try { return safeStorage.decryptString(...) } catch { return null }`。真机换账户后 DPAPI 解不开 → 抛 → 被这个 catch 吞掉 → 返回 `null`，与「这个 provider 没配过密钥」**完全同形**。下游无法区分「没配」和「配了但解不开」。桩里 decrypt 永不抛，所以这条分支在测试里**一次都没被执行过**。这不是桩的 bug（桩按契约实现），但它让一类 P1 在测试中不可见 |
| 4 | `app.getPath()` 只支持 `home` / `appData` / `userData` / `temp`，其余直接 `throw` | 支持 `downloads`、`documents`、`logs`、`crashDumps`、`sessionData`、`exe`、`module` 等十余项 | 被测代码若新增一处 `app.getPath('sessionData')`，测试会**直接崩**（好事，能发现）；但反过来说，凡是靠这些路径推导上游位置的地方目前无人验证 |
| 5 | `app.whenReady()` 立即 resolve；`app.on/once/quit` 全是空函数 | 事件驱动：`ready` 在窗口创建后可延迟数秒；`quit` 会真正走退出流程（触发 `will-quit` / `before-quit`） | **启动时序竞态**完全没验：真实启动时 `app.getPath('appData')` 的可用性、`ready` 之前的调用、退出时未落盘数据的处理。导入器在真实启动链路里的行为（realmachine 脚本除外）不由此桩保证 |
| 6 | `app.isPackaged = false`、`setPath()` 空实现 | `isPackaged` 决定资源路径分支；`setPath('appData', …)` 会真正改变后续所有 `getPath` 结果 | 打包后才会走的分支（资源路径、`upstreamHome` 的推导）在桩下永远是开发态。`p_d277b1ae` 那条真机坑（覆盖 USERPROFILE 导致 Electron 33 静默退出）就是这层差异的实例：**桩里改环境变量没事，真机里改会退出** |
| 7 | `ipcMain.handle` 只把 handler 存进 Map，从不调用；`send` 只往数组里 push | 真实 IPC 有序列化（结构化克隆）：函数、`undefined` 之外的特殊对象、循环引用、超大 payload 都会抛或截断；`webContents.send` 在窗口已销毁时抛或静默 | 导入报告里若塞了不可序列化的东西（`Date` 之外的类实例、`Map`、带函数的对象），测试全绿、真机 `Failed to serialize`。**本批 5 个场景全是直调函数，没有一条走过真实 IPC 序列化** |
| 8 | `BrowserWindow` 是空 class；`makeWindow()` 的 `isDestroyed()` 恒 false | 窗口可能已被销毁（用户关了），此时 `isDestroyed()` 为 true，`webContents.send` 抛 | 「广播给已关闭的窗口」这条守卫（`if (!win \|\| win.isDestroyed()) return`）在桩下**永远是假分支**，等于没测。导入是长操作，用户中途关窗口是真实场景 |
| 9 | `dialog.showOpenDialog` 恒返回 `{ canceled: true, filePaths: [] }` | 返回用户真实选择；可能返回不存在/无权限/网络盘的路径 | 导入入口「用户选了一个读不出来的源目录」这条最关键的路径，在桩下**永远进不去**（恒 canceled）。本批 `srcdir` 场景是直接改写 `SRC` 常量绕过的，不是真的选了坏目录 |
| 10 | `shell.openExternal` / `Notification.show` 都返回成功 | 可能失败（无默认浏览器、通知被系统禁用） | 「打开文件夹」「导入完成通知」的失败分支没验。影响小（都不影响数据），列出来是为了完整性 |
| 11 | `nativeImage.createFromPath` 恒 `isEmpty: true` | 真实解码 png/jpg；损坏图片返回空或抛｜头像导入的「图片解码失败」分支没验，只验了「文件拷贝成功」 |
| 12 | 模块顶层无 `process.platform` 差异（桩是纯 JS） | `path` 分隔符、ACL、文件锁定语义都随平台变 | **本清单之外但同等重要**：`existsSync` 在「目标被占/断链」时的返回值我实测过 EBUSY=true、断链=false，但**POSIX 的断链 symlink 行为与 Windows junction 不同**（写穿风险），本机造不出来。这一条不是桩的问题，是平台的问题，但同样属于「测试通过 ≠ 真机没问题」 |

## 怎么用这份清单

1. **看到「测试通过」，先问这一条在不在上表里。** 在表里 → 通过只说明逻辑分支走对了，不说明真机行为。
2. **凡是涉及 secrets / safeStorage 的断言（`skipsec` 5 条），一律标「仅验字节搬运」。** 真机换账户那条需要人工验：导入后换 Windows 账户（或换机器）打开，确认密钥是否还能用。
3. **凡是走 IPC 的断言，本批一条都没有。** 导入报告的序列化、广播时机，需要真机或至少一个真 `ipcRenderer.invoke` 往返。
4. **第 9 条是本清单里最实用的**：`showOpenDialog` 恒 canceled 意味着「用户选了坏源目录」这个入口从来没被测试真正走过。

## 补充：桩的哪些部分是**忠实**的（不必怀疑）

- `app.getPath('home')` / `appData` → 由 `TEST_HOME` / `TEST_APPDATA` 环境变量决定，且测试进程会把 `USERPROFILE` 指到临时目录，`os.homedir()` 跟随 → 这一点与真实行为一致（真机 Electron 的 `getPath('home')` 也来自同一处）。
- `ipcMain.handle` 的**注册**语义（channel 覆盖、`removeHandler`）与真实一致，所以「同一 channel 重复注册会覆盖」这类判据可信。
- 桩里所有路径都来自环境变量、**绝不指向真实用户目录**——这条是桩最重要的安全属性，比它的保真度更重要。
