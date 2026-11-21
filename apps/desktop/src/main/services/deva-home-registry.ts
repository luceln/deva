import { app } from 'electron'
import { execFile } from 'child_process'

/**
 * 把数据根目录（`getDevaHome()`）持久化到注册表，供**卸载器**读取。
 *
 * 为什么非要存：`DEVA_HOME` 是运行期环境变量，卸载器是独立进程、拿不到用户 shell 里设的变量，
 * 也不该去猜。不存的话，「卸载时移除所有记录」只能清默认的 `~/.deva-plus`，
 * 用户把数据挪到 D 盘之后勾了勾选框却什么都没删——那种「以为删了其实没删」比不做还糟。
 *
 * 存在哪：`HKCU\Software\DevaPlus`，与安装范围无关（electron-builder 的 ARP 键会随卸载被删掉，
 * 而这个键要活到卸载执行那一刻）。值名 `DevaHome`。
 *
 * 写失败一律静默：这只是给卸载器用的便利值，写不了也不影响应用运行（卸载器会退回默认路径）。
 */
const KEY = 'HKCU\\Software\\DevaPlus'
const VALUE = 'DevaHome'

let written: string | null = null

/**
 * 每次启动把当前数据根写进注册表（覆盖写）。
 *
 * 覆盖而不是「没有才写」：用户改了 `DEVA_HOME` 之后，旧值就是错的，留着会把删除指向一个已经不用的目录。
 * 进程内只写一次（路径在启动时确定），避免每个窗口都去拉一次 reg.exe。
 */
export function recordDevaHome(home: string): void {
  if (process.platform !== 'win32') return
  // 只由打包版写：开发版（`pnpm dev`）的数据根是 ~/.deva-plus-dev，写进去会把用户的卸载目标指偏
  if (!app.isPackaged) return
  if (!home || written === home) return
  written = home
  execFile(
    'reg',
    ['add', KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', home, '/f'],
    { windowsHide: true },
    () => {
      /* 写不进去就保持上一个值；卸载器那一侧还有路径断言兜底 */
    }
  )
}