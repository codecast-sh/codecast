// One download, no terminal step: the desktop app sets up the piece that
// records sessions.
//
// The apps are windows onto sessions; the cast CLI and its daemon are what
// sync them. Until this existed a person who downloaded the app still had to
// open a terminal and paste an install command, and the people who never did
// saw an empty app and left. Here the shell runs that same installer for
// them, behind their click, with a setup token the signed-in page minted:
// the script installs the binary, links this machine with the token, applies
// the recommended defaults (its no-terminal path) and starts the daemon.
//
// Nothing here is a second installer. It is `curl codecast.sh/install | sh -s
// -- <token>`, the command the web app already hands out, run from the shell.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { resolveCli } = require("./computerPermissions");

const INSTALL_URL = "https://codecast.sh/install";
// A slow network plus a first daemon start; past this the run is reported as
// failed rather than left spinning.
const SETUP_TIMEOUT_MS = 5 * 60_000;
// Setup tokens are url-safe random strings. Anything else never reaches a shell.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,256}$/;
const TAIL_CHARS = 2000;

function runInstaller({ token, timeout }) {
  return new Promise((resolve) => {
    // The token travels as a positional argument, never inside the script text.
    const child = spawn("/bin/sh", ["-c", `curl -fsSL ${INSTALL_URL} | sh -s -- "$1"`, "sh", token], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk) => { tail = (tail + String(chunk)).slice(-TAIL_CHARS); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, tail: String(err && err.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, tail }); });
  });
}

// `run`, `exists`, `home` and `platform` are injected so the rules stay
// testable under plain node, the way computerPermissions.js does it.
function createDaemonSetup({ run, exists = fs.existsSync, home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const install = run ?? ((token) => runInstaller({ token, timeout: SETUP_TIMEOUT_MS }));
  let inFlight = null;

  // installed: a cast binary is on this machine. linked: it holds a sign-in.
  // A page offers setup when either is false.
  function state() {
    const supported = platform === "darwin" || platform === "linux";
    const cli = resolveCli({ env, home, exists });
    const installed = cli !== "cast";
    const linked = exists(path.join(home, ".codecast", "config.json"));
    return { supported, installed, linked, running: inFlight !== null };
  }

  // One run at a time: a second click joins the run already going.
  function setup(token) {
    const value = String(token ?? "");
    if (!TOKEN_SHAPE.test(value)) return Promise.resolve({ ok: false, error: "invalid_token" });
    if (!state().supported) return Promise.resolve({ ok: false, error: "unsupported_platform" });
    if (!inFlight) {
      inFlight = install(value)
        .then(({ code, tail }) => (code === 0 ? { ok: true } : { ok: false, error: "installer_failed", detail: tail }))
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return { state, setup };
}

module.exports = { INSTALL_URL, SETUP_TIMEOUT_MS, TOKEN_SHAPE, createDaemonSetup };
