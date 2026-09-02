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
 * add three signals of our own. A red CAST badge per driven tab. A Chrome tab
 * group per session (the host asks for it on tabs.create) whose title gains
 * cycling dots while a command runs and a checkmark for a moment after. And a
 * thin border in the group's colour around the driven page, injected through
 * the debugger session so it needs no host permission and no content script;
 * it is hidden for every screenshot so captures stay clean. Detaching removes
 * the badge and the border; the group empties itself when its tabs close.
 *
 * The open WebSocket keeps this service worker alive (Chrome 116+), helped by
 * the host's application-level pings every 20s. A chrome.alarms tick is the
 * backstop that reconnects after the worker is ever torn down.
 */

const PROTOCOL = 3;

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
      await refreshGroups();
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.filter((t) => t.id !== undefined).map(describeTab) };
    }

    case "tabs.create": {
      const t = await chrome.tabs.create({ url: m.url || "about:blank", active: !m.background });
      if (m.group) await placeInGroup(t, m.group);
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
      const groupId = await groupOfTab(m.tabId);
      beginWork(groupId);
      const screenshot = m.method === "Page.captureScreenshot";
      try {
        if (screenshot) await setBorderVisible(m.tabId, false);
        const result = await chrome.debugger.sendCommand({ tabId: m.tabId }, m.method, m.params || {});
        return { result: result || {} };
      } finally {
        if (screenshot) await setBorderVisible(m.tabId, true);
        endWork(groupId);
      }
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
  if (!borderScripts.has(tabId)) await installBorder(tabId);
}

async function detachTab(tabId) {
  if (attached.has(tabId)) {
    attached.delete(tabId);
    markDriven(tabId, false);
    await removeBorder(tabId);
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
  const g = groups.get(t.groupId);
  return {
    tabId: t.id,
    url: t.url || "",
    title: t.title || "",
    active: !!t.active,
    windowId: t.windowId,
    attached: attached.has(t.id),
    ...(g ? { group: { title: plainTitle(t.groupId, g), color: g.color } } : {}),
  };
}

// --------------------------------------------------------------------------
// Tab groups: one per session, title animated while a command runs
// --------------------------------------------------------------------------

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
const groups = new Map(); // groupId → chrome.tabGroups.TabGroup (title as Chrome shows it)
const tabGroupOf = new Map(); // tabId → groupId, kept current by tab events
const indicators = new Map(); // groupId → { title, inflight, ticker, restore, dots }

async function refreshGroups() {
  groups.clear();
  for (const g of await chrome.tabGroups.query({})) groups.set(g.id, g);
}
refreshGroups().catch(() => {});

/** The title without our dots or checkmark, so the host never sees an animation frame. */
function plainTitle(groupId, g) {
  const ind = indicators.get(groupId);
  return ind ? ind.title : g.title || "";
}

/**
 * Put a fresh tab in the named group, joining a group with the same title in
 * the same window when one exists so a session's tabs share one group.
 */
async function placeInGroup(tab, group) {
  const existing = (await chrome.tabGroups.query({ windowId: tab.windowId, title: group.title }))[0];
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : {}) });
  tabGroupOf.set(tab.id, groupId);
  if (!existing) {
    const g = await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
    groups.set(groupId, g);
  }
}

async function groupOfTab(tabId) {
  if (!tabGroupOf.has(tabId)) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    tabGroupOf.set(tabId, t ? t.groupId : NO_GROUP);
  }
  return tabGroupOf.get(tabId);
}

function setGroupTitle(groupId, title) {
  chrome.tabGroups.update(groupId, { title }).catch(() => {});
}

/** A command started on a tab in this group: show cycling dots on the title. */
function beginWork(groupId) {
  if (groupId === NO_GROUP || groupId === undefined) return;
  let ind = indicators.get(groupId);
  if (!ind) {
    ind = { title: (groups.get(groupId) || {}).title || "", inflight: 0, ticker: null, restore: null, dots: 0 };
    indicators.set(groupId, ind);
  }
  if (ind.restore) {
    clearTimeout(ind.restore);
    ind.restore = null;
  }
  if (ind.inflight++ === 0) {
    ind.ticker = setInterval(() => {
      ind.dots = (ind.dots % 3) + 1;
      setGroupTitle(groupId, ind.title + ".".repeat(ind.dots));
    }, 300);
    setGroupTitle(groupId, ind.title + ".");
    ind.dots = 1;
  }
}

/** The last in-flight command finished: plain title with a checkmark, then plain. */
function endWork(groupId) {
  const ind = indicators.get(groupId);
  if (!ind) return;
  if (--ind.inflight > 0) return;
  clearInterval(ind.ticker);
  ind.ticker = null;
  setGroupTitle(groupId, ind.title + " ✓");
  ind.restore = setTimeout(() => {
    indicators.delete(groupId);
    setGroupTitle(groupId, ind.title);
  }, 3000);
}

chrome.tabGroups.onCreated.addListener((g) => groups.set(g.id, g));
chrome.tabGroups.onUpdated.addListener((g) => {
  groups.set(g.id, g);
  // A title change from the human sticks; our own animation frames do not.
  const ind = indicators.get(g.id);
  if (ind && g.title !== ind.title && !/^(.*?)(\.{1,3}| ✓)$/.test(g.title)) ind.title = g.title;
});
chrome.tabGroups.onRemoved.addListener((g) => {
  groups.delete(g.id);
  const ind = indicators.get(g.id);
  if (ind) {
    clearInterval(ind.ticker);
    clearTimeout(ind.restore);
    indicators.delete(g.id);
  }
});

// --------------------------------------------------------------------------
// Border overlay: a coloured frame around the driven page
// --------------------------------------------------------------------------

const BORDER_ID = "cast-browser-bridge-border";
const borderScripts = new Map(); // tabId → Page.addScriptToEvaluateOnNewDocument identifier

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

/**
 * The page-side script. Fixed, inset, pointer-events none, so it never takes
 * a click and never answers elementFromPoint (the driver's click checks use
 * that). Top frame only. Runs before the document has an element on a fresh
 * navigation, so it waits for one when it must.
 */
function borderSource(color) {
  return `(() => {
    if (window !== window.top) return;
    const ID = ${JSON.stringify(BORDER_ID)};
    const mount = () => {
      const root = document.documentElement;
      if (!root) return false;
      let el = document.getElementById(ID);
      if (!el) {
        el = document.createElement("div");
        el.id = ID;
        el.setAttribute("aria-hidden", "true");
        root.appendChild(el);
      }
      el.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
        "border:3px solid ${color};margin:0;padding:0;background:transparent;";
      return true;
    };
    if (!mount()) document.addEventListener("DOMContentLoaded", mount, { once: true });
  })();`;
}

async function borderColor(tabId) {
  const g = groups.get(await groupOfTab(tabId));
  return GROUP_COLOR_HEX[g && g.color] || "#c62828";
}

async function installBorder(tabId) {
  const source = borderSource(await borderColor(tabId));
  const r = await chrome.debugger
    .sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source })
    .catch(() => null);
  if (r && r.identifier) borderScripts.set(tabId, r.identifier);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: source }).catch(() => {});
}

async function removeBorder(tabId) {
  const identifier = borderScripts.get(tabId);
  borderScripts.delete(tabId);
  if (identifier) {
    await chrome.debugger.sendCommand({ tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
  }
  await chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(() => { const e = document.getElementById(${JSON.stringify(BORDER_ID)}); if (e) e.remove(); })()`,
    })
    .catch(() => {});
}

/** Hidden around a screenshot so the capture shows the page, not our frame. */
async function setBorderVisible(tabId, visible) {
  await chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(() => { const e = document.getElementById(${JSON.stringify(BORDER_ID)}); if (e) e.style.visibility = ${JSON.stringify(visible ? "visible" : "hidden")}; })()`,
    })
    .catch(() => {});
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
    borderScripts.delete(source.tabId); // the session is gone, and its scripts with it
    markDriven(source.tabId, false);
    send({ op: "detached", tabId: source.tabId });
  }
});

// Tab lifecycle, so the host can emit Target.targetCreated/Destroyed/InfoChanged
// to clients that asked to discover targets — including tabs the human opens.
chrome.tabs.onCreated.addListener((t) => {
  if (t.id !== undefined) {
    tabGroupOf.set(t.id, t.groupId);
    send({ op: "tab", kind: "created", tab: describeTab(t) });
  }
});
chrome.tabs.onUpdated.addListener((tabId, info, t) => {
  if (info.groupId !== undefined) tabGroupOf.set(tabId, info.groupId);
  send({ op: "tab", kind: "updated", tab: describeTab(t) });
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attached.delete(tabId);
  tabGroupOf.delete(tabId);
  borderScripts.delete(tabId);
  send({ op: "tab", kind: "removed", tab: { tabId, url: "", title: "", active: false, windowId: info.windowId, attached: false } });
});
