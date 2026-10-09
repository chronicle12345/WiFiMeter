; Tauri CLI 2.12.1 includes installer_hooks after utils.nsh and before macro use.
; See SOURCES.md. Replace every check, including checks in the uninstaller.
!include /CHARSET=UTF8 "${__FILEDIR__}\..\..\windows\installer.nsh"

!ifmacrondef CheckIfAppIsRunning
  !error "The Tauri installer template changed: review the safe exit guard before building."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !insertmacro customCheckAppRunning
!macroend
