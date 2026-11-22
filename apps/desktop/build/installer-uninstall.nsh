; ─────────────────────────────────────────────────────────────────────────────
; 卸载时可选「移除所有记录」
;
; 范围：只清**应用自己产生的数据**（配置、密钥、会话、记忆、角色、技能、缓存）。
; 绝不碰 worktree 里的代码——那是用户的工作成果，卸载器没有理由删。
;
; 出现条件：只有交互式卸载才问。`/S` 与 `--updated`（自动更新时先跑旧卸载器）一律不问、不删。
; 默认不勾：会话 / 记忆 / 密钥删了不可恢复，默认必须是「保留」。
;
; 为什么不用 electron-builder 的 deleteAppDataOnUninstall：它只删 $APPDATA 下三个候选名字，
; 完全不碰 ~/.deva-plus，也不碰 %LOCALAPPDATA%，开了会给人「以为删了其实没删」的错觉。
;
; 整段只在卸载器那一次编译里存在：装包编译若不定义 BUILD_UNINSTALLER，这些 un. 函数一个都不会被引用，
; 而本仓构建开了 -WX，未引用函数会直接把构建打挂（同 instFilesPre 的教训）。
; ─────────────────────────────────────────────────────────────────────────────
!ifdef BUILD_UNINSTALLER

!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh

Var /GLOBAL removeAllRecords      ; 1 = 用户勾了「移除所有记录」
Var /GLOBAL removeRecordsCheck    ; 勾选框句柄
Var /GLOBAL removeRecordsFailed   ; 删除失败计数（只进详情日志）
Var /GLOBAL cleanRoot             ; 本次清理的数据根（已断言）
Var /GLOBAL removeTargetOk        ; assertSafeTarget 的结果：1 可删 / 0 不可删
Var /GLOBAL removeHasGit          ; treeHasGit 的结果：1 有 .git / 0 没有
Var /GLOBAL cleanState            ; 勾选框读取用的临时变量

; ── 初始化：静默与自动更新都在这里一次判定完 ─────────────────────────────────
; 不用 ${Silent} / ${isUpdated}：那两个宏由构建器在脚本前段生成，与本 include 的先后顺序不稳；
; 自己解析命令行既确定又只依赖 FileFunc。
!macro customUnInit
  StrCpy $removeAllRecords "0"
  StrCpy $removeRecordsFailed "0"
  StrCpy $cleanRoot ""
  StrCpy $removeTargetOk "0"

  ${GetParameters} $0
  ${GetOptions} $0 "/S" $1
  ${IfNot} ${Errors}
    ; 静默卸载：不问、不删
    StrCpy $removeAllRecords "0"
  ${EndIf}
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    ; 自动更新：旧卸载器被安装器拉起，问不了也不该删
    StrCpy $removeAllRecords "0"
  ${EndIf}
!macroend

