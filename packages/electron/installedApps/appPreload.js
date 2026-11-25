// Preload for an installed app's window (protocol.appWebPreferences). The
// window is sandboxed, so this file can require nothing but electron itself:
// the page client arrives base64-encoded in the renderer's command line
// (CLIENT_ARG) and runs in the page's world before the page's own scripts.
// The channel names and CLIENT_ARG repeat protocol.js's; protocol.test.js
// keeps them equal.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const CHANNELS = { call: "cast-app:call", event: "cast-app:event" };
const CLIENT_ARG = "--cast-app-client=";

contextBridge.exposeInMainWorld("__castAppTransport", {
  call: (msg) => ipcRenderer.invoke(CHANNELS.call, msg),
  onEvent: (cb) => {
    ipcRenderer.on(CHANNELS.event, (_e, ev) => cb(ev));
  },
});

const arg = process.argv.find((a) => a.startsWith(CLIENT_ARG));
if (arg) webFrame.executeJavaScript(Buffer.from(arg.slice(CLIENT_ARG.length), "base64").toString("utf8"));
