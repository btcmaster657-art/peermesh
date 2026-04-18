; Kill running PeerMesh processes before install or uninstall
!macro customInstall
  DetailPrint "Stopping PeerMesh..."
  ; Graceful quit via control server using PowerShell
  nsExec::ExecToLog '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NonInteractive -WindowStyle Hidden -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:7654/quit -Method POST -TimeoutSec 3 -UseBasicParsing | Out-Null } catch {}"'
  ; Wait up to 5s for process to exit
  Sleep 3000
  ; Force-kill anything still running
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "electron.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "node.exe" /T'
  Sleep 2000

  ; Uninstall previous version if it exists
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeerMesh" "UninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing previous version..."
    nsExec::ExecToLog '$R0 /S'
    Sleep 3000
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Stopping PeerMesh..."
  ; Graceful quit via control server using PowerShell
  nsExec::ExecToLog '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NonInteractive -WindowStyle Hidden -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:7654/quit -Method POST -TimeoutSec 3 -UseBasicParsing | Out-Null } catch {}"'
  ; Wait up to 5s for process to exit
  Sleep 3000
  ; Force-kill anything still running
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "electron.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "node.exe" /T'
  Sleep 2000
  ; Remove saved credentials (Electron userData)
  RMDir /r "$APPDATA\peermesh-desktop"
!macroend
