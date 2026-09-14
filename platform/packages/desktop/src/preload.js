// Preload for every window the shell opens. Point webPreferences.preload here
// (createDesktopApp does) and pass `--bridge-global=<name>` through
// additionalArguments; the bridge object itself is built by bridge.js.
const { contextBridge, ipcRenderer, webFrame } = require("electron");
const { createBridge, argValue } = require("./bridge");

const zoomArg = process.argv.find(a => a.startsWith('--zoom-factor='));
if (zoomArg) {
  const z = parseFloat(zoomArg.split('=')[1]);
  if (z && isFinite(z)) webFrame.setZoomFactor(z);
}

const globalName = argValue(process.argv, "bridge-global") || "__DESKTOP_ELECTRON__";

// The bridge is the app's own private door into the shell, so it is opened
// only for the app's own origins. A window should never be showing anything
// else — the main process refuses off-origin navigation — but a preload runs
// again on every document, which makes this the one place that can be certain
// about the page it is actually attached to. Without the argument (an older
// configuration) the previous behavior stands.
const allowed = (argValue(process.argv, "bridge-origins") || "").split(",").filter(Boolean);
const origin = (() => {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
})();

if (allowed.length === 0 || allowed.includes(origin)) {
  contextBridge.exposeInMainWorld(globalName, createBridge({ ipcRenderer, argv: process.argv }));
}
