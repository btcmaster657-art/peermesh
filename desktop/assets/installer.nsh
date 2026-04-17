; Kill running PeerMesh processes before install or uninstall
!macro customInstall
  nsExec::ExecToLog 'taskkill /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000

  ; Uninstall previous version if it exists
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeerMesh" "UninstallString"
  ${If} $R0 != ""
    nsExec::ExecToLog '$R0 /S'
    Sleep 2000
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000
!macroend
