/**
 * 二开独有词条。
 *
 * 为什么单独一块：这些词条（设置 › 导入 `settings.import`、设置 › 工作区 `cf.wt`）只存在于 DevaPlus，
 * 上游没有对应位置，留在 `messages.ts` 里每次合并上游都要在同一个大文件里解冲突。搬出来之后，
 * 上游改动不会再撞到它们。
 *
 * 注入方式：`messages.ts` 在 zhCN / en 定义完后把这两棵子树**深合并**进去——注意 `settings.import`
 * 是 `settings` 的子键，浅合并会把整个 `settings` 替换掉，连带丢光其中其它词条。
 * 因此这里的对象必须保持原有的层级路径（`{ settings: {...}, cf: {...} }`），注入方按层合并。
 *
 * 新增词条：直接加到对应子树里；`MessageTree` 是索引签名，漏 key 编译器不会报，
 * 所以文案完整性靠 `.deva/qa/check-i18n-keys.cjs`（逐 key 比集合与值）把关。
 */
import type { MessageTree } from './messages'

export const forkZhCN = {
  settings: {
    import: {
      title: '导入',
      desc: '把原版 Deva 里的对话、服务商、角色、记忆与技能搬到这里。只补本地没有的，已有的一律不动，重复执行也安全。',
      unavailable: '当前版本还没接通导入通道，请重启应用后再试。',
      source: '原版数据目录',
      sourceHint: '只读，不会修改原版任何文件',
      probing: '正在检查…',
      overview: '原版数据',
      overviewHint: '含应用自带的服务商与角色；实际只导入你自己加的那些',
      gateRunning: '原版 Deva 正在运行，请先退出它再导入。',
      gateNoSource: '没有找到原版 Deva 的数据目录，可能还没用过原版。',
      recheck: '重新检查',
      reprobe: '刷新状态',
      run: '开始导入',
      runAgain: '再次导入',
      running: '正在导入…',
      runFailed: '导入没能开始：',
      stepHint: '复制期间请勿退出应用；已复制的部分下次会直接跳过。',
      done: '导入完成',
      doneWithFailures: '导入完成，但有 {n} 条失败',
      noop: '无新增，跳过 {n} 个（之前已经导入过了）',
      countCopied: '新增 {n}',
      countSkipped: '跳过 {n}',
      countFailed: '失败 {n}',
      showDetail: '明细',
      hideDetail: '收起',
      moreDetail: '…还有 {n} 条，已省略',
      failures: '失败条目',
      failureCount: '{n} 条',
      failureCountCapped: '共 {total} 条，显示前 {shown} 条',
      failureExpand: '展开看全部 {n} 条',
      failureCollapse: '收起，只看前几条',
      failureHint: '这些条目没有被写入。记忆类失败通常是总量或条数已达上限——删掉几条不再需要的记忆后重新导入即可补齐。',
      reason: {
        budget: '记忆总量已达上限，拒写',
        full: '记忆条数已达上限，拒写',
        tooLong: '单条记忆超长，拒写',
        missingRoot: '这个项目没有记录路径，无法确定归属，已跳过',
        importedProviderMissing:
          '导入的服务商没有留在配置里，可能被其他写入覆盖了，请重新导入一次补上',
        configWriteFailed: '配置写盘失败，权限或磁盘异常',
        // 目标 config.json 在但读不出来（半截 JSON / 被占用）。此刻写回等于用空配置覆盖用户的原有配置。
        targetConfigUnreadable: '本应用的 config.json 读不出来，为免覆盖原有配置，本次服务商一个都没有导入',
        linkFailed: '建立链接失败，可能缺少权限',
        // 写目标失败（mkdir / 复制 / 建链接）。原始 Node 错误串（含本机绝对路径）只进后台日志，不进界面。
        targetWriteFailed: '写入目标位置失败（权限、磁盘或路径异常），这一项没有导入',
        noEncryption: '这台机器无法保存密钥，需要手动重填',
        targetBlocked: '目标位置被同名文件夹或文件占住，没有写入',
        targetUnreadable: '目标位置有个同名条目读不出来（可能被其他程序占用），没有覆盖它',
        copyTruncated: '文件复制不完整（写入被中断），已丢弃半截副本，请重新导入一次',
        sourceSecretsCorrupt: '原版密钥文件内容损坏、解析不了，密钥一个都没导入，请检查该文件',
        sourceSecretsUnreadable: '原版密钥文件读不出来（可能被其他程序占用），密钥一个都没导入，请稍后重试',
        sourceMcpUnreadable: '原版 MCP 配置文件读不出来（可能被其他程序占用），MCP 服务一个都没导入，请稍后重试',
        sourceMcpCorrupt: '原版 MCP 配置文件内容损坏、解析不了，MCP 服务一个都没导入，请检查 mcp.json',
        sourceMcpEnabledUnknown: 'MCP 服务已导入，但原版配置读不出来，无法得知它原本是开还是关——请到 MCP 页面按需打开',
        mcpWriteFailed: 'MCP 配置没能写入本地文件（权限或磁盘异常），重启后这条配置会丢失',
        mcpUnsafeId: '原版这个 MCP 服务的 id 不能用作配置键（含冒号或分隔符），没有导入。请在原版里改个名字后重导',
        sourceConfigUnreadable: '原版配置文件读不出来（可能被占用），服务商一个都没能导入，请稍后重试',
        sourceConfigCorrupt: '原版配置文件内容损坏、解析不了，服务商一个都没能导入，请检查 config.json',
        sourceMemoryUnreadable: '原版记忆文件读不出来（可能被占用），这个范围下的记忆没有导入，请稍后重试',
        sourceMemoryCorrupt: '原版记忆文件内容损坏、解析不了，这个范围下的记忆没有导入，请检查 memory.json',
        sourceDirUnreadable: '原版这个目录读不出来，里面的数据一个都没有导入。请检查权限，或关掉占用它的程序后重新导入',
        sourceFileUnreadable: '原版这个文件读不出来（可能被占用），这一条没有导入。请稍后重新导入一次',
        sourceNotAFile: '原版这个位置不是普通文件（可能是同名文件夹占了位置），这一条搬不了。请检查原版数据',
        secretsWriteFailed: '密钥没能写入本地密钥文件（权限或磁盘异常）',
        secretsStoreUnreadable:
          '本地密钥文件本身读不出来（内容损坏或被占用），为避免覆盖掉里面的其它密钥，这次一条都没写。请检查 secrets.json',
        avatarCopyFailed: '角色头像没能复制，角色本身已导入，可以使用',
        // 会话这一轮还在进行、历史被锁定：说明「不是失败、稍后会补」，并给出下一步。
        sessionHistoryLocked:
          '这轮对话还在进行，历史暂时锁定，这次没有导入——数据没有丢，聊完再重新导入一次就会补上',
        // 附件没准备好：主档先不发布，避免带进来一个打不开附件的会话。
        sessionMediaMissing:
          '这条会话的附件（图片、PDF 等）还没准备好，为避免导入后打不开附件，这条会话这次没有导入。请确认原版数据目录里的附件是否完整，或等附件导完后重新导入一次'
      },
      // 密钥行的附加说明（见 ImportPane 的 secretsRow）。{n} 是条数。
      secretNote: {
        noEncryption: '这台机器存不了密钥，请手动重填 {n} 个',
        invalid: '{n} 个密钥在源里是空值或坏值',
        skipped: '{n} 个已存在，保留本地',
        ignored: '{n} 个不适用，已忽略',
        failed: '{n} 个没能写入',
        rekeyed: '其中 {n} 条之前用不了，这次修好了'
      },
      // 由外部插件托管、因此没有导入的项。{n} 是条数。与「已存在，跳过」严格分开说。
      // 单复数分开写，英文不能出现「1 belong to a plugin」。
      pluginManagedN: '{n} 个由插件管理，未导入',
      pluginManagedNOne: '1 个由插件管理，未导入',
      pluginManagedHint:
        '这些由插件自己创建和维护，装上对应插件就会自动出现，不需要也不应该手动导入。要改它们请去插件里改。',
      // 明细里「分组名 + 具体 id」之间、以及 id 之间的分隔符：英文不能用全角冒号/顿号。
      listColon: '：',
      listSep: '、',
      // 密钥明细里按分类列 id 时的分组标题
      secretGroup: {
        noEncryption: '需手动重填',
        invalid: '源里是空值',
        skipped: '已存在，保留本地',
        ignored: '不适用',
        failed: '写入失败',
        rekeyed: '已修好',
        pluginManaged: '由插件管理，未导入'
      },
      // 「N 条密钥需要重新填写」：面板级警告，不是失败。{n} 是条数。
      unrecoverable: {
        title: '{n} 条密钥需要重新填写',
        hint: '这几条是原版加密的，本应用读不出来。去「设置 › 模型」把对应的密钥重新填一遍就能用；别的都已导入，不用重来。',
        more: '还有 {n} 条',
        goSettings: '去设置 › 模型重填'
      },
      steps: {
        gate: '检查原版状态',
        providers: '服务商',
        secrets: 'API 密钥',
        personas: '角色',
        personaEnabled: '启用角色',
        memories: '记忆',
        skills: '技能',
        sessions: '对话记录',
        mcp: 'MCP 服务',
        assoc: '附件',
        // 附件按类细分（主进程的 step 是 `assoc:<kind>`）：失败清单据此分组，用户一眼看出是哪一类出的错
        'assoc:media': '附件（媒体）',
        'assoc:checkpoints': '附件（回滚面板）',
        'assoc:subagents': '附件（子智能体记录）',
        'assoc:toolResults': '附件（工具结果）',
        cache: '刷新会话列表',
        done: '收尾',
        // 整轮级别的异常：失败发生在哪一步已无法确定，主进程记成 unknown
        unknown: '整轮导入',
        // 导入期间暂存的用户配置改动，收尾时回写失败（id 形如 user-patch#1）
        config: '配置回写'
      },
      idWholeRun: '整轮导入',
      idDir: '目标目录',
      idConfig: '配置文件',
      idUnsafeId: '不能用作配置键的 id：',
      assoc: {
        media: '图片附件',
        checkpoints: '回滚检查点',
        subagents: '子智能体记录',
        toolResults: '工具结果'
      },
      stat: {
        sessions: '对话',
        providers: '服务商',
        personas: '角色',
        memories: '记忆',
        skills: '技能',
        attachments: '附件'
      }
    }
  },
  cf: {
    backup: {
      title: '备份',
      intro: '卸载重装后导回来，和原来一模一样。',
      exportTitle: '导出备份',
      exportDesc: '会话、附件、角色、记忆、技能、配置、定时任务',
      plainWarning: '密钥明文',
      exportBtn: '导出到文件',
      /*
       * 导出分三段显示。`exportPreparing` 是「点下去但还没收到第一个进度事件」时用的：
       * 准备阶段（扫文件）的第一个事件通常在几毫秒内到，但不显示点东西会让人以为没点中。
       * `exportScanning` 只报计数不报百分比 —— 扫描前不知道总数（见 `ExportProgress`）。
       */
      exportPreparing: '正在准备…',
      exportScanning: '正在扫描文件（已扫 {done} 个）…',
      exportHashing: '正在校验内容 {done}/{total}…',
      exporting: '正在打包 {done}/{total}…',
      exportDone: '已导出：{path}',
      exportFailed: '导出失败：磁盘空间不足',
      restoreTitle: '从备份还原',
      restoreDesc: '覆盖前会先自动备份一份',
      chooseBtn: '选择备份包…',
      restoreBtn: '开始还原',
      overwriteConfirmBtn: '确认覆盖并还原',
      restoring: '正在还原（{step} {done}/{total}）…',
      restoreDone: '还原完成：{files} 个文件，{secrets}。',
      restoreRestart: '建议重启应用，让所有改动都生效。',
      restoreFailed: '还原失败',
      notABundle: '这不是本应用导出的备份包',
      overwriteWarn: '会覆盖当前数据',
      containsSecrets: '这个包含有密钥，还原后 API 密钥会自动恢复，无需重新填写。',
      kvExportedAt: '导出时间',
      kvFiles: '内容',
      kvAppVersion: '导出版本',
      kvSecrets: '密钥',
      yes: '含（明文）',
      no: '不含',
      excludedNote: '以下派生内容不会还原（会自动重建）：{list}',
      secretsAbsent: '包里不含密钥',
      secretsNoEncryption: '本机没有可用的加密存储，密钥未还原，请在设置里重新填写',
      secretsRestored: '已还原 {n} 条密钥',
      restoreBackupAt: '覆盖前的那份数据已备份到：{path}（觉得还原不对，可以把它拷回去）',
      restoreRelinked: '{n} 个外部链接已重新连上',
      restoreDowngraded: '以下 {n} 项原本指向外部目录，但外部目录已不在了，还原成了独立副本（不再与外部仓库联动）：{list}',
      restoreUnrecovered: '以下 {n} 项内容没有恢复：它们原本指向外部目录，而外部目录和备份包里都没有内容，只剩空目录。请重新挂载，或手动把内容拷回：{list}',
      restoreIncomplete: '以下 {n} 项只恢复了一部分，能用但缺了内容（括号里是「缺几个/共几个」）：{list}',
      restoreIncompleteTruncated: '注意：上面这些缺失中有的是导出时就截断了，不是包坏了 —— {why}。重新导出一次并挑重点目录，可以补回来。',
      restoreDirsFailed: '以下 {n} 个空目录没能建回来（常见原因是同名的文件占了位置）：{list}',
      truncatedTooBig: '导出时这些目录超过了体积上限',
      truncatedTooMany: '导出时这些目录的文件数超过了条数上限',
      truncatedUnreadable: '导出时这些目录读不出来（多半是权限问题）',
      restoreCorruptSecrets: '原来的密钥库读不出来（文件已损坏），没有覆盖它，而是改名保留在：{path}。可以从这里抢救，或删掉它让应用重新生成一份。',
      restoreConfigStale: '配置重读失败（{msg}），界面上看到的可能还是旧配置。重启应用可让它生效。'
    },
    wt: {
      paneTitle: '工作区',
      paneHint: '每个工作区是一个独立目录，有自己的一份依赖，改动互不影响。',
      rootLabel: '根目录',
      rootHint: '工作区都建在这里，不能建到外面',
      rootDefault: '默认',
      rootModified: '已修改',
      rootChange: '更改',
      rootReset: '恢复默认',
      rootOpen: '打开',
      rootSave: '保存',
      rootCancel: '取消',
      rootLoadFailed: '读取根目录失败',
      rootSaveFailed: '保存根目录失败',
      rootOutsideBadge: '不在当前根内',
      rootOutsideNote: '此处不能新建；想把根设到这里，在上面改根目录',
      refresh: '刷新',
      empty: '还没有独立工作区。在新建会话时选「独立工作区」即可创建。',
      loadFailed: '读取工作区列表失败：{msg}',
      storeUnreadable: '工作区记录文件读不出来，下面显示的不是全部工作区。可以在设置里重试，或检查 ~/.deva 下的记录文件。',
      notWired: '这个操作还没接通',
      detached: '分离头指针',
      unmanagedTitle: 'git 里登记、但不是 Deva 建的',
      unmanagedHint: '只做展示，不参与任何操作。',
      baseLabel: '切出自 {label}',
      lockedBy: '{label} 正在操作这个目录的 git',
      mergeInProgress: '合并进行中，还有 {n} 个冲突待处理',
      sizePending: '统计中…',
      sizeUnknown: '占用未知',
      noSession: '无关联会话',
      sessionCount: '{n} 个会话',
      dirtyMeta: '{n} 个未提交改动',
      // dirtyCount 的 null 与 0 语义不同：null 是「目录不在、无法统计」，0 是「干净」。
      dirtyUnknown: '无法统计改动',
      dirtyClean: '没有未提交改动',
      memoryShared: '与主仓库 {repoRoot} 共享项目私有记忆',
      rebuild: '重建',
      rebuildDone: '工作区已重建',
      revealFailed: '打不开这个目录（可能已不在受信范围内），请从合并面板或工作区列表重试。',
      rebuildFail: {
        notFound: '找不到这条工作区记录，可能已被移除。',
        dirExists: '目录还在（{path}），不需要重建。要重置请先删除再重建。',
        branchMissing: '分支 {branch} 已经不在了。重建等于新开一个同名分支，需要你先决定分支怎么处理。',
        installing: '正在安装依赖，等它结束或失败后再重建。',
        addFailed: 'git worktree add 失败，详见日志。',
        verifyFailed: '建出来了，但回读核对不上（目录 / 分支 / git 登记有一项不符），请先手工确认再使用。'
      },
      state: {
        ok: '正常',
        dirMissing: '工作区目录已缺失',
        prunable: '工作区目录已缺失（git 登记可清理）',
        branchMismatch: '工作区已被切到 {actual}，不再是 {branch}'
      },
      deps: {
        pending: '待安装依赖',
        installing: '安装中',
        ready: '依赖就绪',
        failed: '依赖安装失败',
        skipped: '无需安装依赖',
        retry: '重试安装',
        // §7.7 屏⑤：失败时必须与明细同屏出现。只说失败不说还能用，用户会以为整个工作区废了。
        stillUsable: '会话仍可使用，只是 pnpm / npm 之类的命令会失败。',
        retryReason: {
          'not-found': '找不到这个工作区，可能已被删除。',
          'already-installing': '依赖正在安装，等这一轮结束再看。',
          'no-lockfile': '没有 lockfile，无处可装依赖。',
          'unsupported-language': '这个项目不是 Node 工程，Deva 不代为安装依赖。',
          'write-failed': '写记录失败，稍后再试。',
          error: '发起安装失败，稍后再试。'
        }
      },
      remove: {
        title: '删除工作区',
        installing: '正在安装依赖，等它结束或失败后再删。',
        prune: '移除登记',
        pruneHint: '不删除任何文件（目录本来就不存在），只清理 git 登记。',
        branchKept: '分支 {branch} 会保留。',
        confirm: '要删除这个工作区吗？目录和它里面的文件会一并删除，无法撤销。\n{path}',
        dirtyTitle: '有未提交的改动',
        dirtyConfirm: '这个工作区里还有 {n} 处未提交的改动，删除会把它们一起丢掉，无法找回。确定继续吗？',
        force: '仍然删除',
        failed: '删除失败',
        done: '工作区已删除',
        pruneDone: 'git 登记已清理'
      },
      merge: {
        merge: '合并',
        title: '合并回 {target}',
        // 四个 blocker 与主进程 `MergeBlocker` 一一对应（`Record<MergeBlocker, string>` 兜住漏配）。
        // 每句都说清「为什么不能合并」，而不是只说「不能合并」——用户要的是下一步该做什么。
        blocker: {
          targetNotSet: '还不能合并：还没指定要合回哪个分支。先在合并面板里选一个目标分支。',
          sourceMissing: '还不能合并：工作区目录已不存在。',
          sourceBranchChanged: '还不能合并：工作区已不在它原来的分支上。',
          installing: '还不能合并：依赖还在安装，装完再合并。'
        },
        resolve: '处理冲突',
        close: '收起',
        noTarget: '未指定目标',
        // ── 四个圆点的固定标题：按 id 取，不按 status —— 通过与否标题都一样，用户才能横向对比 ──
        check: {
          C1: '工作区的未提交改动',
          C2: '工作区还在自己的分支上',
          C4: '目标分支仍在原处',
          C5: '改动与本次合并无交集'
        },
        // ── reason 的说明句。检查阶段主进程只给结构化事实、message 是空串，文案全在这里拼 ──
        reason: {
          dirty: '该工作区有 {n} 个未提交改动，它们不会被合并（merge 只合并已提交的内容）。',
          branchChanged: '该工作区已不在分支 {branch} 上（现在是 {actual}）。',
          busy: '目标目录还有未收尾的 git 操作（{op}），请先完成或中止。',
          sourceMissing: '工作区目录已不存在，这一项无法检查。',
          notCheckedOut: '分支 {branch} 当前没有被任何工作区检出，无法合并。请先在一个目录里检出它。',
          overlap: '有 {n} 个文件在目标目录有未提交改动，合并会覆盖它们。',
          unknown: '这一项没法判断（{path} 读不出来）。'
        },
        targetNotSet: '还没有合并目标。选一个本地分支作为目标。',
        pickTarget: '选择目标分支',
        useTarget: '设为目标并合并',
        upToDate: '目标分支已包含该工作区的全部提交，无需合并。',
        success: '已合并到 {target}',
        successSha: '合并提交 {sha}',
        showOutput: '显示 git 的输出',
        hideOutput: '收起 git 的输出',
        behind: '合并成功；期间该工作区又有 {n} 个新提交尚未合并，可再次合并。',
        again: '再次合并',
        conflict: '合并有冲突，需要你处理',
        failed: '合并失败',
        overlapTitle: '以下 {n} 个文件在目标目录有未提交改动，合并会覆盖它们：',
        stashThenMerge: '先存起来再合并',
        iWillHandle: '我去终端自己处理',
        iWillHandleHint: '在目标目录里先 git status 看一眼，自己提交或 stash 之后再回来合并。',
        cancel: '取消',
        abortFailed: '中止合并失败',
        aborted: '已中止合并，冲突已清除',
        copyAbort: '复制中止命令',
        copied: '已复制到剪贴板',
        copyFailed: '复制失败，请手动选中命令复制',
        retry: '再试一次',
        stashUnstaged: '改动已回来，其中 {n} 个文件从「已暂存」变回了「未暂存」，需要的话重新 git add。',
        stashPopConflict: '改动回来了但有冲突，stash 条目也还留着（可再次 git stash pop）。',
        // 四个失败出口的文案。cf.wt 下没有同名键（那层是 git 面板的），这里自带一份，
        // 免得将来 git 面板改文案时把这个面板的话一起改掉。
        abortMerge: '中止合并',
        openTerminal: '在终端打开目标目录',
        copyCommand: '复制 git 命令',
        reveal: '在文件管理器打开'
      },
      reveal: '在文件管理器打开'
    }
  }
} satisfies MessageTree

