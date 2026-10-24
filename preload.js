const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yulink", {
  platform: process.platform,
  unlock: (code) => ipcRenderer.invoke("unlock", code),
  connect: (mode) => ipcRenderer.invoke("connect", mode),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  status: () => ipcRenderer.invoke("status"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
