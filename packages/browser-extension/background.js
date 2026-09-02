/**
 * Cast Browser Bridge — MV3 service worker.
 *
 * Connects OUT to the cast bridge host on localhost (an extension cannot
 * listen), proves it holds the token the human paired through the options
 * page and makes the host prove the same back (below), and executes the small
 * op set the cast CLI sends: tab management, chrome.debugger attach/detach,
 * and raw CDP commands per tab.
 *
 * The token never goes on the wire. Any local account can bind the bridge
 * port while no host is running, and a socket that merely opened proves
 * nothing, so the handshake is mutual: we send a fresh nonce with
 * HMAC(token, "ext:" + nonce), the host answers HMAC(token, nonce), and not
 * one op is executed before that answer checks out. A host that cannot
 * answer is treated like a bad token: the socket is closed and the retry
 * alarm stays quiet until the human runs setup again.
 *
 * Visibility is a feature, not an accident: chrome.debugger shows Chrome's own
 * "is debugging this browser" banner for as long as a tab is attached, and we
 * add signals of our own. A Chrome tab group per session (the host asks for
 * it on tabs.create) whose title shows cycling dots while a session works and
 * a checkmark for a moment after; the extension remembers the groups it made
 * and never touches one the human made. A thin border in the group's colour
 * around the driven page, injected through the debugger session so it needs
 * no host permission and no content script; hidden for every screenshot so
 * captures stay clean, and kept alive by a heartbeat so a cancelled banner or
 * a crashed host cannot leave it behind. A CAST badge on the extension icon
 * for the driven tab, which Chrome shows only when the icon is pinned.
 * Detaching removes the badge and the border; the group empties itself when
 * its tabs close.
 *
 * The open WebSocket keeps this service worker alive (Chrome 116+), helped by
 * the host's application-level pings every 20s. A dropped socket is retried
 * after 1 s, 2 s and 5 s while the worker is awake; a chrome.alarms tick is
 * the backstop that reconnects after the worker is ever torn down.
 */

const PROTOCOL = 4;

let ws = null;
let status = { state: "no-config", detail: "not paired yet" };
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
  chrome.action.setTitle({ title: `Cast Browser Bridge — ${state}${detail ? `: ${detail}` : ""}` });
  // A global badge only when something is wrong, so "working" is quiet.
  if (state === "bad-token") {
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#b71c1c" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

/** Quick retries after a drop, while the worker is awake; the alarm takes over after. */
const RETRY_MS = [1000, 2000, 5000];
let retries = 0;
let retryTimer = null;

function scheduleRetry() {
  if (retryTimer || retries >= RETRY_MS.length) return;
  const delay = RETRY_MS[retries++];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function resetRetries() {
  clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
}

async function connect() {
  const cfg = await getConfig();
  if (!cfg || !cfg.token || !cfg.port) {
    setStatus("no-config", "not paired yet; run `cast browser extension setup` in a terminal");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/ext`);
  ws = sock;
  setStatus("connecting", `127.0.0.1:${cfg.port}`);
  const nonce = randomHex(32);
  let proven = false;

  sock.onopen = async () => {
    send({
      op: "hello",
      nonce,
      auth: await hmacHex(cfg.token, "ext:" + nonce),
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
    // Nothing is executed for a host that has not proved it holds the token.
    if (!proven) {
      if (msg.op !== "welcome") return;
      if (sameHex(msg.proof, await hmacHex(cfg.token, nonce))) {
        proven = true;
        resetRetries();
        setStatus("connected", `127.0.0.1:${cfg.port}`);
      } else {
        // Close first, then set the status: the close handler reads it.
        sock.close(4401, "host could not prove the token");
        setStatus("bad-token", "the host on that port could not prove it holds the token; run `cast browser extension setup` again");
      }
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
    // 4401 is the "bad token" close, from either side — retrying the same
    // token is noise. Our own close already set a more specific status.
    if (status.state === "bad-token") {
      /* keep it */
    } else if (e.code === 4401) {
      setStatus("bad-token", "the host rejected the token; run `cast browser extension setup` again, it hands this extension the current token");
    } else {
      setStatus("disconnected", "the bridge host is not running; it starts with the next `cast browser` command in real mode");
      scheduleRetry();
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

/** Drop the current socket and connect afresh, with the retry ladder reset. */
function reconnect() {
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  resetRetries();
  status = { state: "disconnected", detail: "" };
  connect();
}

// --------------------------------------------------------------------------
// The handshake's arithmetic: HMAC-SHA256 as hex, mirroring bridgeProof in
// packages/cli/src/browser/bridge/protocol.ts.
// --------------------------------------------------------------------------

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality for hex strings of the same length. */
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
    reconnect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Exposed for the smoke script, which seeds storage over CDP and reconnects.
globalThis.__castReconnect = reconnect;

// --------------------------------------------------------------------------
// Ops
// --------------------------------------------------------------------------

async function handle(m) {
  await groupsLoaded;
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
      const groupId = await ownedGroupOf(m.tabId);
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

/** Per-tab badge on the extension icon (visible when the icon is pinned). */
function markDriven(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "CAST" : "" }).catch(() => {});
  if (on) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "cast is driving this tab" }).catch(() => {});
  }
}

/** The tab shape the host turns into CDP TargetInfo. A group is reported
 *  only when this extension created it: the host adopts the group of a tab
 *  a client attaches to, and a group the human made must never be adopted. */
function describeTab(t) {
  const g = ownedGroups.has(t.groupId) ? groups.get(t.groupId) : null;
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
// Tab groups: one per session, title animated while the session works
// --------------------------------------------------------------------------

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
const groups = new Map(); // groupId → chrome.tabGroups.TabGroup (title as Chrome shows it)
const tabGroupOf = new Map(); // tabId → groupId, kept current by tab events
const indicators = new Map(); // groupId → indicator state (beginWork)

/**
 * Groups this extension created. Everything that touches a group (the
 * animated title, the border colour, what the host is told) is limited to
 * these, so a group the human made is never renamed, animated or handed to a
 * session. Persisted in session storage: a service worker restart must not
 * make us forget which groups are ours, and a browser restart (which empties
 * session storage) also drops every group id, so nothing stale survives.
 */
const ownedGroups = new Set();
const groupsLoaded = chrome.storage.session
  .get("ownedGroups")
  .then(({ ownedGroups: ids }) => {
    for (const id of ids || []) ownedGroups.add(id);
  })
  .catch(() => {});

function persistOwnedGroups() {
  chrome.storage.session.set({ ownedGroups: [...ownedGroups] }).catch(() => {});
}

async function refreshGroups() {
  groups.clear();
  for (const g of await chrome.tabGroups.query({})) groups.set(g.id, g);
}
refreshGroups().catch(() => {});

/**
 * Put a fresh tab in the named group, joining a group of ours with the same
 * title in the same window when one exists so a session's tabs share one
 * group. A group the human happened to name the same way is not ours to
 * join.
 */
async function placeInGroup(tab, group) {
  const existing = (await chrome.tabGroups.query({ windowId: tab.windowId, title: group.title })).find((g) => ownedGroups.has(g.id));
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : {}) });
  tabGroupOf.set(tab.id, groupId);
  if (!existing) {
    ownedGroups.add(groupId);
    persistOwnedGroups();
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

/** The tab's group when it is one of ours, else NO_GROUP. */
async function ownedGroupOf(tabId) {
  const groupId = await groupOfTab(tabId);
  return ownedGroups.has(groupId) ? groupId : NO_GROUP;
}

/**
 * The indicator's frames, all the same width: the dots are padded with
 * punctuation spaces (the width of a period in most fonts), so the tab strip
 * does not shift on every frame. One regular expression names every frame,
 * for the two places that must strip one off a title.
 */
const DOT_FRAMES = [" .  ", " .. ", " ..."];
const DONE_FRAME = " ✓";
const FRAME_SUFFIX = /( \.{1,3} {0,2}| ✓)$/;
const plainOf = (title) => (title || "").replace(FRAME_SUFFIX, "");

/** The title without our dots or checkmark, so the host never sees a frame. */
function plainTitle(groupId, g) {
  const ind = indicators.get(groupId);
  return ind ? ind.title : plainOf(g.title);
}

/** Resolves when Chrome has applied the title; errors (a closed group) are swallowed. */
function setGroupTitle(groupId, title) {
  return chrome.tabGroups.update(groupId, { title }).catch(() => {});
}

/**
 * Work is shown per span, not per CDP call. The engine sends its calls a
 * millisecond apart, so per call the dots never appeared and a checkmark
 * flashed after every verb; measured against a snapshot, five flips inside
 * 20 ms. A span opens on the first call and stays open while calls keep
 * arriving within QUIET_MS of each other; the dots start once the span has
 * run for START_MS (a verb that finishes sooner shows no dots at all), and
 * the span ends, with a checkmark for DONE_MS, only after QUIET_MS with no
 * call in flight. A call landing during the checkmark opens a new span.
 */
const START_MS = 300;
const QUIET_MS = 600;
const DONE_MS = 3000;
const FRAME_MS = 300;

function beginWork(groupId) {
  if (groupId === NO_GROUP || groupId === undefined) return;
  let ind = indicators.get(groupId);
  if (!ind) {
    // The seed is the plain title: `groups` may hold a frame of ours.
    ind = { title: plainOf((groups.get(groupId) || {}).title), inflight: 0, open: false, frame: 0, startTimer: null, ticker: null, quietTimer: null, doneTimer: null };
    indicators.set(groupId, ind);
  }
  clearTimeout(ind.quietTimer);
  ind.quietTimer = null;
  if (ind.doneTimer) {
    clearTimeout(ind.doneTimer);
    ind.doneTimer = null;
  }
  ind.inflight++;
  if (!ind.open) {
    ind.open = true;
    ind.startTimer = setTimeout(() => {
      ind.startTimer = null;
      ind.frame = 0;
      setGroupTitle(groupId, ind.title + DOT_FRAMES[0]);
      ind.ticker = setInterval(() => {
        ind.frame = (ind.frame + 1) % DOT_FRAMES.length;
        setGroupTitle(groupId, ind.title + DOT_FRAMES[ind.frame]);
      }, FRAME_MS);
    }, START_MS);
  }
}

function endWork(groupId) {
  const ind = indicators.get(groupId);
  if (!ind) return;
  if (--ind.inflight > 0) return;
  ind.quietTimer = setTimeout(() => closeSpan(groupId, ind), QUIET_MS);
}

/** The span is over: plain title with a checkmark, then plain. The indicator
 *  is dropped only after Chrome has applied the plain title, so a call that
 *  lands in between never seeds a new indicator from the checkmark frame. */
function closeSpan(groupId, ind) {
  ind.quietTimer = null;
  ind.open = false;
  clearTimeout(ind.startTimer);
  clearInterval(ind.ticker);
  ind.startTimer = null;
  ind.ticker = null;
  setGroupTitle(groupId, ind.title + DONE_FRAME);
  ind.doneTimer = setTimeout(async () => {
    ind.doneTimer = null;
    await setGroupTitle(groupId, ind.title);
    if (indicators.get(groupId) === ind && !ind.open) indicators.delete(groupId);
  }, DONE_MS);
}

function dropIndicator(groupId) {
  const ind = indicators.get(groupId);
  if (!ind) return;
  clearTimeout(ind.startTimer);
  clearInterval(ind.ticker);
  clearTimeout(ind.quietTimer);
  clearTimeout(ind.doneTimer);
  indicators.delete(groupId);
}

chrome.tabGroups.onCreated.addListener((g) => groups.set(g.id, g));
chrome.tabGroups.onUpdated.addListener((g) => {
  groups.set(g.id, g);
  // A title change from the human sticks; our own frames do not.
  const ind = indicators.get(g.id);
  if (ind && g.title !== ind.title && !FRAME_SUFFIX.test(g.title)) ind.title = g.title;
});
chrome.tabGroups.onRemoved.addListener((g) => {
  groups.delete(g.id);
  dropIndicator(g.id);
  if (ownedGroups.delete(g.id)) persistOwnedGroups();
});

// --------------------------------------------------------------------------
// Border overlay: a coloured frame around the driven page
// --------------------------------------------------------------------------

/**
 * Everything the overlay does runs in an isolated world named for us, never
 * in the page's own: the page cannot wrap document.getElementById there to
 * learn when a screenshot is about to be taken, and cannot reach our script
 * at all. The DOM itself is shared, so a hostile page can still hide or
 * remove the element; what it loses is the timing signal. The element id is
 * random per attach, so no stylesheet written in advance can target it.
 *
 * The frame lives on a lease. Every BEAT_MS this worker writes a timestamp
 * into the world of each attached tab, and the page side script hides the
 * frame once LEASE_MS pass with no fresh timestamp. Detaching removes the
 * frame outright; the lease covers the paths that cannot: the human pressing
 * Cancel on Chrome's banner (the session is gone before we can act) and a
 * host or worker that died.
 */
const WORLD = "cast-browser-bridge";
const BEAT_MS = 3000;
const LEASE_MS = 8000;
const borderScripts = new Map(); // tabId → Page.addScriptToEvaluateOnNewDocument identifier
const borderIds = new Map(); // tabId → this attach's element id
const worlds = new Map(); // tabId → executionContextId of our isolated world in the top frame

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
 * navigation, so it waits for one when it must. `__castBeat` is the lease:
 * set at mount, refreshed by the worker, checked once a second.
 */
function borderSource(id, color) {
  return `(() => {
    if (window !== window.top) return;
    const ID = ${JSON.stringify(id)};
    const LEASE_MS = ${LEASE_MS};
    globalThis.__castBeat = Date.now();
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
    const lease = () => {
      const el = document.getElementById(ID);
      if (el) el.style.display = Date.now() - (globalThis.__castBeat || 0) > LEASE_MS ? "none" : "block";
    };
    if (!mount()) document.addEventListener("DOMContentLoaded", mount, { once: true });
    if (!globalThis.__castLease) globalThis.__castLease = setInterval(lease, 1000);
  })();`;
}

async function borderColor(tabId) {
  const g = groups.get(await ownedGroupOf(tabId));
  return GROUP_COLOR_HEX[g && g.color] || "#c62828";
}

/**
 * Our isolated world's context in the tab's top frame, created on first use
 * and again after every navigation (Runtime.executionContextsCleared drops
 * the cached id). Chrome keys isolated worlds by name per frame, so the
 * world the on-new-document script ran in is the one this returns.
 */
async function worldContext(tabId) {
  const cached = worlds.get(tabId);
  if (cached) return cached;
  const { frameTree } = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
  const { executionContextId } = await chrome.debugger.sendCommand({ tabId }, "Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: WORLD,
    grantUniveralAccess: false,
  });
  worlds.set(tabId, executionContextId);
  return executionContextId;
}

/** Run a script in our world; a stale context (a navigation raced us) is retried once. */
async function evalInWorld(tabId, expression) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const contextId = await worldContext(tabId);
      return await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, contextId });
    } catch (err) {
      worlds.delete(tabId);
      if (attempt) throw err;
    }
  }
}

async function installBorder(tabId) {
  const id = "cast-" + randomHex(8);
  borderIds.set(tabId, id);
  const source = borderSource(id, await borderColor(tabId));
  const r = await chrome.debugger
    .sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source, worldName: WORLD })
    .catch(() => null);
  if (r && r.identifier) borderScripts.set(tabId, r.identifier);
  await evalInWorld(tabId, source).catch(() => {});
}

async function removeBorder(tabId) {
  const identifier = borderScripts.get(tabId);
  const id = borderIds.get(tabId);
  borderScripts.delete(tabId);
  borderIds.delete(tabId);
  if (identifier) {
    await chrome.debugger.sendCommand({ tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
  }
  if (id) {
    await evalInWorld(tabId, `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e) e.remove(); })()`).catch(() => {});
  }
  worlds.delete(tabId);
}

/** Hidden around a screenshot so the capture shows the page, not our frame. */
async function setBorderVisible(tabId, visible) {
  const id = borderIds.get(tabId);
  if (!id) return;
  await evalInWorld(
    tabId,
    `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e) e.style.visibility = ${JSON.stringify(visible ? "visible" : "hidden")}; })()`,
  ).catch(() => {});
}

// The lease heartbeat: one evaluate per attached tab, straight to the
// debugger (not through the `cdp` op, so it never counts as work).
setInterval(() => {
  for (const tabId of attached) {
    if (borderIds.has(tabId)) evalInWorld(tabId, "globalThis.__castBeat = Date.now()").catch(() => {});
  }
}, BEAT_MS);

// --------------------------------------------------------------------------
// Debugger and tab plumbing
// --------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  // A navigation tore every context down, our world with it.
  if (method === "Runtime.executionContextsCleared" && source.tabId) worlds.delete(source.tabId);
  if (source.tabId && attached.has(source.tabId)) {
    send({ op: "event", tabId: source.tabId, method, params: params || {} });
  }
});

// The user can cancel via Chrome's banner; keep our books straight when they
// do. The border cannot be removed (the session is gone); its lease hides it.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId && attached.has(source.tabId)) {
    attached.delete(source.tabId);
    borderScripts.delete(source.tabId); // the session is gone, and its scripts with it
    borderIds.delete(source.tabId);
    worlds.delete(source.tabId);
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
  borderIds.delete(tabId);
  worlds.delete(tabId);
  send({ op: "tab", kind: "removed", tab: { tabId, url: "", title: "", active: false, windowId: info.windowId, attached: false } });
});
