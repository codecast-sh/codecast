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
contextBridge.exposeInMainWorld(globalName, createBridge({ ipcRenderer, argv: process.argv }));
