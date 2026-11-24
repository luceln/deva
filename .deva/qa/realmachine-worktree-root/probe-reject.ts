/**
 * 定向探测：`setRoot` 的「根落在仓库内」校验到底会不会触发。
 *
 * 为什么要单独一个脚本：主脚本 `main-runner.ts` 里第 4 项实测两个非法路径都返回 `ok:true`，
 * 需要分清是
 *   (a) 脚本把 `worktrees.json` 写晚了 / store 缓存读不到 → 脚本问题，判据本身没问题；还是
 *   (b) `rejectReason()` 的 `isInsideRepo` 判定真有漏洞 → **实现问题，要上报**。
 *
 * 做法：在同一个 Electron 进程里
 *   1. 先确认 `listRecords()` 能看到预置的那条记录（看不到 → 结论是 (a)）
 *   2. 再调 `setRoot` 设一个仓库内路径，把完整返回值打出来
 *   3. 再直接调 `isInsideRepo(REPO, <仓库内路径>)`，看它自己怎么判
 * 三者对照就能定位到底断在哪一层。
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const RESULT = process.env.QA_RESULT as string
const ROOT = process.env.QA_ROOT as string
const REPO = process.env.QA_REPO_ROOT as string
const DEVA_HOME = path.join(ROOT, 'deva-home')
const FAKE_HOME = path.join(ROOT, 'home')
const FAKE_APPDATA = path.join(ROOT, 'appdata')

const log = (s: string): void => {
  console.log(s)
  try {
    fs.appendFileSync(RESULT, `${s}\n`)
  } catch {}
}

async function main(): Promise<void> {
  const { getDevaHome } = await import('../../../apps/desktop/src/main/services/config')
  const { listRecords } = await import('../../../apps/desktop/src/main/services/worktree/store')
  const { isInsideRepo, normalizeWorktreePath } = await import(
    '../../../apps/desktop/src/main/services/worktree/paths'
  )
  const { setWorktreeRoot } = await import(
    '../../../apps/desktop/src/main/services/worktree/root-setting'
  )

  log(`INFO getDevaHome :: ${getDevaHome()}`)
  log(`INFO REPO :: ${REPO}`)

  // ── 1. store 读到记录了吗 ──
  const records = listRecords()
  log(`INFO listRecords 条数 :: ${records.length}`)
  for (const r of records) log(`INFO   记录 repoRoot=${r.repoRoot} path=${r.path}`)
  if (records.length === 0) {
    log('=== 结论 (a)：store 读不到预置记录，第 4 项无法在主脚本里验证（脚本问题，非实现问题）===')
    app.exit(0)
    return
  }

  // ── 2. isInsideRepo 自己怎么判 ──
  for (const cand of [path.join(REPO, 'apps'), REPO, path.join(REPO, 'apps', 'desktop'), path.join(ROOT, 'outside')]) {
    let verdict = 'threw'
    try {
      verdict = String(isInsideRepo(REPO, cand))
    } catch (e) {
      verdict = `throw: ${(e as Error).message}`
    }
    log(`INFO isInsideRepo(${REPO}, ${cand}) = ${verdict}`)
  }

  // ── 3. setRoot 的实际返回值 ──
  for (const cand of [path.join(REPO, 'apps'), path.join(REPO, 'apps', 'desktop')]) {
    let res: any
    try {
      res = setWorktreeRoot(cand)
    } catch (e) {
      res = { threw: (e as Error).message }
    }
    log(`INFO setRoot(${cand}) = ${JSON.stringify(res).slice(0, 700)}`)
  }

  // ── 4. normalizeWorktreePath 对这两个候选的归一化结果 ──
  for (const cand of [path.join(REPO, 'apps'), REPO]) {
    try {
      const n = normalizeWorktreePath(cand)
      log(`INFO normalize(${cand}) = ${JSON.stringify(n)}`)
    } catch (e) {
      log(`INFO normalize(${cand}) threw: ${(e as Error).message}`)
    }
  }

  app.exit(0)
}

app
  .whenReady()
  .then(() => {
    process.env.USERPROFILE = FAKE_HOME
    process.env.HOME = FAKE_HOME
    for (const key of ['appData', 'userData'] as const) {
      try {
        app.setPath(key, FAKE_APPDATA)
      } catch {}
    }
    return main()
  })
  .catch((e) => {
    log(`FAIL 探测抛异常 :: ${(e as Error)?.stack?.slice(0, 800) ?? e}`)
    app.exit(1)
  })