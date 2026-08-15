/**
 * Cast Browser Bridge — MV3 service worker.
 *
 * Connects OUT to the cast bridge host on localhost (an extension cannot
 * listen), authenticates with the token the user pasted in the options page,
 * and executes the small op set the cast CLI sends: tab management,
 * chrome.debugger attach/detach, and raw CDP commands per tab.
 *
 * Visibility is a feature, not an accident: chrome.debugger shows Chrome's own
 * "is debugging this browser" banner for as long as a tab is attached, and we
 * add a red CAST badge per driven tab on top. Detaching removes both.
 *
 * The open WebSocket keeps this service worker alive (Chrome 116+), helped by
 * the host's application-level pings every 20s. A chrome.alarms tick is the
 * backstop that reconnects after the worker is ever torn down.
 */

const PROTOCOL = 2;

let ws = null;
let status = { state: "no-config", detail: "no token saved yet" };
const attached = new Set(); // tabIds we hold a debugger session on

// --------------------------------------------------------------------------
// Connection management
// --------------------------------------------------------------------------

async function getConfig() {
  const { bridge } = await chrome.storage.local.get("bridge");
  return bridge || null;
}

function setStatus(state, detail) {
  status = { state, detail: detail || "" };
  const connected = state === "connected";
  chrome.action.setTitle({ title: `Cast Browser Bridge — ${state}${detail ? `: ${detail}` : ""}` });
  // A global badge only when something is wrong, so "working" is quiet.
  if (state === "bad-token") {
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#b71c1c" });
  } else if (!connected) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function connect() {
  const cfg = await getConfig();
  if (!cfg || !cfg.token || !cfg.port) {
    setStatus("no-config", "open options and paste the token from `cast browser extension setup`");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/ext?token=${encodeURIComponent(cfg.token)}`);
  ws = sock;
  setStatus("connecting", `127.0.0.1:${cfg.port}`);

  sock.onopen = () => {
    setStatus("connected", `127.0.0.1:${cfg.port}`);
    send({
      op: "hello",
      version: chrome.runtime.getManifest().version,
      protocol: PROTOCOL,
      userAgent: navigator.userAgent,
    });
  };

  sock.onmessage = async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.op === "ping") return send({ op: "pong" });
    if (typeof msg.id !== "number") return;
    try {
      const result = await handle(msg);
      send({ id: msg.id, ok: true, ...result });
    } catch (err) {
      send({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  };

  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    // 4401 is the host's "bad token" close — retrying the same token is noise.
    if (e.code === 4401) {
      setStatus("bad-token", "the host rejected the token — re-run `cast browser extension setup` and paste the new one");
    } else {
      setStatus("disconnected", "host closed or unreachable; will retry");
    }
    // Losing the host means nobody can detach us later; release every tab so
    // the human's browser is not left wearing debugger banners forever.
    detachAll();
  };

  sock.onerror = () => {
    /* onclose follows and handles it */
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Reconnect backstop: fires even after the service worker was torn down.
chrome.alarms.create("cast-bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "cast-bridge-reconnect" && status.state !== "bad-token") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// The options page asks for status and pokes reconnects through here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.op === "status") {
    sendResponse({ ...status, attached: [...attached] });
    return false;
  }
  if (msg && msg.op === "reconnect") {
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    status = { state: "disconnected", detail: "" };
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Exposed for the smoke script, which seeds storage over CDP and reconnects.
globalThis.__castReconnect = () => {
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  status = { state: "disconnected", detail: "" };
  connect();
};

// --------------------------------------------------------------------------
// Ops
// --------------------------------------------------------------------------

async function handle(m) {
  switch (m.op) {
    case "ping":
      return { version: chrome.runtime.getManifest().version, protocol: PROTOCOL };

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.filter((t) => t.id !== undefined).map(describeTab) };
    }

    case "tabs.create": {
      const t = await chrome.tabs.create({ url: m.url || "about:blank", active: true });
      return { tabId: t.id };
    }

    case "tabs.close":
      await detachTab(m.tabId).catch(() => {});
      await chrome.tabs.remove(m.tabId);
      return {};

    case "tabs.activate": {
      await chrome.tabs.update(m.tabId, { active: true });
      const t = await chrome.tabs.get(m.tabId);
      await chrome.windows.update(t.windowId, { focused: true });
      return {};
    }

    case "attach":
      await attachTab(m.tabId);
      return {};

    case "detach":
      await detachTab(m.tabId);
      return {};

    case "cdp": {
      if (!attached.has(m.tabId)) await attachTab(m.tabId);
      const result = await chrome.debugger.sendCommand({ tabId: m.tabId }, m.method, m.params || {});
      return { result: result || {} };
    }

    default:
      throw new Error("unknown op: " + m.op);
  }
}

async function attachTab(tabId) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
    markDriven(tabId, true);
  }
  // Re-enabling is idempotent and cheap; a fresh CLI process may follow a
  // navigation that reset domain state.
  for (const domain of ["Page", "DOM", "Runtime", "Accessibility", "Network"]) {
    await chrome.debugger.sendCommand({ tabId }, domain + ".enable", {}).catch(() => {});
  }
}

async function detachTab(tabId) {
  if (attached.has(tabId)) {
    attached.delete(tabId);
    markDriven(tabId, false);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function detachAll() {
  for (const tabId of [...attached]) detachTab(tabId);
}

/** Per-tab badge on top of Chrome's own debugging banner. */
function markDriven(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "CAST" : "" }).catch(() => {});
  if (on) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "cast is driving this tab" }).catch(() => {});
  }
}

/** The tab shape the host turns into CDP TargetInfo. */
function describeTab(t) {
  return {
    tabId: t.id,
    url: t.url || "",
    title: t.title || "",
    active: !!t.active,
    windowId: t.windowId,
    attached: attached.has(t.id),
  };
}

// --------------------------------------------------------------------------
// Debugger and tab plumbing
// --------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && attached.has(source.tabId)) {
    send({ op: "event", tabId: source.tabId, method, params: params || {} });
  }
});

// The user can cancel via Chrome's banner; keep our books straight when they do.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId && attached.has(source.tabId)) {
    attached.delete(source.tabId);
    markDriven(source.tabId, false);
    send({ op: "detached", tabId: source.tabId });
  }
});

// Tab lifecycle, so the host can emit Target.targetCreated/Destroyed/InfoChanged
// to clients that asked to discover targets — including tabs the human opens.
chrome.tabs.onCreated.addListener((t) => {
  if (t.id !== undefined) send({ op: "tab", kind: "created", tab: describeTab(t) });
});
chrome.tabs.onUpdated.addListener((tabId, _info, t) => {
  send({ op: "tab", kind: "updated", tab: describeTab(t) });
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attached.delete(tabId);
  send({ op: "tab", kind: "removed", tab: { tabId, url: "", title: "", active: false, windowId: info.windowId, attached: false } });
});
