; Kill running PeerMesh processes before install or uninstall
!macro customInstall
  nsExec::ExecToLog 'taskkill /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "PeerMesh.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000
!macroend