; ── 页面：保留默认欢迎页，本页排在它后面 ─────────────────────────────────────
!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME

  UninstPage custom un.removeRecordsPageCreate un.removeRecordsPageLeave

  Function un.removeRecordsPageCreate
    ; 静默 / 自动更新不弹这一页（此时 $removeAllRecords 恒为 0，后面也不会删）
    ${GetParameters} $0
    ${GetOptions} $0 "/S" $1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}
    ${GetOptions} $0 "--updated" $1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}

    ${if} $LANGUAGE == 2052
      !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否一并移除本应用保存的记录。"
    ${elseif} $LANGUAGE == 1028
      !insertmacro MUI_HEADER_TEXT "解除安裝選項" "選擇是否一併移除本應用程式儲存的記錄。"
    ${else}
      !insertmacro MUI_HEADER_TEXT "Uninstall options" "Choose whether to also remove records saved by this app."
    ${endif}

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${if} $LANGUAGE == 2052
      ${NSD_CreateCheckbox} 0 0 100% 12u "移除所有记录（会话、记忆、角色、技能、配置与 API 密钥）"
    ${elseif} $LANGUAGE == 1028
      ${NSD_CreateCheckbox} 0 0 100% 12u "移除所有記錄（對話、記憶、角色、技能、設定與 API 金鑰）"
    ${else}
      ${NSD_CreateCheckbox} 0 0 100% 12u "Remove all records (conversations, memory, personas, skills, settings and API keys)"
    ${endif}
    Pop $removeRecordsCheck
    ${NSD_SetState} $removeRecordsCheck ${BST_UNCHECKED}

    ${if} $LANGUAGE == 2052
      ${NSD_CreateLabel} 12u 18u 88% 62u "不勾选（默认）：只删除程序文件，上述记录全部保留，重装后可继续使用。$\r$\n$\r$\n勾选后：上述记录会被永久删除，无法恢复。$\r$\n$\r$\nAPI 密钥用本机 Windows 凭据加密保存，删除后即使从原版 Deva 重新导入也解不开，必须重新填写。$\r$\n$\r$\n无论是否勾选，工作区（worktree）里的代码都不会被删除。"
    ${elseif} $LANGUAGE == 1028
      ${NSD_CreateLabel} 12u 18u 88% 62u "不勾選（預設）：只刪除程式檔案，上述記錄全部保留，重新安裝後可繼續使用。$\r$\n$\r$\n勾選後：上述記錄會被永久刪除，無法復原。$\r$\n$\r$\nAPI 金鑰以本機 Windows 認證加密儲存，刪除後即使從原版 Deva 重新匯入也解不開，必須重新填寫。$\r$\n$\r$\n無論是否勾選，工作區（worktree）裡的程式碼都不會被刪除。"
    ${else}
      ${NSD_CreateLabel} 12u 18u 88% 62u "Unchecked (default): only the program files are removed; every record above is kept and can be reused after reinstalling.$\r$\n$\r$\nChecked: those records are deleted permanently and cannot be recovered.$\r$\n$\r$\nAPI keys are encrypted with this Windows machine's credentials; once deleted they cannot be decrypted even by importing from the original Deva again, so they must be re-entered.$\r$\n$\r$\nEither way, code in worktrees is never deleted."
    ${endif}

    nsDialogs::Show
  FunctionEnd

  ; 离开本页时记下勾选状态；勾了就先把清单摊开让用户再看一眼。
  ; 用户在确认框里点「取消」= 只放弃删除，不阻止卸载（真不想卸载可以点卸载器的取消按钮），
  ; 所以这里把勾去掉继续走，而不是 Abort 把人卡在这一页。
  Function un.removeRecordsPageLeave
    ${NSD_GetState} $removeRecordsCheck $cleanState
    ${if} $cleanState == ${BST_CHECKED}
      StrCpy $removeAllRecords "1"
      Call un.showRemoveRecordsSummary
    ${else}
      StrCpy $removeAllRecords "0"
    ${endif}
  FunctionEnd

