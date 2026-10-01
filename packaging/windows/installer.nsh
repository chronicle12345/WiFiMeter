!include "LogicLib.nsh"
!define WIFIMETER_LEGACY_HELPER "${__FILEDIR__}\stop-legacy.ps1"

; Runs at CHECK_APP_RUNNING after the installation directory has been selected.
; Also replaces the uninstaller check; no fallback process termination is allowed.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-legacy.ps1 "${WIFIMETER_LEGACY_HELPER}"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\stop-legacy.ps1" -InstallDirectory "$INSTDIR\."'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "WiFiMeter could not confirm a safe exit. Close WiFiMeter and retry. / 无法确认程序已安全退出，请退出 WiFiMeter 后重试。$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend
