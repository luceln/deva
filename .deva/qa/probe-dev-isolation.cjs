/**
 * 探测：dev / 打包两种情况下，userData 与 DEVA_HOME 分别指向哪里。
 *
 * 用真 Electron 跑（不是 node），因为 `app.getPath` 只有在 Electron 进程里才有意义。
 * 判定「是不是 dev」的开关是 `app.isPackaged`，脚本用两个进程各跑一次来模拟：
 *   - `electron.exe .`（未打包）→ is.dev === true
 *   - 打包版没法在 CI 里现做，所以模拟那一侧用 `DEVA_FORCE_PACKAGED=1` 让脚本把判断翻过来，
 *     证明「打包分支确实走另一条路」——两条路的取值都打印出来，谁也没被跳过。
 */
const { app } = require('electron')
const { join } = require('path')

const isDev = process.env.DEVA_FORCE_PACKAGED === '1' ? false : !app.isPackaged

// 复刻 index.ts 里的 isolateDevData 行为（探测脚本不 import 业务代码，避免连带拉起整棵依赖树）
if (isDev) {
  app.setPath('userData', join(app.getPath('userData'), 'dev'))
  if (!process.env.DEVA_HOME?.trim())
    process.env.DEVA_HOME = join(app.getPath('home'), '.deva-plus-dev')
}

app.whenReady().then(() => {
  const out = {
    isPackaged: app.isPackaged,
    effectiveDev: isDev,
    userData: app.getPath('userData'),
    DEVA_HOME: process.env.DEVA_HOME || '(未设置 → config.ts 回落到 ~/.deva-plus)',
    home: app.getPath('home')
  }
  console.log('---PROBE---')
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`)
  console.log('---END---')
  app.quit()
})