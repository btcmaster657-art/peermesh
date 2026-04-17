const { contextBridge, ipcRenderer } = require('electron')
const { version } = require('./package.json')

contextBridge.exposeInMainWorld('peermesh', {
  version,
  getState: () => ipcRenderer.invoke('get-state'),
  getExtId: () => ipcRenderer.invoke('get-ext-id'),
  checkWebsiteAuth: () => ipcRenderer.invoke('check-website-auth'),
  openAuth: (url) => ipcRenderer.invoke('open-auth', url),
  signIn: (data) => ipcRenderer.invoke('sign-in', data),
  toggleSharing: () => ipcRenderer.invoke('toggle-sharing'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  requestDeviceCode: () => ipcRenderer.invoke('request-device-code'),
  pollDeviceCode: (device_code) => ipcRenderer.invoke('poll-device-code', { device_code }),
})
