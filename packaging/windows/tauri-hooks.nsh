; 覆盖 Tauri 默认的强制关闭逻辑；仅检查当前选定目录中的应用。
!define WIFIMETER_LEGACY_HELPER "${__FILEDIR__}/stop-legacy.ps1"
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-legacy.ps1 "${WIFIMETER_LEGACY_HELPER}"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\stop-legacy.ps1" -InstallDirectory "$INSTDIR\."'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ${If} $LANGUAGE == 2052
      MessageBox MB_OK|MB_ICONSTOP "无法确认程序已安全退出，请退出 WiFiMeter 后重试。" /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "WiFiMeter could not confirm a safe exit. Close WiFiMeter and retry." /SD IDOK
    ${EndIf}
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
