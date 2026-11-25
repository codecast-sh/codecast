// Run: node --test packages/electron/winInstaller.test.js
//
// The Windows updater hands the downloaded installer to a hidden PowerShell.
// A path with a quote in it must stay one literal argument, the installer
// must run silently as an update, and once signing is on only a valid
// signature from our publisher passes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installerLaunch, signatureCheck, signatureAccepted, psQuote } = require("./winInstaller");

const script = (cmd) => cmd.args[cmd.args.length - 1];

test("the installer runs silently after this process exits, and relaunches only on Restart now", () => {
  const restart = installerLaunch({ pid: 4242, installer: "C:\\Users\\a\\AppData\\Roaming\\Codecast\\update-stage\\Codecast-1.1.140-x64-setup.exe", relaunch: true });
  assert.equal(restart.command, "powershell.exe");
  assert.ok(restart.args.includes("-NoProfile") && restart.args.includes("Hidden"));
  assert.match(script(restart), /^Wait-Process -Id 4242 -ErrorAction SilentlyContinue; Start-Process -FilePath 'C:\\Users\\a\\AppData\\Roaming\\Codecast\\update-stage\\Codecast-1\.1\.140-x64-setup\.exe' -ArgumentList '\/S','--updated','--force-run'$/);
  const quit = installerLaunch({ pid: 4242, installer: "C:\\x\\setup.exe", relaunch: false });
  assert.match(script(quit), /-ArgumentList '\/S','--updated'$/);
});

test("a path with a quote or a PowerShell expression stays a literal", () => {
  assert.equal(psQuote("C:\\O'Brien\\$(calc)\\setup.exe"), "'C:\\O''Brien\\$(calc)\\setup.exe'");
  assert.match(script(installerLaunch({ pid: 1, installer: "C:\\O'Brien\\setup.exe", relaunch: false })), /-FilePath 'C:\\O''Brien\\setup\.exe'/);
  assert.match(script(signatureCheck("C:\\O'Brien\\setup.exe")), /-LiteralPath 'C:\\O''Brien\\setup\.exe'/);
});

test("a pid that is not a positive integer is refused", () => {
  for (const pid of [0, -1, 1.5, "4242; calc", undefined]) {
    assert.throws(() => installerLaunch({ pid, installer: "C:\\x\\setup.exe", relaunch: false }), /bad pid/);
  }
});

test("unsigned builds pass; with a publisher set, only its valid signature does", () => {
  assert.equal(signatureAccepted("NotSigned|", null), true);
  assert.equal(signatureAccepted("Valid|CN=Codecast Inc, O=Codecast Inc, L=San Francisco, C=US", "Codecast Inc"), true);
  assert.equal(signatureAccepted("Valid|CN=\"Codecast Inc\", O=Codecast Inc, C=US\r\n", "Codecast Inc"), true);
  assert.equal(signatureAccepted("NotSigned|", "Codecast Inc"), false);
  assert.equal(signatureAccepted("HashMismatch|CN=Codecast Inc", "Codecast Inc"), false);
  assert.equal(signatureAccepted("Valid|CN=Codecast Inc Evil, O=Mallory", "Codecast Inc"), false);
  assert.equal(signatureAccepted("Valid|O=Codecast Inc", "Codecast Inc"), false);
});
