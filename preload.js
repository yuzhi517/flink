const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flink", {
  platform: process.platform,
  unlock: (code) => ipcRenderer.invoke("unlock", code),
  forgetSession: () => ipcRenderer.invoke("forget-session"),
  connect: (mode, region) => ipcRenderer.invoke("connect", mode, region),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  status: () => ipcRenderer.invoke("status"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  latency: () => ipcRenderer.invoke("latency"),
  installUpdate: (payload) => ipcRenderer.invoke("install-update", payload),
  onUpdateProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("update-progress", handler);
    return () => ipcRenderer.removeListener("update-progress", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
