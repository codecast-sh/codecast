// An Electron window for `computer-bgmouse-matrix.ts`: one page-sized button,
// shown without activating the app, read back over DevTools on the port
// given as the first argument after the script.
//
//   Electron computer-electron-fixture.cjs <devtools-port> <page.html>

const { app, BrowserWindow } = require("electron");

const [port, page] = process.argv.slice(-2);
app.commandLine.appendSwitch("remote-debugging-port", port);

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 640, height: 420, x: 420, y: 300, show: false, title: "Electron Probe" });
  win.loadFile(page);
  win.once("ready-to-show", () => {
    win.showInactive();
    console.log(`READY pid=${process.pid} windows=Electron Probe=${win.getMediaSourceId()}`);
  });
});
