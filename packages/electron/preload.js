const { contextBridge, ipcRenderer, webFrame } = require("electron");

const zoomArg = process.argv.find(a => a.startsWith('--zoom-factor='));
if (zoomArg) {
  const z = parseFloat(zoomArg.split('=')[1]);
  if (z && isFinite(z)) webFrame.setZoomFactor(z);
}

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
  paletteNewSession: () => ipcRenderer.send("palette-new-session"),
  onPaletteShow: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("palette-show", handler);
    return () => ipcRenderer.removeListener("palette-show", handler);
  },
  platform: process.platform,
});
