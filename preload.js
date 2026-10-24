const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flink", {
  platform: process.platform,
  unlock: (code) => ipcRenderer.invoke("unlock", code),
  connect: (mode) => ipcRenderer.invoke("connect", mode),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  status: () => ipcRenderer.invoke("status"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: (payload) => ipcRenderer.invoke("install-update", payload),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
