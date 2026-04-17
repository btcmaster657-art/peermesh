const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('peermesh', {
  getState: () => ipcRenderer.invoke('get-state'),
  signIn: (data) => ipcRenderer.invoke('sign-in', data),
  toggleSharing: () => ipcRenderer.invoke('toggle-sharing'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
})
