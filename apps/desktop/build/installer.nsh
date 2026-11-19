; electron-builder 会自动引入 buildResources 下的 installer.nsh，这里只挂官方提供的自定义宏

; 选完安装目录后检测这个目录能不能用，分两项，都在开始安装前拦下：
;
; 1. 必须为空。卸载器删的是整个安装目录（RMDir /r $INSTDIR），与别人的文件混放在一起会被一并删掉。
;    目录不存在或为空都算通过。
; 2. 必须可写。「仅为我安装」时安装器不提权，选到没有写入权限的目录（如 Program Files）会在复制文件时
;    误报「Deva 无法关闭」，重试后又报写入卸载程序失败，忽略下去只留下指向空目录的快捷方式。
;
; 两项都通过就直接跳过本页；否则显示本页说明原因，让用户返回更换目录或改为所有用户安装
!macro customPageAfterChangeDir
  !include nsDialogs.nsh

  Var dirCheckTarget
  ; "" 表示通过；"notempty" 目录非空；"nowrite" 不可写
  Var dirCheckProblem
  ; 1 = 目标目录里已有本产品（升级/重装）
  Var dirCheckUpgrade

  Page custom dirCheckPageCreate dirCheckPageLeave

  ; 插入本页后，NSIS 不再把目录页的按钮显示为「安装」而是「下一步」，可写时本页又被跳过，点下去就直接装了。
  ; .onVerifyInstDir 只在目录页加载和路径改动时触发，借它把按钮文字改回「安装」
  Function .onVerifyInstDir
    Push $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    Pop $0
  FunctionEnd

  ; 结果写入 $dirCheckProblem："" 通过 / "notempty" 目录非空 / "nowrite" 不可写；
  ; 检查的目标目录写入 $dirCheckTarget
  Function dirCheckRun
    Push $0
    Push $1
    Push $2

    StrCpy $dirCheckTarget $INSTDIR
    !ifdef allowToChangeInstallationDirectory
      ; 与模板里的 instFilesPre 一致：路径不含应用名时，实际装到其下的应用名子目录。
      ; 后面的检查必须基于这个路径，否则会「检查的目录」和「实际安装的目录」不是同一个
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${if} $0 == ""
        StrCpy $dirCheckTarget "$INSTDIR\${APP_FILENAME}"
      ${endif}
    !endif

    StrCpy $dirCheckProblem ""

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
    ${if} $dirCheckProblem == "notempty"
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
    ${if} $dirCheckProblem == "notempty"
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