export const forkEn = {
  settings: {
    import: {
      title: 'Import',
      desc: 'Bring conversations, providers, personas, memories and skills over from the original Deva. Only missing items are added — nothing existing is touched, so running it twice is safe.',
      unavailable: 'This build isn’t wired for importing yet. Restart the app and try again.',
      source: 'Source data folder',
      sourceHint: 'Read-only — the original app’s files are never modified',
      probing: 'Checking…',
      overview: 'In the original app',
      overviewHint: 'Built-in providers and personas included; only your own additions are imported',
      gateRunning: 'The original Deva is running — quit it before importing.',
      gateNoSource: 'No original Deva data folder found. Perhaps you never used it.',
      recheck: 'Check again',
      reprobe: 'Refresh',
      run: 'Start import',
      runAgain: 'Import again',
      running: 'Importing…',
      runFailed: 'The import couldn’t start:',
      stepHint: 'Don’t quit while copying; anything already copied is skipped next time.',
      done: 'Import finished',
      doneWithFailures: 'Import finished with {n} failures',
      noop: 'Nothing new — {n} skipped (already imported before)',
      countCopied: '{n} added',
      countSkipped: '{n} skipped',
      countFailed: '{n} failed',
      showDetail: 'Details',
      hideDetail: 'Hide',
      moreDetail: '…and {n} more',
      failures: 'Failed items',
      failureCount: '{n} items',
      failureCountCapped: '{total} items, showing the first {shown}',
      failureExpand: 'Show all {n}',
      failureCollapse: 'Collapse to the first few',
      failureHint:
        'These items were not written. Memory failures are usually quota limits — delete a few memories you no longer need and import again to pick them up.',
      reason: {
        budget: 'Memory budget reached — not written',
        full: 'Memory entry limit reached — not written',
        tooLong: 'Memory entry too long — not written',
        missingRoot: 'This project has no recorded path, so its memories were skipped',
        importedProviderMissing:
          'An imported provider is no longer in the config — something else likely overwrote it. Import again to restore it.',
        configWriteFailed: 'Couldn’t write config — check permissions or disk space',
        targetConfigUnreadable:
          'This app’s config.json can’t be read — no providers were imported so your existing config stays untouched',
        linkFailed: 'Couldn’t create the link — permission likely denied',
        targetWriteFailed: 'Couldn’t write to the destination (permissions, disk or path) — this item was not imported',
        noEncryption: 'This machine can’t store keys — add them again by hand',
        targetBlocked: 'The destination is taken by a folder or file of the same name — nothing written',
        targetUnreadable:
          'Something with that name is there but can’t be read (another app may have it open) — it was not overwritten',
        copyTruncated: 'The copy came out incomplete (the write was interrupted); the partial file was discarded — import again',
        sourceSecretsCorrupt:
          'The upstream secrets file is corrupt and couldn’t be parsed — no keys were imported. Check the file',
        sourceSecretsUnreadable:
          'The upstream secrets file can’t be read (it may be in use) — no keys were imported. Try again later',
        sourceMcpUnreadable:
          'The upstream MCP config can’t be read (it may be in use) — no MCP servers were imported. Try again later',
        sourceMcpCorrupt:
          'The upstream MCP config is corrupt and couldn’t be parsed — no MCP servers were imported. Check mcp.json',
        sourceMcpEnabledUnknown:
          'The MCP server was imported, but the upstream config can’t be read, so whether it was on is unknown — enable it on the MCP page if you need it',
        mcpWriteFailed:
          'The MCP config couldn’t be written to disk (permissions or disk full) — this entry will be lost after a restart',
        mcpUnsafeId:
          'This MCP server’s id can’t be used as a config key (it contains a colon or separator), so it wasn’t imported. Rename it upstream and import again',
        sourceConfigUnreadable:
          'The upstream config file can’t be read (it may be in use) — no providers were imported. Try again later',
        sourceConfigCorrupt:
          'The upstream config file is corrupt and couldn’t be parsed — no providers were imported. Check config.json',
        sourceMemoryUnreadable:
          'The upstream memory file can’t be read (it may be in use) — memories in this scope were not imported. Try again later',
        sourceMemoryCorrupt:
          'The upstream memory file is corrupt and couldn’t be parsed — memories in this scope were not imported. Check memory.json',
        sourceDirUnreadable:
          'This upstream folder can’t be read, so none of its data was imported. Check permissions or close the app using it, then import again',
        sourceFileUnreadable:
          'This upstream file can’t be read (it may be in use) — this item was not imported. Try importing again later',
        sourceNotAFile:
          'This upstream entry is not a regular file (a folder with the same name may be in the way) — it can’t be imported. Check the upstream data',
        secretsWriteFailed: 'The key couldn’t be written to the local secrets file — check permissions or disk space',
        secretsStoreUnreadable:
          'The local secrets file itself can’t be read (corrupted or in use). Nothing was written so the other keys inside are not overwritten — check secrets.json',
        avatarCopyFailed: 'The avatar couldn’t be copied — the persona itself was imported and is usable',
        sessionHistoryLocked:
          'This conversation is still running, so its history is locked and nothing was imported this time. No data was lost — import again after that turn finishes and it will be picked up',
        sessionMediaMissing:
          'The attachments for this conversation (images, PDFs) aren’t ready yet. It was left out this time so you don’t end up with a conversation whose attachments can’t be opened. Check that the attachments exist upstream, or import again once they finish'
      },
      secretNote: {
        noEncryption: 'This machine can’t store keys — {n} to add by hand',
        invalid: '{n} keys were empty or corrupt in the source',
        skipped: '{n} already present, kept yours',
        ignored: '{n} not applicable, ignored',
        failed: '{n} couldn’t be written',
        rekeyed: '{n} of them were unusable before and are fixed now'
      },
      pluginManagedN: '{n} managed by a plugin, not imported',
      pluginManagedNOne: '1 managed by a plugin, not imported',
      pluginManagedHint:
        'A plugin creates and maintains these itself — they appear automatically once that plugin is installed, and should not be imported by hand. To change them, edit them in the plugin.',
      listColon: ': ',
      listSep: ', ',
      secretGroup: {
        noEncryption: 'Add by hand',
        invalid: 'Empty in source',
        skipped: 'Already present',
        ignored: 'Not applicable',
        failed: 'Write failed',
        rekeyed: 'Fixed now',
        pluginManaged: 'Managed by a plugin, not imported'
      },
      unrecoverable: {
        title: '{n} keys need to be entered again',
        hint: 'These were encrypted by the original app and can’t be read here. Add the matching keys again under Settings › Models and they will work — everything else was imported, no need to start over.',
        more: '{n} more',
        goSettings: 'Go to Settings › Models'
      },
      steps: {
        gate: 'Checking the original app',
        providers: 'Providers',
        secrets: 'API keys',
        personas: 'Personas',
        personaEnabled: 'Enabling personas',
        memories: 'Memories',
        skills: 'Skills',
        sessions: 'Conversations',
        mcp: 'MCP servers',
        assoc: 'Attachments',
        'assoc:media': 'Attachments (media)',
        'assoc:checkpoints': 'Attachments (rollback panels)',
        'assoc:subagents': 'Attachments (subagent records)',
        'assoc:toolResults': 'Attachments (tool results)',
        cache: 'Refreshing the conversation list',
        done: 'Finishing up',
        unknown: 'Whole run',
        config: 'Config write-back'
      },
      idWholeRun: 'Whole run',
      idDir: 'Target folder',
      idConfig: 'Config file',
      idUnsafeId: 'ID that can’t be used as a config key:',
      assoc: {
        media: 'Images',
        checkpoints: 'Checkpoints',
        subagents: 'Subagent records',
        toolResults: 'Tool results'
      },
      stat: {
        sessions: 'Conversations',
        providers: 'Providers',
        personas: 'Personas',
        memories: 'Memories',
        skills: 'Skills',
        attachments: 'Attachments'
      }
    }
  },
  cf: {
    backup: {
      title: 'Backup',
      intro: 'Restore it after a clean reinstall and everything is exactly as it was.',
      exportTitle: 'Export backup',
      exportDesc: 'Conversations, attachments, personas, memories, skills, settings, scheduled tasks',
      plainWarning: 'Keys in plain text',
      exportBtn: 'Export to file',
      exportPreparing: 'Preparing…',
      exportScanning: 'Scanning files ({done} so far)…',
      exportHashing: 'Verifying contents {done}/{total}…',
      exporting: 'Packing {done}/{total}…',
      exportDone: 'Exported: {path}',
      exportFailed: 'Export failed: not enough disk space',
      restoreTitle: 'Restore from backup',
      restoreDesc: 'A backup copy is saved before overwriting',
      chooseBtn: 'Choose backup file…',
      restoreBtn: 'Restore',
      overwriteConfirmBtn: 'Overwrite and restore',
      restoring: 'Restoring ({step} {done}/{total})…',
      restoreDone: 'Restore complete: {files} files, {secrets}.',
      restoreRestart: 'Restart the app so every change takes effect.',
      restoreFailed: 'Restore failed',
      notABundle: 'This is not a backup file created by this app',
      overwriteWarn: 'This will overwrite your current data',
      containsSecrets: 'This bundle contains keys. They will be restored automatically — no need to re-enter them.',
      kvExportedAt: 'Exported at',
      kvFiles: 'Contents',
      kvAppVersion: 'Exported by',
      kvSecrets: 'Keys',
      yes: 'included (plain text)',
      no: 'not included',
      excludedNote: 'These derived items are not restored (they are rebuilt automatically): {list}',
      secretsAbsent: 'no keys in this bundle',
      secretsNoEncryption: 'no encryption available on this machine — keys were not restored, please re-enter them in Settings',
      secretsRestored: '{n} keys restored',
      restoreBackupAt: 'The data you replaced was backed up to: {path} (copy it back if the restore was wrong)',
      restoreRelinked: '{n} external links reconnected',
      restoreDowngraded: '{n} items pointed at external folders that no longer exist and were restored as independent copies (no longer linked to the outside repo): {list}',
      restoreUnrecovered: '{n} items were NOT restored: they pointed at external folders, and neither the folder nor the bundle had their content, so only empty folders remain. Re-mount them or copy the content back by hand: {list}',
      restoreIncomplete: '{n} items were only partially restored; they work but are missing content (each entry shows "missing/total"): {list}',
      restoreIncompleteTruncated: 'Note: some of those gaps were already there at export time rather than caused by a damaged bundle — {why}. Exporting again and picking the important folders can fill them in.',
      restoreDirsFailed: '{n} empty folders could not be recreated (usually because a file with the same name is in the way): {list}',
      truncatedTooBig: 'those folders exceeded the size limit during export',
      truncatedTooMany: 'those folders exceeded the file-count limit during export',
      truncatedUnreadable: 'those folders could not be read during export (most likely a permissions problem)',
      restoreCorruptSecrets: 'Your previous key store could not be read (the file was corrupt), so it was renamed instead of overwritten and kept at: {path}. You can salvage it there, or delete it to let the app create a fresh one.',
      restoreConfigStale: 'Config reload failed ({msg}); what you see may still be the old config. Restart the app to apply.'
    },
    wt: {
      paneTitle: 'Worktrees',
      paneHint: 'Each worktree is its own folder with its own dependencies; changes do not affect each other.',
      rootLabel: 'Root folder',
      rootHint: 'All worktrees go here and cannot be placed outside it',
      rootDefault: 'Default',
      rootModified: 'Modified',
      rootChange: 'Change',
      rootReset: 'Reset to default',
      rootOpen: 'Open',
      rootSave: 'Save',
      rootCancel: 'Cancel',
      rootLoadFailed: 'Could not read the root folder',
      rootSaveFailed: 'Could not save the root folder',
      rootOutsideBadge: 'Outside current root',
      rootOutsideNote: 'Cannot create here; to use this folder as the root, change it above',
      refresh: 'Refresh',
      empty: 'No worktrees yet. Pick "separate worktree" when starting a new chat to create one.',
      loadFailed: 'Could not load worktrees: {msg}',
      storeUnreadable: 'The worktree record file could not be read, so this is not the full list. Retry, or check the record file under ~/.deva.',
      notWired: 'This action is not wired up yet',
      detached: 'detached HEAD',
      unmanagedTitle: 'Registered in git but not created by Deva',
      unmanagedHint: 'Shown for reference only; no actions apply.',
      baseLabel: 'from {label}',
      lockedBy: '{label} is running git in this folder',
      mergeInProgress: 'Merge in progress, {n} conflicts left',
      sizePending: 'Measuring…',
      sizeUnknown: 'Size unknown',
      noSession: 'No linked chats',
      sessionCount: '{n} chats',
      dirtyMeta: '{n} uncommitted changes',
      dirtyUnknown: 'Changes unknown',
      dirtyClean: 'No uncommitted changes',
      memoryShared: 'Shares project memory with the main repo {repoRoot}',
      rebuild: 'Rebuild',
      rebuildDone: 'Worktree rebuilt',
      revealFailed: 'Could not open this folder (it may be outside the trusted roots); retry from the merge panel or the worktree list.',
      rebuildFail: {
        notFound: 'This worktree record no longer exists.',
        dirExists: 'The folder still exists ({path}), so there is nothing to rebuild. To reset it, remove it first and then rebuild.',
        branchMissing: 'Branch {branch} is gone. Rebuilding would create a new branch of the same name, so you need to decide how to handle the branch first.',
        installing: 'Dependencies are installing; wait for it to finish or fail before rebuilding.',
        addFailed: 'git worktree add failed; see the log.',
        verifyFailed: 'It was created, but the read-back check did not match (folder / branch / git entry); verify it manually before use.'
      },
      state: {
        ok: 'Healthy',
        dirMissing: 'Worktree folder is missing',
        prunable: 'Worktree folder is missing (git entry can be cleaned up)',
        branchMismatch: 'Switched to {actual}, no longer on {branch}'
      },
      deps: {
        pending: 'Dependencies pending',
        installing: 'Installing',
        ready: 'Dependencies ready',
        failed: 'Dependency install failed',
        skipped: 'No dependencies needed',
        retry: 'Retry install',
        stillUsable: 'The chat is still usable; only pnpm / npm style commands will fail.',
        retryReason: {
          'not-found': 'This worktree no longer exists.',
          'already-installing': 'Dependencies are installing; check again when this run finishes.',
          'no-lockfile': 'No lockfile, so there is nothing to install.',
          'unsupported-language': 'This is not a Node project, so Deva will not install dependencies for it.',
          'write-failed': 'Could not write the record; try again later.',
          error: 'Could not start the install; try again later.'
        }
      },
      remove: {
        title: 'Remove worktree',
        installing: 'Dependencies are installing; wait for it to finish or fail.',
        prune: 'Remove git entry',
        pruneHint: 'Deletes no files (the folder is already gone); only cleans the git entry.',
        branchKept: 'Branch {branch} is kept.',
        confirm: 'Remove this worktree? Its folder and everything inside will be deleted. This cannot be undone.\n{path}',
        dirtyTitle: 'Uncommitted changes',
        dirtyConfirm: 'This worktree has {n} uncommitted changes. Removing it will discard them for good. Continue?',
        force: 'Remove anyway',
        failed: 'Could not remove the worktree',
        done: 'Worktree removed',
        pruneDone: 'Git entry cleaned up'
      },
      merge: {
        merge: 'Merge',
        title: 'Merge back into {target}',
        blocker: {
          targetNotSet: 'Cannot merge yet: no target branch is set. Pick one in the merge panel.',
          sourceMissing: 'Cannot merge yet: the worktree folder no longer exists.',
          sourceBranchChanged: 'Cannot merge yet: this worktree is no longer on its original branch.',
          installing: 'Cannot merge yet: dependencies are still installing.'
        },
        resolve: 'Resolve conflicts',
        close: 'Collapse',
        noTarget: 'no target',
        check: {
          C1: 'Uncommitted changes in this worktree',
          C2: 'This worktree is still on its own branch',
          C4: 'The target branch is still where it was',
          C5: 'Your changes do not overlap this merge'
        },
        reason: {
          dirty: 'This worktree has {n} uncommitted changes. They will not be merged (merge only takes committed work).',
          branchChanged: 'This worktree is no longer on {branch} (now {actual}).',
          busy: 'The target folder still has an unfinished git operation ({op}). Finish or abort it first.',
          sourceMissing: 'The worktree folder no longer exists, so this check cannot run.',
          notCheckedOut: 'Branch {branch} is not checked out in any folder, so it cannot be merged into. Check it out somewhere first.',
          overlap: '{n} files have uncommitted changes in the target folder; merging would overwrite them.',
          unknown: 'This check cannot be decided ({path} is unreadable).'
        },
        targetNotSet: 'No merge target yet. Pick a local branch as the target.',
        pickTarget: 'Pick a target branch',
        useTarget: 'Set as target and merge',
        upToDate: 'The target branch already contains every commit from this worktree; nothing to merge.',
        success: 'Merged into {target}',
        successSha: 'Merge commit {sha}',
        showOutput: 'Show git output',
        hideOutput: 'Hide git output',
        behind: 'Merged; this worktree has since gained {n} new commits that are not merged yet — you can merge again.',
        again: 'Merge again',
        conflict: 'The merge has conflicts you need to resolve',
        failed: 'Merge failed',
        overlapTitle: 'These {n} files have uncommitted changes in the target folder; merging would overwrite them:',
        stashThenMerge: 'Stash them, then merge',
        iWillHandle: 'I will handle it in a terminal',
        iWillHandleHint: 'In the target folder run git status first, then commit or stash on your own and merge again.',
        cancel: 'Cancel',
        abortFailed: 'Could not abort the merge',
        aborted: 'Merge aborted, conflicts cleared',
        copyAbort: 'Copy abort command',
        copied: 'Copied to clipboard',
        copyFailed: 'Copy failed — select the command and copy it manually',
        retry: 'Try again',
        stashUnstaged: 'Your changes are back, but {n} files went from staged to unstaged; run git add again if you need them staged.',
        stashPopConflict: 'Your changes are back but have conflicts, and the stash entry is kept (you can git stash pop again).',
        abortMerge: 'Abort merge',
        openTerminal: 'Open target folder in a terminal',
        copyCommand: 'Copy git command',
        reveal: 'Show in file manager'
      },
      reveal: 'Show in file manager'
    }
  }
} satisfies MessageTree
