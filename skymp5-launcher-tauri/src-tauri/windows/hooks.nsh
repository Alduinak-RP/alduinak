; Moves players off the Electron launcher (2.x): its uninstaller runs silently before the files land,
; and the new launcher starts afterwards because Electron passes --force-run instead of /R

!macro NSIS_HOOK_PREINSTALL
  ; Electron's updater quits a moment after starting this installer
  Sleep 2000
  StrCpy $R8 0
  alduinak_electron_loop:
    EnumRegKey $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R8
    StrCmp $R9 "" alduinak_electron_done
    IntOp $R8 $R8 + 1
    ReadRegStr $R7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R9" "InstallLocation"
    StrCmp $R7 "" alduinak_electron_loop
    IfFileExists "$R7\Uninstall Alduinak Launcher.exe" 0 alduinak_electron_loop
    DetailPrint "Removing the old Electron launcher from $R7"
    ; _?= keeps the uninstaller in place so ExecWait waits for it
    ExecWait '"$R7\Uninstall Alduinak Launcher.exe" /S _?=$R7'
    Delete "$R7\Uninstall Alduinak Launcher.exe"
    ; Only an emptied folder goes; whatever else the player keeps there stays
    RMDir "$R7"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R9"
    ; The key list shifted, so start the walk again
    StrCpy $R8 0
    Goto alduinak_electron_loop
  alduinak_electron_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  IfErrors +2 0
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend
