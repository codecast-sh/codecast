const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__CODECAST_ELECTRON__", {
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  setBadgeCount: (count) => ipcRenderer.invoke("set-badge-count", count),
  getEnv: () => ipcRenderer.invoke("get-env"),
  onDeepLink: (cb) => {
    ipcRenderer.on("deep-link", (_e, url) => cb(url));
  },
  platform: process.platform,
});
