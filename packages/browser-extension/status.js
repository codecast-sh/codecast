/**
 * The connection as a person reads it, shared by the options page and the
 * toolbar popup so the two never describe one state in two ways. The worker
 * reports a state name and the tabs it holds; this turns that into a class
 * for the dot, a title, a short line when one helps, and `pair` when the
 * next step is the Pair button (it opens codecast's setup page, which pairs
 * this profile through the Codecast app on this machine).
 */
const CAST_DEFAULT_PORT = 41729;

/** Hex for chrome.tabGroups.Color, matched by eye to Chrome's own group swatches. */
const GROUP_COLOR_HEX = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
};

/** A typed pairing code in canonical form (I and L read as 1, O as 0), or "". Mirrors normalizePairingCode in the CLI's pairing.ts. */
function normalizePairingCode(input) {
  const code = String(input || "").toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : "";
}

function describeBridge(s, port) {
  const n = s.attached ? s.attached.length : 0;
  const driving = n ? `Driving ${n} tab${n === 1 ? "" : "s"} right now.` : "";
  switch (s.state) {
    case "connected":
      return { cls: "state-ok", title: "Connected", text: driving };
    case "connecting":
    case "disconnected":
      return { cls: "state-wait", title: "Paired, waiting for Codecast", text: "Connects when an agent on this computer next uses the browser." };
    case "standby":
      return { cls: "state-wait", title: "Standby", text: "Agents use another Chrome profile where Codecast is connected. This profile takes over if that one closes." };
    case "bad-token":
      return { cls: "state-bad", title: "Pairing expired", text: "", pair: true };
    case "bad-code":
      return { cls: "state-bad", title: "Code expired", text: "", pair: true };
    default:
      return { cls: "state-none", title: "Not paired", text: "", pair: true };
  }
}

/**
 * Chrome can stop this worker and then refuse to start it again: every
 * message to it is rejected at once, for hours, until the extension is
 * reloaded. On 2026-09-24 the worker went away at 07:47 under load 200 and
 * Chrome dropped its registration (absent from chrome://serviceworker-internals
 * while the extension stayed enabled); the popup, the options page and the
 * CLI's wake page all got "Receiving end does not exist". The reload button
 * in chrome://extensions brought it back at once. A chrome.runtime.reload()
 * from a page, tried once at load 140, unloaded the extension but started no
 * worker for seven minutes, so this is the best lever an extension has, not
 * a proven cure. A worker that is merely slow to boot queues the message
 * instead, so a rejection that lasts is the stuck case. Any visible
 * extension page can reload; the offscreen keeper cannot, because Chrome
 * does not give it chrome.runtime.reload. At most one
 * reload per REVIVE_GAP_MS, stamped in localStorage, which the extension's
 * pages share and which survives the reload, so a worker that stays broken
 * after one reload is left for a person rather than reloaded in a loop.
 */
const REVIVE_AFTER_MS = 10_000;
const REVIVE_GAP_MS = 10 * 60_000;
const REVIVED_AT_KEY = "cast-revived-at";
let workerRefusedSince = 0;

/** Send to the worker. The answer, or null when it refused (recorded for reviveIfRefused). */
async function askWorker(msg) {
  try {
    const r = await chrome.runtime.sendMessage(msg);
    workerRefusedSince = 0;
    return r;
  } catch {
    workerRefusedSince ||= Date.now();
    return null;
  }
}

function revivedRecently() {
  return Date.now() - (Number(localStorage.getItem(REVIVED_AT_KEY)) || 0) < REVIVE_GAP_MS;
}

function revive() {
  localStorage.setItem(REVIVED_AT_KEY, String(Date.now()));
  chrome.runtime.reload();
}

/** Reload the extension when the worker has refused every message for REVIVE_AFTER_MS. True when it did. */
function reviveIfRefused() {
  if (!workerRefusedSince || Date.now() - workerRefusedSince < REVIVE_AFTER_MS || revivedRecently()) return false;
  revive();
  return true;
}

/** The Reconnect button. A person asked, so a worker that refuses is revived at once. */
async function reconnectWorker() {
  if ((await askWorker({ op: "reconnect" })) === null) revive();
}

/** Ask the worker; a silent worker is itself a state worth showing, and one that stays silent is revived. */
async function readBridgeStatus() {
  const s = await askWorker({ op: "status" });
  if (s) return s;
  return { state: reviveIfRefused() ? "reviving" : "dead", attached: [] };
}

/** Paint one status block: a root with the state class, #dot, #state-title, #state-text. */
function renderBridgeStatus(root, s, port) {
  const d = s.state === "dead" || s.state === "reviving"
    ? {
      cls: "state-bad",
      title: "Extension asleep",
      text: s.state === "reviving"
        ? "The service worker stopped answering. Restarting the extension."
        : revivedRecently()
          ? "The service worker is still not answering after a restart. Reload the extension from chrome://extensions."
          : "The service worker is not answering. The extension restarts itself if it stays silent.",
    }
    : describeBridge(s, port);
  root.classList.remove("state-ok", "state-wait", "state-bad", "state-none");
  root.classList.add(d.cls);
  root.querySelector("[data-title]").textContent = d.title;
  const text = root.querySelector("[data-text]");
  text.textContent = d.text;
  text.hidden = !d.text;
  return d;
}

/** Pair: codecast's setup page pairs this profile through the Codecast app, no terminal. */
async function openSetupPage() {
  await askWorker({ op: "open-setup" });
}
