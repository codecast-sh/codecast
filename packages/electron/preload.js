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
  showNotification: (title, body, data) => ipcRenderer.invoke("show-notification", { title, body, data }),
  getShortcuts: () => ipcRenderer.invoke("get-shortcuts"),
  setShortcut: (key, accelerator) => ipcRenderer.invoke("set-shortcut", key, accelerator),
  paletteNavigate: (path) => ipcRenderer.send("palette-navigate", path),
  paletteHide: () => ipcRenderer.send("palette-hide"),
  paletteCompose: (initialMessage) => ipcRenderer.send("palette-compose", initialMessage),
  onPaletteShow: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("palette-show", handler);
    return () => ipcRenderer.removeListener("palette-show", handler);
  },
  onComposeShow: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("compose-show", handler);
    return () => ipcRenderer.removeListener("compose-show", handler);
  },
  platform: process.platform,
});
