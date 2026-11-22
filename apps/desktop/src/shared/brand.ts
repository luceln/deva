/**
 * 品牌常量：二开与上游的唯一分界处。
 *
 * 为什么要集中：这些字面量散落在上游文件里，每次同步上游，只要上游改了同一行附近，
 * 品牌串就会落进冲突块——而冲突解决时手滑把 `.deva-plus` 改成 `.deva`，
 * 程序就会去读另一个目录，用户看到的是「技能/配置/记忆全没了」，且**不报错**。
 * 收成常量后，改品牌只需动这一处。
 *
 * ⚠️ 下面每个值都**不是随便改的**，各自写明了绑定关系，改之前先看注释。
 * 三层（main / preload / renderer）都能 import：两份 tsconfig 都 include 了 `src/shared/**`。
 */

/**
 * 应用显示名。用作托盘提示、i18n 的 `app.name`、便携版注册表 DisplayName。
 *
 * ⚠️ 必须与 `electron-builder.yml` 的 `productName` 一致——它决定 Windows 安装目录
 * （`%LOCALAPPDATA%\Programs\<productName>`）、macOS `.app` 名、Linux `/opt` 目录。
 * 改了等于新旧版本装在不同目录，用户见到「两个应用」，且 updater 的安装方式判定与
 * portable 的卸载器名同时失效。
 */
export const APP_DISPLAY_NAME = 'DevaPlus'

/**
 * 用户数据目录名（`DEVA_HOME` 的默认末段，落在用户主目录下）。
 *
 * ⚠️ **已发布版本的既成事实**：用户数据就在 `~/.deva-plus` 下。
 * 改这里 = 程序去找新目录，老数据原地不动 → 界面上看就是「数据全没了」，且不报错。
 * 真要改必须同时写迁移代码，并在发布说明里告知。
 */
export const DEVA_HOME_DIRNAME = '.deva-plus'

/**
 * dev 模式的数据目录名（与安装版隔离，避免开发时污染真实数据）。
 * 同 {@link DEVA_HOME_DIRNAME}，改名前先确认没有开发者在依赖现名。
 */
export const DEVA_HOME_DIRNAME_DEV = '.deva-plus-dev'

/**
 * 对外 User-Agent 前缀（`DevaPlus/<版本>`）。
 *
 * ⚠️ 有**外部语义**：网关、WAF 靠它认出这是编码 agent 的正常流量。
 * 改成中性名可能被当爬虫拦；改回上游的 `deva/` 会与上游流量混淆，
 * 出问题时无法区分是哪一方。
 */
export const APP_UA_PREFIX = 'DevaPlus'

/**
 * 产物文件名前缀（updater 拼 `setup.exe` / `.dmg` / `.deb` / `.AppImage`）。
 *
 * ⚠️ 必须与 `electron-builder.yml` 各段 `artifactName` 里的 `${productName}` 一致，
 * 也与已发布 Release 的资产名一致——否则能查到新版却下到 404。
 */
export const ARTIFACT_NAME_PREFIX = 'DevaPlus'

/**
 * deb 包的安装根目录前缀（updater 据此判断「是不是 deb 装的」）。
 *
 * ⚠️ 必须与 `electron-builder.yml` 的 `linux` 目标安装目录一致。
 */
export const DEB_INSTALL_DIR = '/opt/DevaPlus'
