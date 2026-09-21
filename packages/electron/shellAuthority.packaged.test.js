const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

test("packaged shell contains foreign navigation and exposes no bridge to foreign documents or frames", { skip: process.platform !== "darwin", timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codecast-authority-package-"));
  const app = join(dir, "Fixture.app");
  cpSync(resolve(require("electron"), "../../.."), app, { recursive: true, verbatimSymlinks: true });
  renameSync(join(app, "Contents/MacOS/Electron"), join(app, "Contents/MacOS/AuthorityFixture"));
  execFileSync("plutil", ["-replace", "CFBundleExecutable", "-string", "AuthorityFixture", join(app, "Contents/Info.plist")]);
  const resources = join(app, "Contents/Resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const source = join(resources, "app");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "codecast-authority-fixture", version: "1.0.0", main: "main.js" }));
  const preload = join(__dirname, "preload.js");
  const authorityPath = join(__dirname, "shellAuthority.js");
  writeFileSync(join(source, "main.js"), `
const {app,BrowserWindow,ipcMain}=require('electron');
const http=require('node:http');
const {createShellAuthority,installShellCapabilities}=require(${JSON.stringify(authorityPath)});
app.setPath('userData',${JSON.stringify(join(dir, "profile"))});
app.dock?.hide();
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body>Fixture</body></html>');});
server.listen(0,'127.0.0.1',()=>app.whenReady().then(async()=>{
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const foreign='http://localhost:'+server.address().port;
  process.env.CODECAST_URL=base;
  const external=[];let calls=0;let sources=0;
  const policy=createShellAuthority({ipcMain,origins:()=>[base],openExternal:u=>external.push(u)});
  policy.ipc.handle('voice-command',()=>{calls++;return true;});
  policy.ipc.handle('get-app-version',()=> 'fixture');
  const win=policy.register(new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},sandbox:false,contextIsolation:true,nodeIntegration:false}}));
  const errors=[];win.webContents.on('preload-error',(_e,_p,e)=>errors.push(e.message));
  await win.loadURL(base);
  const first=await win.webContents.executeJavaScript('(async()=>({bridge:typeof __CODECAST_ELECTRON__,command:await __CODECAST_ELECTRON__.voiceCommand("fixture",[])}))()');
  const child=await win.webContents.executeJavaScript('new Promise(resolve=>{const f=document.createElement("iframe");f.allow="camera";f.src='+JSON.stringify(foreign)+';f.onload=()=>resolve(true);document.body.append(f)})');
  const frame=win.webContents.mainFrame.frames[0];
  const iframeBridge=await frame.executeJavaScript('typeof window.__CODECAST_ELECTRON__');
  const permissionChecks=[];
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler((wc,permission,origin,details)=>{
    const allowed=policy.permission(wc,details,origin);
    permissionChecks.push({permission,allowed,isMainFrame:details.isMainFrame,url:details.requestingUrl});
    return allowed;
  });
  await win.webContents.executeJavaScript('navigator.permissions.query({name:"camera"}).then(p=>p.state)');
  await frame.executeJavaScript('navigator.permissions.query({name:"camera"}).then(p=>p.state)');
  await win.webContents.executeJavaScript('const a=document.createElement("a");a.href='+JSON.stringify(foreign)+';a.textContent="foreign chart link";document.body.append(a);a.click()');
  await new Promise(r=>setTimeout(r,200));
  const afterClick=win.webContents.getURL();
  const callbacks={};
  installShellCapabilities({authority:policy,permissions:()=>new Set(['media','clipboard-read']),session:{setPermissionRequestHandler:f=>callbacks.request=f,setPermissionCheckHandler:f=>callbacks.check=f,setDisplayMediaRequestHandler:f=>callbacks.display=f},desktopCapturer:{getSources:async()=>{sources++;return [{id:'screen:fake'}]}}});
  const denied=await new Promise(r=>callbacks.display({frame,securityOrigin:foreign},r));
  const allowed=callbacks.check(win.webContents,'media',base,{isMainFrame:true,requestingUrl:base});
  const foreignPermission=callbacks.check(win.webContents,'clipboard-read',foreign,{isMainFrame:false,requestingUrl:foreign});
  await win.loadURL(foreign);
  const foreignBridge=await win.webContents.executeJavaScript('typeof window.__CODECAST_ELECTRON__');
  const lateAdmission=policy.admits({sender:win.webContents,senderFrame:win.webContents.mainFrame});
  process.stdout.write('AUTHORITY '+JSON.stringify({packaged:app.isPackaged,first,iframeBridge,permissionChecks,afterClick,base,external,errors,calls,sources,denied,allowed,foreignPermission,foreignBridge,lateAdmission})+'\\n');
  win.destroy();server.close();app.exit(0);
 } catch(e){process.stdout.write('FAIL '+e.stack+'\\n');app.exit(1);}
}));
`);
  try {
    const out = await new Promise((resolveOutput, reject) => execFile(join(app, "Contents/MacOS/AuthorityFixture"), [], { timeout: 70_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${error}\n${stdout}\n${stderr}`)) : resolveOutput(stdout)));
    const line = out.split("\n").find(line => line.startsWith("AUTHORITY "));
    assert.ok(line, out);
    const result = JSON.parse(line.slice(10));
    assert.equal(result.packaged, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.first.bridge, "object");
    assert.equal(result.first.command, true);
    assert.equal(result.calls, 1);
    assert.equal(result.iframeBridge, "undefined");
    assert.ok(result.permissionChecks.some(check => check.allowed && check.isMainFrame));
    assert.ok(result.permissionChecks.some(check => !check.allowed && !check.isMainFrame), JSON.stringify(result.permissionChecks));
    assert.equal(result.afterClick, result.base + "/");
    assert.ok(result.external.length > 0);
    assert.deepEqual(result.denied, {});
    assert.equal(result.sources, 0);
    assert.equal(result.allowed, true);
    assert.equal(result.foreignPermission, false);
    assert.equal(result.foreignBridge, "undefined");
    assert.equal(result.lateAdmission, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
