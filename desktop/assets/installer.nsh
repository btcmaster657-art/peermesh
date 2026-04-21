; PeerMesh installer/uninstaller hooks

; Shared macro to kill all PeerMesh processes cleanly
!macro KillPeerMesh
  ; 1. Ask the running app to quit gracefully via its control server
  ;    (works whether the window is visible or hidden in the tray)
  ;    Use PowerShell's Invoke-WebRequest — always available on Win10+
  nsExec::ExecToLog '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NonInteractive -WindowStyle Hidden -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:7654/quit -Method POST -TimeoutSec 3 -UseBasicParsing | Out-Null } catch {}"'
  Sleep 2500

  ; 2. Force-kill any remaining Electron processes by name
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper.exe"'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (GPU).exe"'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (Renderer).exe"'
  nsExec::ExecToLog '$SYSDIR\taskkill.exe /F /IM "PeerMesh Helper (Plugin).exe"'

  ; 3. Wait until the process is actually gone (poll up to 10s)
  StrCpy $R1 0
  ${Do}
    Sleep 500
    nsExec::ExecToStack '$SYSDIR\tasklist.exe /FI "IMAGENAME eq PeerMesh.exe" /NH'
    Pop $R2
    ${If} $R2 == ""
      ${Break}
    ${EndIf}
    ${If} $R2 == "INFO: No tasks are running which match the specified criteria."
      ${Break}
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      ${Break}
    ${EndIf}
  ${Loop}
!macroend

; Shared macro to remove all PeerMesh artifacts
!macro CleanPeerMeshArtifacts
  ; Electron userData (config, logs, cache)
  RMDir /r "$APPDATA\peermesh-desktop"
  RMDir /r "$APPDATA\PeerMesh"

  ; Updater/cache folders left behind by previous installs
  RMDir /r "$LOCALAPPDATA\peermesh-desktop-updater"
  RMDir /r "$LOCALAPPDATA\PeerMesh-updater"

  ; Native messaging host manifests written by registerNativeMessagingHost()
  Delete "$APPDATA\Google\Chrome\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Google\Chrome Beta\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Google\Chrome Dev\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Chromium\NativeMessagingHosts\com.peermesh.desktop.json"
  Delete "$APPDATA\Microsoft\Edge\NativeMessagingHosts\com.peermesh.desktop.json"

  ; Native messaging registry keys written by registerNativeMessagingHost()
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.peermesh.desktop"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.peermesh.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.peermesh.desktop"

  ; Login item written by app.setLoginItemSettings({ openAtLogin: true })
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeerMesh"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "peermesh-desktop"

  ; Startup shortcut that Electron may have created
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\PeerMesh.lnk"
  RMDir /r "$SMPROGRAMS\PeerMesh"
!macroend

!macro CleanPeerMeshInstallDirs
  RMDir /r "$LOCALAPPDATA\Programs\PeerMesh"
  RMDir /r "$LOCALAPPDATA\Programs\peermesh-desktop"
  RMDir /r "$PROGRAMFILES\PeerMesh"
  RMDir /r "$PROGRAMFILES64\PeerMesh"
!macroend

!macro customInstall
  DetailPrint "Stopping existing PeerMesh instance..."
  !insertmacro KillPeerMesh

  ; Uninstall previous version silently if registry entry exists
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PeerMesh" "UninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing previous version..."
    nsExec::ExecToLog '$R0 /S'
    Sleep 3000
    ; Previous uninstaller may not have cleaned all artifacts
    !insertmacro CleanPeerMeshArtifacts
    !insertmacro CleanPeerMeshInstallDirs
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Stopping PeerMesh..."
  !insertmacro KillPeerMesh
  DetailPrint "Removing PeerMesh files and registry entries..."
  !insertmacro CleanPeerMeshArtifacts
  !insertmacro CleanPeerMeshInstallDirs
!macroend
