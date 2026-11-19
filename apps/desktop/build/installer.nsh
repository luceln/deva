; electron-builder 会自动引入 buildResources 下的 installer.nsh，这里只挂官方提供的自定义宏

; 让「浏览」选完目录后自动补上应用名，手输则一个字都不改。
;
; 用的是 NSIS 引擎自带的能力：目录页收到浏览结果后（Source/exehead/Ui.c，SHBrowseForFolder 返回之后）
; 会把 InstallDir 末段作为应用名追加到所选路径后面，手输完全不经过那段代码，所以天然只作用于浏览。
; 引擎还会比对所选目录名与该末段，相同就不追加，浏览到 …\DevaPlus 不会变成 …\DevaPlus\DevaPlus。
;
; 这段只在编译期生效：InstallDir 的末段被记进脚本头（install_directory_auto_append），
; ${APP_FILENAME} 在这里会先展开成 DevaPlus。运行时 $INSTDIR 仍由 multiUser.nsh 在 .onInit 里按
; 安装范围设定（默认 %LOCALAPPDATA%\Programs\DevaPlus），这里写的字面量只是承载那个名字。
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

; 选完安装目录后检测这个目录能不能用，三项，都在开始安装前拦下：
;
; 1. 不能是驱动器根目录。模板里的 instFilesPre 原本会用「路径不含应用名就追加」兜住这种情况（D:\ 会变成
;    D:\DevaPlus），但那个追加对手输同样生效，会把「手输不追加」弄坏，所以下面把它关掉了。代价就是手输 D:\
;    会真的装到盘根，而卸载器删的是整个 $INSTDIR（RMDir /r），那会删掉整块盘——因此这一项单独拦下。
; 2. 必须为空。卸载器删的是整个安装目录，与别人的文件混放在一起会被一并删掉。目录不存在或为空都算通过。
; 3. 必须可写。「仅为我安装」时安装器不提权，选到没有写入权限的目录（如 Program Files）会在复制文件时
;    误报「Deva 无法关闭」，重试后又报写入卸载程序失败，忽略下去只留下指向空目录的快捷方式。
;
; 三项都通过就直接跳过本页；否则显示本页说明原因，让用户返回更换目录或改为所有用户安装
!macro customPageAfterChangeDir
  !include nsDialogs.nsh

  Var dirCheckTarget
  ; "" 表示通过；"root" 驱动器根目录或共享根；"notempty" 目录非空；"nowrite" 不可写
  Var dirCheckProblem
  ; 1 = 目标目录里已有本产品（升级/重装）
  Var dirCheckUpgrade
  Var dirCheckRawDir

  ; 关掉模板里 instFilesPre 的隐式追加：它对手输的路径也生效（D:\Apps 会变成 D:\Apps\DevaPlus），
  ; 而浏览已经由引擎补过了，再补一次就成了 …\DevaPlus\DevaPlus，手输的还会被强行改写。
  ;
  ; 不能直接 !undef 到不定义：那样 assistedInstaller.nsh 里的 Function instFilesPre 就没人引用，
  ; makensis 对未引用函数会告警，构建开了 -WX（告警即失败）。所以仍调它一次，把 $INSTDIR 备份后还原，
  ; 净效果等于没追加。本宏的插入点在 MUI_PAGE_CUSTOMFUNCTION_PRE 定义之后、MUI_PAGE_INSTFILES 之前，
  ; 这个覆盖时机是成立的。
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE dirCheckInstFilesPre

    Function dirCheckInstFilesPre
      StrCpy $dirCheckRawDir $INSTDIR
      Call instFilesPre
      StrCpy $INSTDIR $dirCheckRawDir
    FunctionEnd
  !endif

  Page custom dirCheckPageCreate dirCheckPageLeave

  ; 插入本页后，NSIS 不再把目录页的按钮显示为「安装」而是「下一步」，通过时本页又被跳过，点下去就直接装了。
  ; .onVerifyInstDir 只在目录页加载和路径改动时触发，借它把按钮文字改回「安装」
  Function .onVerifyInstDir
    Push $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    Pop $0
  FunctionEnd

  ; 结果写入 $dirCheckProblem："" 通过 / "root" 驱动器或共享根 / "notempty" 目录非空 / "nowrite" 不可写；
  ; 检查的目标目录写入 $dirCheckTarget
  Function dirCheckRun
    Push $0
    Push $1
    Push $2

    ; 检查的就是目录页里显示的路径本身。浏览时引擎已经把应用名补进编辑框了，手输的则一个字没动，
    ; 这里再补一次会把「手输不追加」破坏掉（也会把浏览过的路径补成 …\DevaPlus\DevaPlus）
    StrCpy $dirCheckTarget $INSTDIR
    StrCpy $dirCheckProblem ""

    ; 去掉末尾多余的反斜杠：浏览返回的路径带尾斜杠（C:\Apps\），不去掉会拼出 C:\Apps\\*.*。
    ; 盘符根 C:\ 要留着反斜杠，否则「根目录」这个判据就没了
    ${Do}
      StrLen $0 $dirCheckTarget
      ${If} $0 < 4
        ${ExitDo}
      ${EndIf}
      StrCpy $1 $dirCheckTarget 1 -1
      ${If} $1 != "\"
        ${ExitDo}
      ${EndIf}
      IntOp $2 $0 - 1
      StrCpy $dirCheckTarget $dirCheckTarget $2
    ${Loop}

    ; 驱动器根目录（D:\ 或 D:）：模板里的 instFilesPre 原本会把 D:\ 补成 D:\DevaPlus 从而兜住这种情况，
    ; 但那个追加对手输同样生效，已被关掉。若不在这里拦，D:\ 会真的装到盘根，
    ; 卸载时 RMDir /r D:\ 会删掉整块盘
    StrLen $0 $dirCheckTarget
    ${If} $0 == 2
      StrCpy $1 $dirCheckTarget 1 1
      ${If} $1 == ":"
        StrCpy $dirCheckProblem "root"
      ${EndIf}
    ${ElseIf} $0 == 3
      StrCpy $1 $dirCheckTarget 1 1
      StrCpy $2 $dirCheckTarget 1 2
      ${If} $1 == ":"
      ${AndIf} $2 == "\"
        StrCpy $dirCheckProblem "root"
      ${EndIf}
    ${EndIf}

    ; 共享根 \\server\share：反斜杠恰好三个。再往下就是共享里的子目录，那些是安全的
    ${If} $dirCheckProblem == ""
      StrCpy $0 $dirCheckTarget 2
      ${If} $0 == "\\"
        StrCpy $1 0
        StrCpy $2 0
        ${Do}
          StrLen $0 $dirCheckTarget
          ${If} $2 >= $0
            ${ExitDo}
          ${EndIf}
          StrCpy $0 $dirCheckTarget 1 $2
          ${If} $0 == "\"
            IntOp $1 $1 + 1
          ${EndIf}
          IntOp $2 $2 + 1
        ${Loop}
        ${If} $1 == 2
          StrCpy $dirCheckProblem "root"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ${If} $dirCheckProblem != ""
      Pop $2
      Pop $1
      Pop $0
      Return
    ${EndIf}

    ; 目标目录里已经有本产品的卸载器和主程序，说明这是重装/升级（用户手动重跑安装包），目录里那些文件是
    ; 上一版装的，不是别人的东西。此时跳过「必须为空」——否则升级会被永远挡住。可写检查照常做
    StrCpy $dirCheckUpgrade 0
    ${If} ${FileExists} "$dirCheckTarget\${UNINSTALL_FILENAME}"
    ${AndIf} ${FileExists} "$dirCheckTarget\${APP_EXECUTABLE_FILENAME}"
      StrCpy $dirCheckUpgrade 1
    ${EndIf}

    ${If} $dirCheckUpgrade == 0
      ; 安装目录必须为空：卸载器删的是整个 $INSTDIR（RMDir /r），与其它文件混放会被一并删掉。
      ; 目录不存在或为空时 FindFirst 拿不到任何条目，直接算空；存在时先返回 "." 和 ".."，跳过它们再看
      StrCpy $1 1
      FindFirst $0 $2 "$dirCheckTarget\*.*"
      ${Do}
        ${If} $2 == ""
          ${ExitDo}
        ${EndIf}
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          StrCpy $1 0
          ${ExitDo}
        ${EndIf}
        FindNext $0 $2
      ${Loop}
      FindClose $0

      ${If} $1 == 0
        StrCpy $dirCheckProblem "notempty"
        Pop $2
        Pop $1
        Pop $0
        Return
      ${EndIf}
    ${EndIf}

    ; 记下最近一个已存在的上级目录：检测时可能连建多级目录，检测完要把新建的空目录逐级删掉，
    ; 免得用户返回换目录后留下垃圾
    StrCpy $1 $dirCheckTarget
    ${Do}
      ${If} $1 == ""
      ${OrIf} ${FileExists} "$1\*.*"
        ${ExitDo}
      ${EndIf}
      ${GetParent} $1 $1
    ${Loop}

    ClearErrors
    CreateDirectory "$dirCheckTarget"
    FileOpen $2 "$dirCheckTarget\.deva-write-test" w
    ${IfNot} ${Errors}
      FileClose $2
      Delete "$dirCheckTarget\.deva-write-test"
    ${Else}
      StrCpy $dirCheckProblem "nowrite"
    ${EndIf}

    ; RMDir 不带 /r 只删空目录，安装目录里原有的文件不会被动到
    StrCpy $0 $dirCheckTarget
    ${Do}
      ${If} $0 == $1
      ${OrIf} $0 == ""
        ${ExitDo}
      ${EndIf}
      RMDir "$0"
      ${GetParent} $0 $0
    ${Loop}

    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; 提示文字按界面语言在运行时选：installer 默认加载几十种语言，LangString 缺任何一种都会因 -WX 构建失败
  Function dirCheckMessage
    ${if} $dirCheckProblem == "root"
      ${if} $LANGUAGE == 2052
        Push "不能把 DevaPlus 直接装在驱动器根目录或共享根目录下：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n请点击「上一步」，改成一个专用的子目录（例如 D:\Apps\DevaPlus），或点「浏览」选择一个文件夹。$\r$\n$\r$\n卸载时会删除整个安装目录，装在根目录下会把整块盘或整个共享里的文件一起删掉。"
      ${elseif} $LANGUAGE == 1028
        Push "不能把 DevaPlus 直接安裝在磁碟機根目錄或共用根目錄下：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n請點擊「上一步」，改成一個專用的子目錄（例如 D:\Apps\DevaPlus），或點「瀏覽」選擇一個資料夾。$\r$\n$\r$\n解除安裝時會刪除整個安裝目錄，裝在根目錄下會把整顆磁碟或整個共用裡的檔案一起刪除。"
      ${else}
        Push "DevaPlus cannot be installed directly into a drive root or a share root:$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\nClick Back and use a dedicated subfolder instead (for example D:\Apps\DevaPlus), or click Browse and pick a folder.$\r$\n$\r$\nUninstalling deletes the whole installation folder, so installing at a root would wipe every file on that drive or share."
      ${endif}
    ${elseIf} $dirCheckProblem == "notempty"
      ${if} $LANGUAGE == 2052
        Push "所选目录不是空的：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n里面还有其它文件。请点击「上一步」更换安装目录，或新建一个空目录后再选择它。$\r$\n$\r$\n安装程序需要独占这个目录：卸载时会删除整个目录，与其它文件混放在一起会被一并删除。"
      ${elseif} $LANGUAGE == 1028
        Push "所選目錄不是空的：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n裡面還有其它檔案。請點擊「上一步」更換安裝目錄，或新建一個空目錄後再選擇它。$\r$\n$\r$\n安裝程式需要獨佔這個目錄：解除安裝時會刪除整個目錄，與其它檔案混放在一起會被一併刪除。"
      ${else}
        Push "The selected folder is not empty:$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\nIt still contains other files. Click Back to choose another folder, or create a new empty folder and select that one.$\r$\n$\r$\nThe installer needs this folder to itself: uninstalling deletes the whole folder, so anything else stored in it would be deleted too."
      ${endif}
    ${else}
      ${if} $LANGUAGE == 2052
        Push "当前账户没有以下目录的写入权限：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n请点击「上一步」更换安装目录。如需安装到该目录，请返回安装选项页选择「为使用这台电脑的任何人安装」，或右键安装包选择「以管理员身份运行」。"
      ${elseif} $LANGUAGE == 1028
        Push "目前帳戶沒有以下目錄的寫入權限：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n請點擊「上一步」更換安裝目錄。如需安裝到該目錄，請返回安裝選項頁選擇「為使用這台電腦的任何人安裝」，或右鍵安裝程式選擇「以系統管理員身分執行」。"
      ${else}
        Push "The current account cannot write to this folder:$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\nClick Back to choose another folder. To install here, go back to the installation options and choose $\"Anyone who uses this computer$\", or right-click the installer and choose $\"Run as administrator$\"."
      ${endif}
    ${endif}
  FunctionEnd

  Function dirCheckHeader
    ${if} $dirCheckProblem == "root"
      ${if} $LANGUAGE == 2052
        !insertmacro MUI_HEADER_TEXT "无法安装到该目录" "不能装在驱动器根目录下。"
      ${elseif} $LANGUAGE == 1028
        !insertmacro MUI_HEADER_TEXT "無法安裝到該目錄" "不能裝在磁碟機根目錄下。"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Cannot install to this folder" "A drive root is not allowed."
      ${endif}
    ${elseIf} $dirCheckProblem == "notempty"
      ${if} $LANGUAGE == 2052
        !insertmacro MUI_HEADER_TEXT "无法安装到该目录" "请选择一个空目录。"
      ${elseif} $LANGUAGE == 1028
        !insertmacro MUI_HEADER_TEXT "無法安裝到該目錄" "請選擇一個空目錄。"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Cannot install to this folder" "Choose an empty folder."
      ${endif}
    ${else}
      ${if} $LANGUAGE == 2052
        !insertmacro MUI_HEADER_TEXT "无法写入安装目录" "请更换安装目录，或以管理员权限安装。"
      ${elseif} $LANGUAGE == 1028
        !insertmacro MUI_HEADER_TEXT "無法寫入安裝目錄" "請更換安裝目錄，或以系統管理員權限安裝。"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Cannot write to the installation folder" "Choose another folder, or install with administrator rights."
      ${endif}
    ${endif}
  FunctionEnd

  Function dirCheckPageCreate
    ; 自动更新沿用原安装目录，不做拦截
    ${if} ${isUpdated}
      Abort
    ${endif}

    Call dirCheckRun
    ${if} $dirCheckProblem == ""
      Abort
    ${endif}

    Call dirCheckHeader

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    Call dirCheckMessage
    Pop $1
    ${NSD_CreateLabel} 0 0 100% 100% "$1"
    Pop $0

    ; 本页只能「上一步」或「取消」：禁用「安装」按钮（禁用后回车键也不会触发它）
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0
    ${NSD_OnBack} dirCheckPageBack

    nsDialogs::Show
  FunctionEnd

  ; 返回目录页时重新启用「安装」按钮，否则它会一直保持禁用
  Function dirCheckPageBack
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
  FunctionEnd

  ; 兜底：按钮已禁用，正常走不到这里；万一进入了，仍不合格就留在本页
  Function dirCheckPageLeave
    Call dirCheckRun
    ${if} $dirCheckProblem != ""
      Call dirCheckMessage
      Pop $1
      MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
      Abort
    ${endif}
  FunctionEnd
!macroend
