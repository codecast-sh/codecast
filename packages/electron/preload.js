const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__CODECAST_ELECTRON__", {
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  setBadgeCount: (count) => ipcRenderer.invoke("set-badge-count", count),
  getEnv: () => ipcRenderer.invoke("get-env"),
  onDeepLink: (cb) => {
    ipcRenderer.on("deep-link", (_e, url) => cb(url));
  },
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update-status", (_e, status) => cb(status));
  },
  restartForUpdate: () => ipcRenderer.invoke("restart-for-update"),
  platform: process.platform,
});
