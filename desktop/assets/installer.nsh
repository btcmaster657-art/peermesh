; Kill running PeerMesh processes before install or uninstall
!macro customInstall
  DetailPrint "Stopping PeerMesh processes..."
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "node.exe" /T'
  Sleep 3000

  ; Uninstall previous version if it exists
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeerMesh" "UninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing previous version..."
    nsExec::ExecToLog '$R0 /S'
    Sleep 3000
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Stopping PeerMesh processes..."
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "node.exe" /T'
  Sleep 3000
!macroend