; ── 路径断言 ─────────────────────────────────────────────────────────────────
  ; 调用约定（三个函数统一，避免互相踩寄存器）：
  ;   入参 $R0 = 目标路径；结果写 $removeTargetOk（1 可删 / 0 不可删）。
  ;   $0..$9 属于调用者，内层函数不得依赖它们跨 Call 存活——这正是下面要防的第二类事故。
  ;
  ; 红线：`RMDir /r` 的变量为空时会退化成删当前目录 / 盘根（Steam Linux 那次 `rm -rf "/"*` 即此类）。
  ; 所以每条删除前都要显式断言：非空、非盘符根、非共享根、不等于用户主目录。叶子名由调用方另判。
  Function un.assertSafeTarget
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4

    StrCpy $removeTargetOk "0"

    ; 空值 / 短到不像路径：直接拒
    StrLen $1 $R0
    ${If} $1 < 4
      Goto done
    ${EndIf}

    ; 盘符根 C:\ 或 C:
    ${If} $1 == 2
      StrCpy $2 $R0 1 1
      ${If} $2 == ":"
        Goto done
      ${EndIf}
    ${ElseIf} $1 == 3
      StrCpy $2 $R0 1 1
      StrCpy $3 $R0 1 2
      ${If} $2 == ":"
      ${AndIf} $3 == "\"
        Goto done
      ${EndIf}
    ${EndIf}

    ; 共享根 \\server\share：恰好三个反斜杠；更深的子目录安全
    StrCpy $2 $R0 2
    ${If} $2 == "\\"
      StrCpy $3 0
      StrCpy $4 0
      ${Do}
        StrLen $2 $R0
        ${If} $4 >= $2
          ${ExitDo}
        ${EndIf}
        StrCpy $2 $R0 1 $4
        ${If} $2 == "\"
          IntOp $3 $3 + 1
        ${EndIf}
        IntOp $4 $4 + 1
      ${Loop}
      ${If} $3 <= 3
        Goto done
      ${EndIf}
    ${EndIf}

    ; 用户主目录本身（删了等于删掉桌面、文档、下载）
    Push $R1
    StrCpy $R1 "$PROFILE"
    ${If} $R1 == ""
      SetShellVarContext current
      StrCpy $R1 "$PROFILE"
    ${EndIf}
    ${If} $R1 != ""
      ${If} $R0 == $R1
        Pop $R1
        Goto done
      ${EndIf}
      ; $PROFILE 可能带尾斜杠，再去掉尾斜杠比一次
      StrCpy $2 $R1 1 -1
      ${If} $2 == "\"
        StrLen $3 $R1
        IntOp $3 $3 - 1
        StrCpy $2 $R1 $3
        ${If} $R0 == $2
          Pop $R1
          Goto done
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $R1

    StrCpy $removeTargetOk "1"

    done:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; ── 删除单个文件 ─────────────────────────────────────────────────────────────
  ; 入参 $R0 = 完整文件路径。只删这一个文件，不递归。
  Function un.deleteDataFile
    Push $0
    Push $1
    Push $2

    StrCpy $1 "$R0"

    ; 先断言文件所在目录
    StrCpy $2 ""
    ${GetParent} $1 $2
    ${If} $2 == ""
      DetailPrint `skip file without parent: $1`
      Goto done
    ${EndIf}
    StrCpy $R0 "$2"
    Call un.assertSafeTarget
    ${If} $removeTargetOk != "1"
      DetailPrint `skip unsafe file target: $1`
      Goto done
    ${EndIf}

    ${If} ${FileExists} "$1"
      ClearErrors
      Delete "$1"
      ${If} ${Errors}
        IntOp $removeRecordsFailed $removeRecordsFailed + 1
        DetailPrint `could not delete: $1`
      ${Else}
        DetailPrint `deleted: $1`
      ${EndIf}
    ${EndIf}

    done:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; ── 目录里有没有 Git 工作区 ──────────────────────────────────────────────────
  ; 入参 $R0 = 目录；结果写 $removeHasGit（1 有 .git / 0 没有）。
  ; 防御纵深：白名单里那六个目录本该只装应用数据；万一用户把自定义 worktree 根指到了里面，
  ; 目录本身或其一级子目录会带 .git（checkout 是 .git 文件，仓库是 .git 目录）。见到就整条跳过。
  Function un.treeHasGit
    Push $0
    Push $1
    Push $2

    StrCpy $removeHasGit "0"

    ${If} ${FileExists} "$R0\.git"
      StrCpy $removeHasGit "1"
      Goto done
    ${EndIf}

    FindFirst $1 $2 "$R0\*.*"
    ${Do}
      ${If} $2 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        ${If} ${FileExists} "$R0\$2\.git"
          StrCpy $removeHasGit "1"
          ${ExitDo}
        ${EndIf}
      ${EndIf}
      FindNext $1 $2
    ${Loop}
    FindClose $1

    done:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; ── 递归删一个子树 ───────────────────────────────────────────────────────────
  ; 入参 $R0 = 目录，$R1 = 该目录允许的叶子名（去掉尾斜杠后的最后一个路径分段）。
  ;
  ; 三道闸门，任一不过就整条跳过：
  ;   1. 目录名必须正好等于预期叶子（防变量拼错把父目录当目标）；
  ;   2. 父目录必须过 assertSafeTarget；
  ;   3. 拼回的「父 + 叶子」必须与入参逐字一致（防 GetParent 对尾斜杠的处理差异）。
  ; 然后再过 treeHasGit，最后才 RMDir /r。
  ;
  ; ⚠️ 跨 Call 的状态一律放 $R8/$R9：$0..$5 会被 assertSafeTarget / treeHasGit 重新赋值，
  ; 早期版本把待删路径放在 $0 里跨 Call，等于让断言结果指向了另一个路径。
  Function un.deleteDataTree
    Push $0
    Push $1
    Push $2
    Push $3
    Push $R8
    Push $R9

    ; $R8 = 去掉尾斜杠后的目标；$R1 保持叶子名不动
    StrCpy $R8 "$R0"
    ${Do}
      StrLen $0 $R8
      ${If} $0 < 2
        ${ExitDo}
      ${EndIf}
      StrCpy $0 $R8 1 -1
      ${If} $0 != "\"
        ${ExitDo}
      ${EndIf}
      StrCpy $R8 "$R8" -1
    ${Loop}

    ; 1) 叶子名
    StrCpy $1 ""
    ${GetFileName} $R8 $1
    ${If} $1 != $R1
      DetailPrint `skip unexpected leaf: $R8 (want $R1)`
      Goto done
    ${EndIf}

    ; 2) 父目录断言
    StrCpy $2 ""
    ${GetParent} $R8 $2
    ${If} $2 == ""
      DetailPrint `skip tree without parent: $R8`
      Goto done
    ${EndIf}
    StrCpy $R9 "$2"
    StrCpy $R0 "$R9"
    Call un.assertSafeTarget
    ${If} $removeTargetOk != "1"
      DetailPrint `skip unsafe tree: $R8`
      Goto done
    ${EndIf}

    ; 3) 复核：父 + 叶子 == 目标
    StrCpy $3 "$R9\$R1"
    ${If} $3 != $R8
      DetailPrint `skip inconsistent tree: $R8 vs $3`
      Goto done
    ${EndIf}

    ${If} ${FileExists} "$R8\*.*"
      StrCpy $R0 "$R8"
      Call un.treeHasGit
      ${If} $removeHasGit == "1"
        DetailPrint `skip tree containing a git worktree: $R8`
        Goto done
      ${EndIf}
      ClearErrors
      RMDir /r "$R8"
      ${If} ${Errors}
        IntOp $removeRecordsFailed $removeRecordsFailed + 1
        DetailPrint `could not remove: $R8`
      ${Else}
        DetailPrint `removed: $R8`
      ${EndIf}
    ${EndIf}

    done:
    Pop $R9
    Pop $R8
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
  ; ── 数据根：优先注册表里应用启动时写的值，读不到退回默认 ────────────────────
  Function un.resolveDevaHome
    StrCpy $cleanRoot ""

    ReadRegStr $0 HKCU "Software\DevaPlus" "DevaHome"
    ${If} $0 != ""
      ; 去尾斜杠
      ${Do}
        StrLen $1 $0
        ${If} $1 < 2
          ${ExitDo}
        ${EndIf}
        StrCpy $1 $0 1 -1
        ${If} $1 != "\"
          ${ExitDo}
        ${EndIf}
        StrCpy $0 $0 -1
      ${Loop}
      ; assertSafeTarget 的入参是 $R0
      StrCpy $R0 $0
      Call un.assertSafeTarget
      ${If} $removeTargetOk == "1"
        StrCpy $cleanRoot $0
        DetailPrint `data root from registry: $cleanRoot`
      ${Else}
        DetailPrint `registry data root rejected: $0`
      ${EndIf}
    ${EndIf}

    ${If} $cleanRoot == ""
      SetShellVarContext current
      StrCpy $cleanRoot "$PROFILE\.deva-plus"
      DetailPrint `data root defaulted: $cleanRoot`
    ${EndIf}
  FunctionEnd

  ; ── 勾选后的清单确认（点「取消」= 放弃删除，但继续卸载）─────────────────────
  Function un.showRemoveRecordsSummary
    Call un.resolveDevaHome

    ${if} $LANGUAGE == 2052
      StrCpy $0 "以下记录将被永久删除：$\r$\n$\r$\n$cleanRoot 下的 config.json、secrets.json、memory.json、mcp.json、tasks.json、read-state.json、worktrees.json，以及 data、personas、skills、projects、uploads、profile 六个目录；$\r$\n%APPDATA% 下本应用的设置与缓存；$\r$\n%LOCALAPPDATA% 下本应用的更新缓存。$\r$\n$\r$\n不会删除：工作区（worktree）里的任何代码。$\r$\n$\r$\n点「确定」= 连同上述记录一起删除；点「取消」= 本次只卸载程序，记录全部保留。"
    ${elseif} $LANGUAGE == 1028
      StrCpy $0 "以下記錄將被永久刪除：$\r$\n$\r$\n$cleanRoot 下的 config.json、secrets.json、memory.json、mcp.json、tasks.json、read-state.json、worktrees.json，以及 data、personas、skills、projects、uploads、profile 六個目錄；$\r$\n%APPDATA% 下本應用程式的設定與快取；$\r$\n%LOCALAPPDATA% 下本應用程式的更新快取。$\r$\n$\r$\n不會刪除：工作區（worktree）裡的任何程式碼。$\r$\n$\r$\n按「確定」= 連同上述記錄一併刪除；按「取消」= 本次只解除安裝程式，記錄全部保留。"
    ${else}
      StrCpy $0 "These records will be permanently deleted:$\r$\n$\r$\nconfig.json, secrets.json, memory.json, mcp.json, tasks.json, read-state.json, worktrees.json and the data, personas, skills, projects, uploads and profile folders under $cleanRoot;$\r$\nthis app's settings and caches under %APPDATA%;$\r$\nthis app's update cache under %LOCALAPPDATA%.$\r$\n$\r$\nNever deleted: any code inside worktrees.$\r$\n$\r$\nOK = uninstall and delete the records above; Cancel = uninstall the program only, keeping every record."
    ${endif}

    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$0" IDOK +2
      ; 取消：放弃删除，但继续卸载
      StrCpy $removeAllRecords "0"
  FunctionEnd

  ; ── 清理本体 ────────────────────────────────────────────────────────────────
  ; shell 变量上下文照模板 uninstaller.nsh 的做法切：`--delete-app-data` 那段（:232-247）就是
  ; 「全用户安装时临时切到 current，删完再切回 all」。不这么做的话，本函数里 $APPDATA / $LOCALAPPDATA
  ; 会指向 all-users 的位置，而随后的 $SMPROGRAMS 又会因为上下文被改而删错开始菜单目录。
  Function un.wipeAppRecords
    Call un.resolveDevaHome

    ; 数据根下一个字也不能少、一个字符也不能猜：过不了断言就整段不做
    StrCpy $R0 "$cleanRoot"
    Call un.assertSafeTarget
    ${If} $removeTargetOk != "1"
      DetailPrint `abort: unsafe data root $cleanRoot`
      Return
    ${EndIf}

    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    Call un.wipeAppRecordsInner

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}

    DetailPrint `records cleanup finished, failures: $removeRecordsFailed`
  FunctionEnd

  Function un.wipeAppRecordsInner
    ; ① 数据根下的固定文件
    StrCpy $R0 "$cleanRoot\config.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\secrets.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\memory.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\mcp.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\tasks.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\read-state.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\worktrees.json"
    Call un.deleteDataFile
    StrCpy $R0 "$cleanRoot\.magpie-agent.state.json"
    Call un.deleteDataFile

    ; ② 数据根下的目录（逐个固定叶子名；worktrees 不在此列——那是代码）
    StrCpy $R0 "$cleanRoot\data"
    StrCpy $R1 "data"
    Call un.deleteDataTree
    StrCpy $R0 "$cleanRoot\personas"
    StrCpy $R1 "personas"
    Call un.deleteDataTree
    StrCpy $R0 "$cleanRoot\skills"
    StrCpy $R1 "skills"
    Call un.deleteDataTree
    StrCpy $R0 "$cleanRoot\projects"
    StrCpy $R1 "projects"
    Call un.deleteDataTree
    StrCpy $R0 "$cleanRoot\uploads"
    StrCpy $R1 "uploads"
    Call un.deleteDataTree
    StrCpy $R0 "$cleanRoot\profile"
    StrCpy $R1 "profile"
    Call un.deleteDataTree

    ; ③ Electron userData：只在能确认是本应用时才删（Local State 是 Chromium profile 的标志）。
    ;    原版的 $APPDATA\@deva\desktop 不在名单里，绝不碰。
    StrCpy $R0 "$APPDATA\devaplus"
    ${If} ${FileExists} "$R0\Local State"
      StrCpy $R1 "devaplus"
      Call un.deleteDataTree
    ${EndIf}
    StrCpy $R0 "$APPDATA\DevaPlus"
    ${If} ${FileExists} "$R0\Local State"
      StrCpy $R1 "DevaPlus"
      Call un.deleteDataTree
    ${EndIf}

    ; ④ 更新缓存与 Electron 缓存
    StrCpy $R0 "$LOCALAPPDATA\devaplus-updater"
    StrCpy $R1 "devaplus-updater"
    Call un.deleteDataTree
    StrCpy $R0 "$LOCALAPPDATA\devaplus"
    StrCpy $R1 "devaplus"
    Call un.deleteDataTree
  FunctionEnd

!macroend

; 卸载 Section 内、删除程序文件之前执行（顺序见模板 uninstaller.nsh：
; customUnInstall → customRemoveFiles/RMDir）。$removeAllRecords 只可能由上面那一页置 1。
!macro customUnInstall
  ${If} $removeAllRecords == "1"
    Call un.wipeAppRecords
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER