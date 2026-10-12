; Tauri CLI 2.12.1 includes installer_hooks after utils.nsh and before macro use.
; See SOURCES.md. Replace every check, including checks in the uninstaller.
; 增大 LZMA 字典，减小安装包体积。
SetCompressorDictSize 64
!include /CHARSET=UTF8 "${__FILEDIR__}\process-guard.nsh"

!ifmacrondef CheckIfAppIsRunning
  !error "The Tauri installer template changed: review the safe exit guard before building."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !insertmacro customCheckAppRunning
!macroend

Var WiFiMeterRepairDirectory
!define WIFIMETER_REPAIR_HELPER "${__FILEDIR__}\..\..\windows\repair-uninstall.ps1"
!macro WiFiMeterRecoverMissingUninstaller
  Push $0
  Push $1
  StrCpy $WiFiMeterRepairDirectory ""
  InitPluginsDir
  File /oname=$PLUGINSDIR\repair-uninstall.ps1 "${WIFIMETER_REPAIR_HELPER}"
  !if "${ARCH}" == "x86"
    !define WIFIMETER_REPAIR_REGVIEW "32"
  !else
    !define WIFIMETER_REPAIR_REGVIEW "64"
  !endif
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\repair-uninstall.ps1" -ProductName "${PRODUCTNAME}" -Publisher "${MANUFACTURER}" -RegistryView ${WIFIMETER_REPAIR_REGVIEW}'
  !undef WIFIMETER_REPAIR_REGVIEW
  Pop $0
  Pop $1
  ${If} $0 == 0
    ReadRegStr $WiFiMeterRepairDirectory SHCTX "${UNINSTKEY}" "InstallLocation"
    StrCpy $0 $WiFiMeterRepairDirectory 1
    StrCpy $1 $WiFiMeterRepairDirectory 1 -1
    ${If} $0 == '$\"'
    ${AndIf} $1 == '$\"'
      StrCpy $WiFiMeterRepairDirectory $WiFiMeterRepairDirectory -1 1
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend
