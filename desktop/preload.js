const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('peermesh', {
  getState: () => ipcRenderer.invoke('get-state'),
  getExtId: () => ipcRenderer.invoke('get-ext-id'),
  checkWebsiteAuth: () => ipcRenderer.invoke('check-website-auth'),
  openAuth: () => ipcRenderer.invoke('open-auth'),
  signIn: (data) => ipcRenderer.invoke('sign-in', data),
  toggleSharing: () => ipcRenderer.invoke('toggle-sharing'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
})
