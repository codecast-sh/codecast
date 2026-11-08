/**
 * Codecast browser bridge: the MV3 service worker.
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
 * a crashed host cannot leave it behind. A badge on the extension icon for
 * the tab in view (RUN while an agent drives it, WAIT while an agent waits on
 * the human there, ON while the human has lent it), which Chrome shows only
 * when the icon is pinned; the popup behind it takes the tab back, lends it,
 * or continues a handoff (see "Tab roles" at the end).
 * Detaching removes the badge and the border; the group empties itself when
 * its tabs close.
 *
 * Staying alive is this worker's own job. Chrome ends an MV3 service worker
 * after 30 s without an extension API call or a WebSocket message, and the
 * open socket alone does not count: something has to move on it. The host
 * pings every 20 s, but the host is another process, and on a loaded
 * machine (load average 300, 2026-09-13) its timer slipped past the 30 s
 * mark and Chrome ended the worker every few minutes. So the worker also
 * calls an extension API and pings the host itself every 20 s, from timers
 * that run in the same process as Chrome's idle clock and drift with it. A
 * dropped socket is retried after 1 s, then 2 s, then every 5 s for as long
 * as the worker lives: each attempt reads storage, which is an API call, so
 * a disconnected worker keeps itself awake and finds a restarted host within
 * seconds instead of waiting on an alarm. A chrome.alarms tick every 30 s is
 * the backstop that reconnects after the worker is ever torn down, and it
 * keeps ticking after a token rejection too: a host that could not prove the
 * token once (a stale host on the port, a machine under load) is not a
 * reason to stay silent until a person runs setup. A connect that is not
 * proven within 10 s is closed and retried: a socket stuck in CONNECTING
 * while the host was starved otherwise held every reconnect off until
 * Chrome's own handshake timeout, minutes later. The hello names this
 * worker's boot, why it connected and the last few things that happened to
 * it, so the host log can tell a worker that died from a socket that
 * dropped, and say what the worker saw in between.
 *
 * Two more things stand between a session and a blocked command. Any
 * debugger call is bounded at CDP_CALL_MAX_MS: Chrome ends a worker whose
 * single API call runs past five minutes, and a tab whose renderer is
 * frozen never answers, so the tab is detached (which fails the call) rather
 * than let one wedged page take the whole bridge down. And a `wake` message
 * from the options page (opened by the CLI when nothing else brought this
 * worker back) drops whatever socket is stuck and connects afresh.
 */

// The colour table and the status vocabulary shared with the options page and the popup.
importScripts("status.js");

const PROTOCOL = 4;
const DEFAULT_CAST_GROUP = { title: "Cast", color: "red" };
/** An agent tab nobody drove for this long is closed; the same bound as TAB_IDLE_MS in packages/cli/src/browser/engineReap.ts. */
const TAB_IDLE_MS = 30 * 60 * 1000;
/** A handoff the CLI gave no timeout waits this long, and never longer than a day. */
const HANDOFF_DEFAULT_MS = 30 * 60 * 1000;
const HANDOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** Debugger errors another extension's injected frame causes; evicting the frame and retrying gets past them. */
const FOREIGN_FRAME = /Cannot access a chrome-extension:\/\/ URL|Debugger is not attached/i;

let ws = null;
let status = { state: "no-config", detail: "not paired yet" };
// tabIds we hold a debugger session on. Every change re-checks the session
// this worker holds on itself (holdSelf).
const attached = new (class extends Set {
  add(tabId) {
    super.add(tabId);
    holdSelf();
    return this;
  }
  delete(tabId) {
    const had = super.delete(tabId);
    // A tab's child sessions die with its own.
    frameTargets.delete(tabId);
    if (had) holdSelf();
    return had;
  }
})();

/**
 * Cross-origin iframes run in their own renderer, and CDP reaches them only
 * as child sessions. Every driven tab has auto-attach on (flat sessions,
 * Chrome 125+ on chrome.debugger), iframes only, never paused waiting for a
 * debugger; each child's own children are auto-attached the same way. The
 * children Chrome reported, per tab: Chrome session id → { parent (the
 * parent child's session id, or undefined for the tab), params of its
 * Target.attachedToTarget }, so a host that reconnects hears them again on
 * its next attach (replayFrames). The host maps them to its clients
 * (bridge/frameSessions.ts).
 */
const frameTargets = new Map();
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] };
function enableFrames(debuggee) {
  return bounded(chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", AUTO_ATTACH), "auto-attach").catch((err) =>
    note(`auto-attach on tab ${debuggee.tabId}${debuggee.sessionId ? " frame" : ""}: ${String((err && err.message) || err)}`),
  );
}
function replayFrames(tabId) {
  for (const [, t] of frameTargets.get(tabId) || []) send({ op: "event", tabId, session: t.parent, method: "Target.attachedToTarget", params: t.params });
}

// Chrome stops a running service worker that leaves its ping unanswered for
// 30 s (ServiceWorkerVersion::OnPingTimeout). This worker's process runs in
// Chrome's throttled background priority, and on a loaded Mac a stall that
// long is ordinary, so Chrome ended the worker in the middle of commands and
// a fresh one booted seconds later (reproduced 2026-09-15 by freezing the
// extension process for 90 s). A DevTools session on the worker itself
// cancels that stop (EmbeddedWorkerInstance::StopIfNotAttachedToDevTools).
// Any session shows Chrome's debugging banner, which is already up while a
// tab is attached, so the worker holds this one exactly while it holds a tab.
let selfTarget = null;
let selfSync = Promise.resolve();

function holdSelf() {
  selfSync = selfSync.then(async () => {
    const want = attached.size > 0;
    if (want === (selfTarget !== null)) return;
    if (!want) {
      const targetId = selfTarget;
      selfTarget = null;
      await bounded(chrome.debugger.detach({ targetId }), "debugger.detach").catch(() => {});
      return note("released own worker session");
    }
    const self = (await bounded(chrome.debugger.getTargets(), "debugger.getTargets")).find((t) => t.type === "worker" && t.url === chrome.runtime.getURL("background.js"));
    if (!self) return note("own service worker is not a debugger target");
    await attachDebugger({ targetId: self.id });
    selfTarget = self.id;
    note("holding own worker session");
  }).catch((err) => note(`self session failed: ${String((err && err.message) || err)}`));
  return selfSync;
}

// This worker's identity for the host log: a new boot means Chrome ended the
// previous worker (and its socket with it); the same boot on a reconnect
// means the socket dropped under a living worker.
const BOOT = { id: randomHex(4), at: Date.now() };

// --------------------------------------------------------------------------
// Connection management
// --------------------------------------------------------------------------

let bridgeConfig = null;
let configVersion = 0;

async function getConfig() {
  if (bridgeConfig) return bridgeConfig;
  const version = configVersion;
  const { bridge } = await chrome.storage.local.get("bridge");
  if (version !== configVersion) return getConfig();
  return (bridgeConfig = bridge || null);
}

function setStatus(state, detail) {
  status = { state, detail: detail || "" };
  chrome.action.setTitle({ title: `Codecast: ${state}${detail ? `, ${detail}` : ""}` });
  // A global badge only when something is wrong, so "working" is quiet.
  if (state === "bad-token") {
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#b71c1c" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

/**
 * Retries after a drop: quick at first, then every 5 s for as long as the
 * worker lives. Never given up on: a host comes back whenever the next
 * `cast browser` command starts one, and the only way to be there when it
 * does is to keep asking. The alarm covers the case where the worker itself
 * is gone.
 */
const RETRY_MS = [1000, 2000, 5000];
let retries = 0;
let retryTimer = null;

function scheduleRetry() {
  if (retryTimer) return;
  const delay = RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect("retry");
  }, delay);
}

// --------------------------------------------------------------------------
// What happened to this worker lately, for the host log. Kept in memory and
// in storage, so a worker that was ended and restarted still hands the host
// the tail of its predecessor's story in its first hello.
// --------------------------------------------------------------------------

const RECENT_MAX = 24;
let recent = [];
let recentLoaded = chrome.storage.local
  .get("recent")
  .then(({ recent: saved }) => {
    if (Array.isArray(saved)) recent = [...saved, ...recent].slice(-RECENT_MAX);
  })
  .catch(() => {});

function note(what) {
  const stamp = new Date().toISOString().slice(11, 19);
  // A retry every 5 s for an hour is one line with a count, not the whole history.
  const last = recent[recent.length - 1];
  const same = last && /^\S+ (\S+) (.*?)(?: x(\d+))?$/.exec(last);
  if (same && same[1] === BOOT.id && same[2] === what) {
    recent[recent.length - 1] = `${stamp} ${BOOT.id} ${what} x${(parseInt(same[3] || "1", 10) + 1)}`;
  } else {
    recent.push(`${stamp} ${BOOT.id} ${what}`);
    if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
  }
  chrome.storage.local.set({ recent }).catch(() => {});
}

// Every 20 s while connected: one extension API call (what Chrome counts as
// activity, whatever the host is doing) and one ping to the host (traffic on
// the socket, and the host's own view of our liveness). 20 s sits well
// inside Chrome's 30 s idle teardown even with timer drift.
const KEEPALIVE_MS = 20_000;
let keepaliveTimer = null;

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
    send({ op: "ping" });
  }, KEEPALIVE_MS);
}

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

/** A connect that has not been proven by then is abandoned and retried. */
const CONNECT_TIMEOUT_MS = 10_000;

function resetRetries() {
  clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
}

async function connect(trigger = "boot") {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  note(`connect via ${trigger}`);
  const cfg = await getConfig();
  // How this profile proves itself (pairing.ts in the CLI has the scheme):
  // its own key; the machine's shared token from before profiles, which the
  // host swaps for a key on this connection; or a one-time code from setup.
  const mode = !cfg || !cfg.port ? null
    : cfg.secret ? "key"
    : cfg.token ? "legacy"
    : cfg.code && (cfg.codeExpiresAt || 0) > Date.now() ? "code"
    : null;
  if (!mode) {
    setStatus("no-config", "not paired yet; run `cast browser extension setup` in a terminal");
    return;
  }
  // A key is proven under the profile key it was issued to, stored with it.
  const profileKey = (mode === "key" && cfg.key) || (await ensureProfileKey());
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // The key mode's HMAC key is the hash of this profile's key: the host keeps only that hash.
  const proofKey = mode === "key" ? await sha256Hex(cfg.secret) : cfg.token;
  /** The code exchange's session key, once the host's challenge arrives. */
  let codeSession = null;

  const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/ext`);
  ws = sock;
  // A token rejection or a standby stays on the badge until a host welcomes
  // this worker; the attempt itself is silent so the badge does not flicker.
  if (status.state !== "bad-token" && status.state !== "standby") setStatus("connecting", `127.0.0.1:${cfg.port}`);
  const nonce = randomHex(32);
  let proven = false;
  let proving = null;
  hostProven = false;
  const deadline = setTimeout(() => {
    if (proven || ws !== sock) return;
    try {
      sock.close(4408, "connect timed out");
    } catch {}
  }, CONNECT_TIMEOUT_MS);

  sock.onopen = async () => {
    await recentLoaded;
    send({
      op: "hello",
      nonce,
      mode,
      key: profileKey,
      ...(mode === "code" ? {} : { auth: await hmacHex(proofKey, "ext:" + nonce) }),
      version: chrome.runtime.getManifest().version,
      protocol: PROTOCOL,
      userAgent: navigator.userAgent,
      boot: BOOT.id,
      bootAt: BOOT.at,
      trigger,
      recent: recent.slice(-12),
    });
  };

  sock.onmessage = async (e) => {
    if (ws !== sock) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    // Nothing is executed for a host that has not proved it holds the token.
    if (!proven) {
      if (msg.op === "challenge" && mode === "code" && !codeSession && /^[0-9a-f]{64}$/.test(String(msg.nonce || ""))) {
        // Prove the code without showing it; the host proves it back in its welcome.
        const codeKey = await pairingCodeKey(cfg.code);
        codeSession = await hmacHex(codeKey, `cast-pair-v1|127.0.0.1:${cfg.port}|${nonce}|${msg.nonce}`);
        if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ op: "pair", proof: await hmacHex(codeSession, "ext") }));
        return;
      }
      if (msg.op === "welcome") {
        if (!proving) proving = (async () => {
          const valid = mode === "code"
            ? !!codeSession && sameHex(msg.proof, await hmacHex(codeSession, "host"))
            : sameHex(msg.proof, await hmacHex(proofKey, nonce));
          if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
          // A key handed over (a code exchange, or the shared token's
          // migration) arrives masked with a pad only the two of us can make.
          if (valid && typeof msg.issue === "string" && /^[0-9a-f]{64}$/.test(msg.issue)) {
            const pad = mode === "code" ? await hmacHex(codeSession, "wrap") : await hmacHex(cfg.token, "issue:" + nonce);
            await storePairing({ port: cfg.port, key: profileKey, secret: xorHex(msg.issue, pad), profile: typeof msg.profile === "string" ? msg.profile : undefined });
            note(mode === "code" ? "paired with a code" : "migrated off the shared token");
          } else if (valid && mode === "code") {
            note("host welcomed a code without a key");
          }
          if (valid) {
            proven = true;
            hostProven = true;
            clearTimeout(deadline);
            resetRetries();
            startKeepalive();
            note("proven");
            setStatus("connected", `127.0.0.1:${cfg.port}`);
          } else {
            // Close first, then set the status: the close handler reads it.
            note("host proof failed");
            sock.close(4401, "host could not prove the token");
            setStatus("bad-token", "the host on that port could not prove it holds the token; run `cast browser extension setup` again");
          }
        })();
        await proving;
        return;
      }
      if (!proving) return;
      await proving;
      if (!proven || ws !== sock) return;
    }
    if (msg.op === "ping") return send({ op: "pong" });
    if (msg.op === "pong") return;
    if (typeof msg.id !== "number") return;
    try {
      const result = await handle(msg);
      if (ws === sock) send({ id: msg.id, ok: true, ...result });
    } catch (err) {
      if (ws === sock) send({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  };

  sock.onclose = (e) => {
    clearTimeout(deadline);
    if (ws !== sock) return;
    ws = null;
    hostProven = false;
    stopKeepalive();
    note(`close ${e.code}${e.reason ? " " + e.reason : ""}${proven ? "" : " (unproven)"}`);
    // 4401 is the "bad token" close, from either side. The badge says so
    // until a host proves the token; the quick retries stop (the same token
    // five seconds later is the same answer) and the alarm keeps asking
    // every 30 s, because the host that answered may be a stale one about
    // to be replaced. Our own close already set a more specific status.
    if (mode === "code" && !proven) {
      // A code is used once: refused means wrong, used or expired, and trying
      // it again every 30 s would only spend the host's wrong-attempt budget.
      if (e.code === 4401) {
        dropPairingCode();
        setStatus("bad-code", "the pairing code was not accepted (wrong, used or expired); run `cast browser extension setup` again");
      } else {
        setStatus("disconnected", "waiting for the bridge host to finish pairing");
        scheduleRetry();
      }
    } else if (status.state === "bad-token") {
      /* keep it */
    } else if (e.code === 4401) {
      setStatus("bad-token", "the host rejected the token; run `cast browser extension setup` again, it hands this extension the current token");
    } else if (e.code === 4409) {
      // Paired in another Chrome profile too, and that one holds the bridge.
      // No quick retries: the alarm asks every 30 s and takes over once the
      // other profile's extension is gone.
      setStatus("standby", "another Chrome profile's Codecast extension is connected; agents use that profile");
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

// Until the host has proved it holds the token, the only thing it hears is
// our hello: not a tab title, not a URL, not an event. A squatter on the
// port learns nothing about this browser.
let hostProven = false;

function send(msg) {
  if (!hostProven && msg.op !== "hello") return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * This profile's id for the host: random, made once and kept in this
 * profile's storage, so it names the profile without saying anything about
 * the person. It survives re-pairing; the host names the profile by it.
 */
// One promise per worker: connect() runs from several triggers at boot
// (boot, installed, keeper) at once, and two racing reads of an empty slot
// would each mint a key, so a hello could name one key while storage kept
// the other, and the host would then refuse every later connect.
let profileKeyPending = null;
function ensureProfileKey() {
  profileKeyPending ??= (async () => {
    const { profileKey } = await chrome.storage.local.get("profileKey");
    if (typeof profileKey === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(profileKey)) return profileKey;
    const fresh = randomHex(16);
    await chrome.storage.local.set({ profileKey: fresh });
    return fresh;
  })().catch((err) => {
    profileKeyPending = null;
    throw err;
  });
  return profileKeyPending;
}

/** Keep the key a pairing handed over and forget the shared token and code it replaces. */
async function storePairing(bridge) {
  await chrome.storage.local.set({ bridge });
  bridgeConfig = bridge;
  configVersion++;
}

async function dropPairingCode() {
  const { bridge } = await chrome.storage.local.get("bridge");
  if (!bridge || !bridge.code) return;
  const rest = { ...bridge };
  delete rest.code;
  delete rest.codeExpiresAt;
  await storePairing(rest);
}

/** Drop the current socket and connect afresh, with the retry ladder reset. */
function reconnect(refreshConfig = true) {
  if (refreshConfig) {
    bridgeConfig = null;
    configVersion++;
  }
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  hostProven = false;
  stopKeepalive();
  resetRetries();
  status = { state: "disconnected", detail: "" };
  connect("reconnect");
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

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The slow hash of a pairing code, mirroring pairingCodeKey in packages/cli/src/browser/bridge/pairing.ts. */
async function pairingCodeKey(code) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(normalizePairingCode(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode("cast-pair-v1|code"), iterations: 100_000, hash: "SHA-256" }, k, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function xorHex(a, b) {
  let out = "";
  for (let i = 0; i < a.length; i += 2) out += (parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)).toString(16).padStart(2, "0");
  return out;
}

/** Constant-time equality for hex strings of the same length. */
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------------------------
// The keeper: an offscreen document in this extension's process
// --------------------------------------------------------------------------

/**
 * One hidden page (offscreen.html) that messages this worker every 20 s.
 * It is what makes the worker dependable rather than disposable: see
 * offscreen.js for the measurements. Created at every boot and checked on
 * every alarm, because Chrome drops it with the extension on a reload and
 * nothing else brings it back. A Chrome without the offscreen API (before
 * 109) runs as before, on the alarm and the worker's own timers.
 */
let keeperPending = null;
function ensureKeeper() {
  if (!chrome.offscreen || keeperPending) return keeperPending || Promise.resolve();
  keeperPending = (async () => {
    try {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        // WORKERS carries no lifetime limit; an AUDIO_PLAYBACK page is closed after 30 s of silence.
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Keeps the local bridge connection's service worker running so agent commands are answered promptly.",
      });
      note("keeper page created");
    } catch (err) {
      // "Only a single offscreen document may be created" is a race with ourselves: fine.
      if (!/single offscreen/i.test(String(err && err.message))) note(`keeper page: ${String((err && err.message) || err)}`);
    }
  })().finally(() => {
    keeperPending = null;
  });
  return keeperPending;
}
ensureKeeper();

// Reconnect backstop: fires even after the service worker was torn down.
// It asks in every state, a token rejection included: the answer is one
// small HMAC every 30 s, and it is what heals a pairing the moment the
// right host is back on the port.
chrome.alarms.create("cast-bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "cast-bridge-reconnect") return;
  ensureKeeper();
  connect("alarm");
});
chrome.runtime.onStartup.addListener(() => connect("startup"));
chrome.runtime.onInstalled.addListener(() => connect("installed"));
connect("boot");

// The options page asks for status and pokes reconnects through here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The keeper page's heartbeat: receiving it is the point (it is an event,
  // so the idle clock restarts). It also finds a socket that dropped while
  // the worker was starved, without waiting for the 30 s alarm.
  if (msg && msg.op === "keeper-beat") {
    if (!ws) connect("keeper");
    return false;
  }
  if (msg && msg.op === "status") {
    sendResponse({ ...status, attached: [...attached] });
    return false;
  }
  // page.js after a navigation: tell it what this tab is doing.
  if (msg && msg.op === "page-ready" && sender.tab && sender.tab.id !== undefined) {
    if (pageStatus(sender.tab.id).state !== "idle") syncPage(sender.tab.id).catch(() => {});
    return false;
  }
  // The human's trusted click on Continue, from the card page.js draws in that same tab.
  if (msg && msg.op === "handoff-done" && sender.tab && sender.tab.id !== undefined && sender.frameId === 0) {
    const h = handoffs.get(sender.tab.id);
    sendResponse({ ok: !!h && h.id === msg.id && settleHandoff(sender.tab.id, "done") });
    return false;
  }
  // The toolbar popup: one tab's roles, and the human's actions on it. Only
  // this extension's own pages reach these, never a content script (whose
  // sender URL is the page's).
  if (msg && typeof msg.op === "string" && msg.op.startsWith("tab-") && String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
    tabAction(msg).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.op === "reconnect") {
    reconnect();
    sendResponse({ ok: true });
    return false;
  }
  // The CLI's last resort (bridge/realChrome.ts wakeExtension): it opened
  // the options page with #wake because nothing else brought this worker
  // back. The page's message alone woke a dead worker; a live one drops
  // whatever socket it was stuck on. The page is closed again so the
  // human's window is as it was, unless it is the only tab there.
  if (msg && msg.op === "wake") {
    note("wake from the options page");
    if (!hostProven || ws?.readyState !== WebSocket.OPEN) reconnect(false);
    const tab = sender && sender.tab;
    if (tab && tab.id !== undefined) {
      chrome.tabs
        .query({ windowId: tab.windowId })
        .then((tabs) => (tabs.length > 1 ? chrome.tabs.remove(tab.id) : undefined))
        .catch(() => {});
    }
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
  switch (m.op) {
    case "ping":
      return { version: chrome.runtime.getManifest().version, protocol: PROTOCOL };

    case "tabs.list": {
      await loadOwnership();
      // Under the host's 40 s listing budget; a frozen process answers when it wakes.
      const tabs = await bounded(chrome.tabs.query({}), "Chrome tabs.query", 30_000);
      return { tabs: tabs.filter((t) => t.id !== undefined).map(describeTab) };
    }

    case "tabs.create": {
      await loadOwnership();
      const group = m.group || DEFAULT_CAST_GROUP;
      // Into the window that already holds this group, so cast tabs stay
      // together instead of a second group appearing per window.
      const props = { url: m.url || "about:blank", active: !m.background };
      let t;
      if (await separateWindowWanted()) t = await openInAgentWindow(props);
      else {
        const windowId = windowOfOwnedGroup(group.title);
        t = await createTab({ ...props, ...(windowId !== undefined ? { windowId } : {}) });
      }
      ownedTabs.add(t.id);
      persistOwned();
      touch(t.id);
      // The tab exists from here on. A grouping failure must not become a
      // failed create: the caller never learns the tab's id, cannot close it,
      // and each retry leaves one more tab behind. The tab stays ours and
      // joins the group on its next attach.
      await placeInGroup(t, group).catch((err) => note(`tab ${t.id} left ungrouped: ${String((err && err.message) || err)}`));
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
      if (m.owned === true) {
        ownedTabs.add(m.tabId);
        persistOwned();
      }
      await attachTab(m.tabId);
      replayFrames(m.tabId);
      return {};

    case "detach":
      await detachTab(m.tabId);
      return {};

    case "cdp": {
      // CDP's WebAuthn domain mints virtual authenticators and passkeys in
      // the person's Chrome; the host refuses it too (bridge/protocol.ts).
      if (/^WebAuthn\./i.test(String(m.method))) throw new Error("refusing CDP's WebAuthn domain: agents cannot create or use passkeys");
      // cast's own methods, answered here and never sent to Chrome.
      if (m.method === "Cast.handoff" && !m.sessionId) return { result: await setHandoff(m.tabId, m.params || {}) };
      if (/^Cast\./.test(String(m.method))) throw new Error(`unknown method ${m.method}`);
      if (m.sessionId) {
        // A cross-origin iframe's child session: the tab's own chrome (border, pointer) is not its business.
        if (!attached.has(m.tabId) || !frameTargets.get(m.tabId)?.has(m.sessionId)) throw new Error("Session with given id not found (the frame is gone)");
        touch(m.tabId);
        return { result: (await boundedCdp(m.tabId, m.method, m.params || {}, m.sessionId)) || {} };
      }
      if (!attached.has(m.tabId)) await attachTab(m.tabId);
      touch(m.tabId);
      const screenshot = m.method === "Page.captureScreenshot";
      try {
        if (screenshot) await setBorderVisible(m.tabId, false);
        else if (m.method === "Input.dispatchMouseEvent") movePointer(m.tabId, m.params || {});
        return { result: (await cdpPastForeignFrames(m.tabId, m.method, m.params || {})) || {} };
      } finally {
        if (screenshot) await setBorderVisible(m.tabId, true);
      }
    }

    case "reload":
      // Reply first: the reload tears this worker down, socket included. An
      // unpacked extension reads its files again only on a reload, which is
      // how an edited background.js reaches a running Chrome without a trip
      // to chrome://extensions. The host is found again on the way back up.
      setTimeout(() => chrome.runtime.reload(), 50);
      return {};

    default:
      throw new Error("unknown op: " + m.op);
  }
}

/**
 * A tab in a normal window. Chrome started by the CLI with --no-startup-window
 * (bridge/realChrome.ts launchRealChrome) runs with no window at all, and
 * tabs.create has nowhere to put a tab; so a window is made, behind whatever
 * the human is doing. A tab in an existing window is created as asked.
 *
 * With no window named, tabs.create uses the last focused window, and that can
 * be an installed web app's window. Chrome allows tab groups only in normal
 * windows, so placeInGroup then fails on every attempt ("Tabs can only be moved
 * to and from normal windows"). So the tab goes to the last focused NORMAL one.
 */
async function createTab(props) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
  if (windows.length) {
    if (props.windowId !== undefined) return chrome.tabs.create(props);
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => windows[0]);
    return chrome.tabs.create({ ...props, windowId: (w || windows[0]).id });
  }
  const w = await chrome.windows.create({ url: props.url, focused: false, type: "normal" });
  const t = (w && w.tabs && w.tabs[0]) || (await chrome.tabs.query({ windowId: w.id }))[0];
  if (!t) throw new Error("Chrome opened a window but reports no tab in it");
  return t;
}

/**
 * chrome.debugger.sendCommand has no timeout of its own: a tab whose renderer
 * is frozen, throttled in a background window, or discarded by memory saver
 * simply never answers, and one such tab stalled every client of the bridge
 * for the host's 20 s attach budget. Every debugger call on the attach path is
 * bounded, so a tab that cannot answer is reported as such.
 *
 * The bound is generous on purpose. This worker's process runs at background
 * priority, and on a loaded Mac it is not scheduled for tens of seconds at a
 * time; a 5 s bound fired after such a stall on calls that answered the
 * moment the process ran again (ct-51246). The host gives an attach 40 s, so
 * the two steps that answer from the renderer share that budget.
 */
const ATTACH_STEP_MS = 20_000;
/**
 * When the clock fires, the call gets this much longer before it counts as
 * unanswered. A timer measures wall time, and this process is frozen for
 * seconds at a stretch: the timer and the call's answer are both queued
 * while it sleeps, and the timer can run first. Failing the call then throws
 * away an answer that arrives a moment later (seen on tabs.list and the
 * attach steps, ct-51246). A call that is truly hung costs this extra wait.
 */
const STALL_GRACE_MS = 3_000;
function bounded(promise, what, timeoutMs = ATTACH_STEP_MS) {
  let timer;
  let settled = false;
  const tracked = promise.then(
    (v) => ((settled = true), v),
    (e) => {
      settled = true;
      throw e;
    },
  );
  const clock = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const late = () => new Promise((resolve) => setTimeout(resolve, STALL_GRACE_MS));
  return Promise.race([tracked, clock.then(() => (settled ? tracked : Promise.race([tracked, late()])))])
    .then((v) => {
      if (!settled) {
        // Chrome runs this extension's process at background priority, which
        // macOS schedules on the efficiency cores only: a call that has not
        // answered was not scheduled, or its tab cannot answer.
        throw new Error(`${what} did not answer within ${timeoutMs}ms (this extension's process runs at background priority and was not scheduled, or the tab is unresponsive)`);
      }
      return v;
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Chrome ends a service worker whose single API call has run for five
 * minutes, and the socket, every session and every other tab go with it. A
 * debugger call that has not answered in CDP_CALL_MAX_MS is on a tab that
 * will not answer (renderer frozen, page hung); detaching the tab is what
 * makes Chrome fail the call, and the next command attaches afresh.
 */
const CDP_CALL_MAX_MS = 240_000;
async function boundedCdp(tabId, method, params, sessionId) {
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => {
      note(`${method} on tab ${tabId} hung ${CDP_CALL_MAX_MS / 1000}s; detaching`);
      detachTab(tabId).catch(() => {});
      reject(new Error(`${method} did not answer within ${CDP_CALL_MAX_MS / 1000}s; the tab was detached (page hung or renderer frozen)`));
    }, CDP_CALL_MAX_MS);
  });
  try {
    return await Promise.race([chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params), clock]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Another extension's frame in the page (1Password, a translator) makes
 * Chrome refuse debugger commands or drop the session. page.js removes those
 * frames while an agent drives the tab; a command that still hits one evicts
 * again, reattaches if the session dropped, and retries, twice. Never while
 * the human is mid-handoff: their password manager matters more then.
 */
async function cdpPastForeignFrames(tabId, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await boundedCdp(tabId, method, params);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (attempt >= 2 || !FOREIGN_FRAME.test(msg) || pageStatus(tabId).state === "waiting") throw err;
      note(`${method} on tab ${tabId} hit a foreign frame (${msg.slice(0, 60)}); evicting`);
      await chrome.tabs.sendMessage(tabId, { op: "evict" }, { frameId: 0 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      if (/not attached/i.test(msg)) {
        forgetSession(tabId);
        await attachTab(tabId);
      }
    }
  }
}

/** Our books for a tab whose debugger session is gone (scripts, ids and worlds died with it). */
function forgetSession(tabId) {
  attached.delete(tabId);
  borderScripts.delete(tabId);
  borderIds.delete(tabId);
  worlds.delete(tabId);
}

/**
 * Chrome throttles timers and rendering in a tab that is not in the focused
 * window, which every background agent tab is. Focus emulation makes the page
 * behave as focused: requestAnimationFrame runs, focus events fire, and
 * screenshots do not stall. Per debugger session, so it is set on every
 * attach, and again after each main-frame navigation.
 */
function emulateFocus(tabId) {
  chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
}

/**
 * Chrome keeps an extension's debugger sessions across service worker lives;
 * our bookkeeping does not. A session this worker's predecessor held is still
 * on the target, and only a detach clears it. The detach succeeds for our own
 * session alone: another extension's, or open DevTools, leaves an error worth
 * naming.
 */
async function attachDebugger(debuggee) {
  try {
    await bounded(chrome.debugger.attach(debuggee, "1.3"), "debugger.attach");
  } catch (err) {
    if (!/already attached/i.test(String((err && err.message) || err))) throw err;
    const ours = await bounded(chrome.debugger.detach(debuggee), "debugger.detach").then(() => true, () => false);
    if (!ours) throw new Error(`another debugger holds this target (DevTools, or another extension); close it there first`);
    await bounded(chrome.debugger.attach(debuggee, "1.3"), "debugger.attach");
  }
}

async function attachTab(tabId) {
  await loadOwnership();
  if (reclaimed.has(tabId)) throw new Error("the human took this tab back from agents; open a tab of your own");
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (ownedTabs.has(tabId) && t?.groupId === NO_GROUP) await placeInGroup(t, DEFAULT_CAST_GROUP).catch((err) => note(`tab ${tabId} still ungrouped: ${String((err && err.message) || err)}`));
  if (!attached.has(tabId)) {
    if (t && t.discarded) throw new Error("this tab was discarded by Chrome's memory saver; activate it once to wake it");
    await attachDebugger({ tabId });
    attached.add(tabId);
    markDriven(tabId, true);
    syncPage(tabId).catch(() => {});
  }
  emulateFocus(tabId);
  enableFrames({ tabId });
  // Re-enabling is idempotent and cheap; a fresh CLI process may follow a
  // navigation that reset domain state. A tab that answers none of these is
  // reported rather than waited on.
  await bounded(
    Promise.all(["Page", "DOM", "Runtime", "Accessibility", "Network"].map((domain) => chrome.debugger.sendCommand({ tabId }, domain + ".enable", {}).catch(() => {}))),
    "domain enable",
  );
  // The frame is a courtesy, not a step of the attach. Painting it into the
  // live document is a Runtime.evaluate, which waits on the page's main
  // thread, and a page still parsing holds that thread for seconds. Awaiting
  // it here failed the whole attach on google.com under load (2026-09-15),
  // over a frame the on-new-document script would have painted anyway. So the
  // install runs alongside the client's first commands; the tab is usable now.
  if (!borderScripts.has(tabId) && !borderPending.has(tabId)) {
    borderPending.add(tabId);
    bounded(installBorder(tabId), "overlay install", CDP_CALL_MAX_MS)
      .catch((err) => note(`overlay install on tab ${tabId}: ${String((err && err.message) || err)}`))
      .finally(() => borderPending.delete(tabId));
  }
}

async function detachTab(tabId) {
  if (attached.has(tabId)) {
    markDriven(tabId, false);
    try {
      await bounded(removeBorder(tabId), "overlay removal").catch(() => {});
    } finally {
      await bounded(chrome.debugger.detach({ tabId }), "debugger.detach").catch(() => {}).finally(() => attached.delete(tabId));
      paintBadge(tabId);
      syncPage(tabId).catch(() => {});
    }
  }
}

function detachAll() {
  for (const tabId of [...attached]) detachTab(tabId);
}

/** Per-tab badge on the extension icon (paintBadge reads who has the tab). */
function markDriven(tabId) {
  paintBadge(tabId);
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
    // A tab the human lent is an agent tab for as long as it stays lent.
    owned: ownedTabs.has(t.id) || lentTabs.has(t.id),
    ...(g ? { group: { title: plainOf(g.title), color: g.color } } : {}),
    ...(lentTabs.has(t.id) ? { lent: true } : {}),
    ...(adoptedFrom.has(t.id) ? { opener: adoptedFrom.get(t.id) } : {}),
    ...(handoffs.has(t.id) ? { handoff: { id: handoffs.get(t.id).id, state: handoffs.get(t.id).state } } : {}),
    ...(keepReason(t) ? { keep: keepReason(t) } : {}),
  };
}

// --------------------------------------------------------------------------
// Tab groups: one per session
// --------------------------------------------------------------------------

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
const groups = new Map(); // groupId → chrome.tabGroups.TabGroup (title as Chrome shows it)
const tabGroupOf = new Map(); // tabId → groupId, kept current by tab events

/**
 * Groups this extension created. Everything that touches a group (the
 * animated title, the border colour, what the host is told) is limited to
 * these, so a group the human made is never renamed, animated or handed to a
 * session. Persisted in session storage: a service worker restart must not
 * make us forget which groups are ours, and a browser restart (which empties
 * session storage) also drops every group id, so nothing stale survives.
 */
const ownedGroups = new Set();
const ownedTabs = new Set(); // tabs this extension opened; the only ones that belong in an owned group
/**
 * What the human decided about tabs, and what agents asked of them, kept in
 * the same session storage as ownership so a worker restart forgets none of it:
 * - lentTabs: the human's own tabs lent to agents from the toolbar (badge ON);
 * - reclaimed: tabs the human took back; no attach reaches them until lent again;
 * - claimed: agent tabs the human dragged out of the Cast group, now theirs to keep;
 * - adoptedFrom: a tab an agent's page opened (window.open, target=_blank) → that agent tab;
 * - handoffs: a step an agent handed the human on a tab (the card, badge WAIT);
 * - touched: when an agent last drove each tab, for the idle cleanup.
 */
const lentTabs = new Set();
const reclaimed = new Set();
const claimed = new Set();
const adoptedFrom = new Map();
const handoffs = new Map(); // tabId → { id, text, at, expires, state: "waiting" | "done" | "expired" | "cancelled", settledAt? }
const touched = new Map();
let ownershipLoaded = null;
function loadOwnership() {
  if (!ownershipLoaded) {
    ownershipLoaded = bounded(chrome.storage.session.get(["ownedGroups", "ownedTabs", "tabRoles", "touched"]), "Chrome storage.session.get")
      .then(async ({ ownedGroups: gids, ownedTabs: tids, tabRoles, touched: seen }) => {
        for (const id of gids || []) ownedGroups.add(id);
        for (const id of tids || []) ownedTabs.add(id);
        const roles = tabRoles || {};
        for (const id of roles.lent || []) lentTabs.add(id);
        for (const id of roles.reclaimed || []) reclaimed.add(id);
        for (const id of roles.claimed || []) claimed.add(id);
        for (const [id, opener] of roles.adoptedFrom || []) adoptedFrom.set(id, opener);
        for (const [id, h] of roles.handoffs || []) if (!handoffs.has(id)) handoffs.set(id, h);
        for (const [id, at] of seen || []) if (!touched.has(id)) touched.set(id, at);
        // Always: the host re-marks a few tabs the moment it reconnects, so
        // "memory is empty" is rarely true by the first listing, while the
        // groups a reload orphaned are still sitting there unowned.
        await adoptCastGroups();
      }).catch(error => {
        ownershipLoaded = null;
        throw error;
      });
  }
  return ownershipLoaded;
}

/**
 * Session storage empties on an extension reload and on a browser restart,
 * and with it every mark of which tabs are ours. The tab group survives
 * both: it is the one marker Chrome keeps. A group carrying exactly our
 * title and colour was made by this extension (a person names a group
 * "Cast" in red by accident about never), so when memory is empty, those
 * groups and the tabs in them are ours again. Without this, every agent tab
 * left behind after a reload looked like the human's: the host would not
 * list it, and the reaper could not close it (2026-09-17: a strip full of
 * dead sessions' tabs, all reloading against the dev server).
 */
async function adoptCastGroups() {
  // Short bounds: this runs inside the first listing after a reload, and a
  // group query that does not answer must not hold that listing back. The
  // next listing tries again (ownedGroups stays empty until one succeeds).
  // By colour, then the plain title: an older build left "Cast ..." or
  // "Cast ✓" on a group it was animating, and a query by the exact title
  // would miss those.
  const red = await bounded(chrome.tabGroups.query({ color: DEFAULT_CAST_GROUP.color }), "Chrome tabGroups.query", 5_000).catch(() => []);
  for (const g of red) {
    const plain = plainOf(g.title);
    if (plain === DEFAULT_CAST_GROUP.title && g.title !== plain) chrome.tabGroups.update(g.id, { title: plain }).catch(() => {});
  }
  const found = red.filter((g) => plainOf(g.title) === DEFAULT_CAST_GROUP.title && !ownedGroups.has(g.id));
  if (!found.length) return;
  for (const g of found) {
    ownedGroups.add(g.id);
    groups.set(g.id, g);
    const tabs = await bounded(chrome.tabs.query({ groupId: g.id }), "Chrome tabs.query", 5_000).catch(() => []);
    for (const t of tabs) if (t.id !== undefined) ownedTabs.add(t.id);
  }
  persistOwned();
  note(`adopted ${found.length} Cast group(s) after ownership memory was empty`);
}

/** Both sets outlive this worker (session storage), so a restart keeps telling ours from the human's. */
function persistOwned() {
  chrome.storage.session.set({
    ownedGroups: [...ownedGroups],
    ownedTabs: [...ownedTabs],
    tabRoles: { lent: [...lentTabs], reclaimed: [...reclaimed], claimed: [...claimed], adoptedFrom: [...adoptedFrom], handoffs: [...handoffs] },
  }).catch(() => {});
}

/** An agent drove this tab now. Written at most every few seconds: every CDP command lands here. */
let touchTimer = null;
function touch(tabId) {
  touched.set(tabId, Date.now());
  if (touchTimer) return;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    chrome.storage.session.set({ touched: [...touched] }).catch(() => {});
  }, 5_000);
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
  const existing = [...groups.values()].find(
    (g) => ownedGroups.has(g.id) && g.windowId === tab.windowId && plainOf(g.title) === group.title,
  );
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : {}) });
  tabGroupOf.set(tab.id, groupId);
  if (!existing) {
    ownedGroups.add(groupId);
    persistOwned();
    const g = await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
    groups.set(groupId, g);
  }
}

/** The window of a group we made with this plain title, if one is open. */
function windowOfOwnedGroup(title) {
  const g = [...groups.values()].find((x) => ownedGroups.has(x.id) && plainOf(x.title) === title);
  return g ? g.windowId : undefined;
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
 * A group title without the dots or checkmark an older build animated onto
 * it, so a group left mid frame still matches and the host never sees one.
 */
const plainOf = (title) => (title || "").replace(/( \.{1,3} {0,2}| ✓)$/, "");

chrome.tabGroups.onCreated.addListener((g) => groups.set(g.id, g));
chrome.tabGroups.onUpdated.addListener((g) => groups.set(g.id, g));
chrome.tabGroups.onRemoved.addListener((g) => {
  groups.delete(g.id);
  if (ownedGroups.delete(g.id)) persistOwned();
});

// --------------------------------------------------------------------------
// Border overlay: a coloured frame around the driven page
// --------------------------------------------------------------------------

/**
 * Everything the overlay does runs in an isolated world named for us, never
 * in the page's own: the page cannot wrap document.getElementById there to
 * learn when a screenshot is about to be taken, and cannot reach our script
 * at all. The DOM itself is shared, so a hostile page can still hide or
 * remove the element; what it loses is the timing signal, and the frame is
 * put back within a second. The element carries no id, class or data
 * attribute and draws inside a closed shadow root, so no stylesheet can
 * target it and no script can read it.
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
const borderPending = new Set(); // tabIds whose overlay install is still running (attachTab does not wait for it)
const borderIds = new Map(); // tabId → this attach's overlay install id (the frame itself is found through the world's globals)
const worlds = new Map(); // tabId → executionContextId of our isolated world in the top frame

/**
 * The page-side script. Fixed, inset, pointer-events none, so it never takes
 * a click and never answers elementFromPoint (the driver's click checks use
 * that). Top frame only. Runs before the document has an element on a fresh
 * navigation, so it waits for one when it must. `__castBeat` is the lease:
 * set at mount, refreshed by the worker, checked once a second.
 */
function borderSource(color) {
  return `(() => {
    if (window !== window.top) return;
    // Tell the page an agent drives this tab. codecast's own pages read the
    // key before deciding whether to hand the page to the desktop app, and a
    // page already parsing when we attached hears the event instead. Storage
    // and DOM events are shared with the page's world; nothing else here is.
    // Same names as packages/cli/src/browser/observe.ts (agentTabStampSource).
    try { sessionStorage.setItem("codecast-agent-tab", "1"); } catch {}
    try { document.dispatchEvent(new Event("cast:driven")); } catch {}
    const LEASE_MS = ${LEASE_MS};
    globalThis.__castBeat = Date.now();
    // The frame is an element with no id, class or data attribute, its
    // drawing in a closed shadow root: no stylesheet can target it and no page
    // script can reach inside. The page can still remove or restyle the host;
    // each mount and lease tick puts it back as it was. Held in this isolated
    // world's globals, which the page cannot see.
    const mount = () => {
      const root = document.documentElement;
      if (!root) return false;
      let f = globalThis.__castFrame;
      if (!f) {
        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = '<style>#f{position:fixed;inset:0;box-sizing:border-box;margin:0;padding:0;pointer-events:none;background:transparent}' +
          '#p{position:absolute;left:0;top:0;width:28px;height:36px;opacity:0;transform:translate(-100px,-100px);' +
          'transition:transform 160ms cubic-bezier(.2,.7,.2,1),opacity 300ms ease;will-change:transform}' +
          '#r{position:absolute;left:-14px;top:-14px;width:36px;height:36px;border-radius:50%;opacity:0;transform:scale(.4)}</style>' +
          '<div id="f"><div id="p"><svg width="28" height="36" viewBox="0 0 28 36" style="position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">' +
          '<path id="a" d="M3 2 L3 27 L9 21 L13 31 L17 29 L13 20 L22 20 Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span id="r"></span></div></div>';
        f = globalThis.__castFrame = { host, frame: shadow.getElementById("f"), cur: shadow.getElementById("p"), arrow: shadow.getElementById("a"), ring: shadow.getElementById("r"), invisible: false };
      }
      const color = ${JSON.stringify(color)};
      f.frame.style.cssText = "border:3px solid transparent;border-image:linear-gradient(135deg,color-mix(in srgb," + color + " 55%,white)," + color + " 55%,color-mix(in srgb," + color + " 70%,black)) 1;" +
        "box-shadow:inset 0 0 26px 0 color-mix(in srgb," + color + " 16%,transparent);";
      f.arrow.setAttribute("fill", color);
      f.ring.style.border = "2px solid " + color;
      place(f);
      return true;
    };
    // Fixed, inset, pointer-events none: it never takes a click and never
    // answers elementFromPoint (the driver's click checks use that).
    const place = (f) => {
      const root = document.documentElement;
      if (!root) return;
      if (f.host.parentNode !== root) root.appendChild(f.host);
      const shown = Date.now() - (globalThis.__castBeat || 0) <= LEASE_MS;
      const css = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:transparent;" +
        "display:" + (shown ? "block" : "none") + ";visibility:" + (f.invisible ? "hidden" : "visible") + ";";
      for (const name of f.host.getAttributeNames()) if (name !== "style" && name !== "aria-hidden") f.host.removeAttribute(name);
      f.host.setAttribute("aria-hidden", "true");
      if (f.host.style.cssText !== css) f.host.style.cssText = css;
    };
    globalThis.__castFramePlace = () => globalThis.__castFrame && place(globalThis.__castFrame);
    let hideTimer = null;
    globalThis.__castPointer = (x, y, kind) => {
      const f = globalThis.__castFrame;
      if (!f) return;
      f.cur.style.transform = "translate(" + x + "px," + y + "px)";
      f.cur.style.opacity = "1";
      if (kind === "down") {
        const ring = f.ring;
        ring.style.transition = "none";
        ring.style.opacity = "0.9";
        ring.style.transform = "scale(.4)";
        requestAnimationFrame(() => {
          ring.style.transition = "transform 420ms ease-out, opacity 420ms ease-out";
          ring.style.opacity = "0";
          ring.style.transform = "scale(1.4)";
        });
      }
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { f.cur.style.opacity = "0"; }, 4000);
    };
    const lease = () => globalThis.__castFramePlace();
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
  const source = borderSource(await borderColor(tabId));
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
    await evalInWorld(tabId, `(() => { const f = globalThis.__castFrame; if (f) f.host.remove(); delete globalThis.__castFrame; })()`).catch(() => {});
  }
  worlds.delete(tabId);
}

/** The pointer follows the agent's mouse events; a press pulses. Never awaited: it is a courtesy, not a step. */
function movePointer(tabId, p) {
  if (typeof p.x !== "number" || typeof p.y !== "number" || !borderIds.has(tabId)) return;
  const kind = p.type === "mousePressed" ? "down" : "move";
  evalInWorld(tabId, `globalThis.__castPointer && __castPointer(${p.x}, ${p.y}, ${JSON.stringify(kind)})`).catch(() => {});
}

/** Hidden around a screenshot so the capture shows the page, not our frame. */
async function setBorderVisible(tabId, visible) {
  if (!borderIds.has(tabId)) return;
  await evalInWorld(
    tabId,
    `(() => { const f = globalThis.__castFrame; if (f) { f.invisible = ${!visible}; globalThis.__castFramePlace(); } })()`,
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

// Events no client reads, never relayed. A websocket frame event carries the
// whole frame: a Convex app tab streams megabytes a second of them, and
// forwarding them queued every command reply behind traffic nobody wanted
// (2026-10-01). The host drops the same set (bridge/frames.ts UNRELAYED_EVENTS).
const UNRELAYED_EVENTS = new Set(["Network.webSocketFrameReceived", "Network.webSocketFrameSent"]);

chrome.debugger.onEvent.addListener((source, method, params) => {
  // A navigation tore every context down, our world with it.
  // A child session's events (source.sessionId) are its frame's, not the tab's.
  if (method === "Runtime.executionContextsCleared" && source.tabId && !source.sessionId) worlds.delete(source.tabId);
  if (method === "Page.frameNavigated" && source.tabId && !source.sessionId && params && params.frame && !params.frame.parentId) emulateFocus(source.tabId);
  if (UNRELAYED_EVENTS.has(method)) return;
  if (source.tabId && attached.has(source.tabId)) {
    const tabId = source.tabId;
    if (method === "Target.attachedToTarget" && params && params.sessionId) {
      if (!frameTargets.has(tabId)) frameTargets.set(tabId, new Map());
      frameTargets.get(tabId).set(params.sessionId, { parent: source.sessionId, params });
      const child = { tabId, sessionId: params.sessionId };
      enableFrames(child);
      // Its navigations are how the host learns where the frame landed (bridge/frameSessions.ts navigated).
      chrome.debugger.sendCommand(child, "Page.enable", {}).catch(() => {});
      // Focus emulation is per session: without it a frame in a background tab never reports focus (document.hasFocus()).
      chrome.debugger.sendCommand(child, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    } else if (method === "Target.detachedFromTarget" && params && params.sessionId) {
      frameTargets.get(tabId)?.delete(params.sessionId);
    }
    // `session` is left out (undefined) for the tab's own events, which keeps their bytes as frames.ts reads them.
    send({ op: "event", tabId, session: source.sessionId, method, params: params || {} });
  }
});

// The user can cancel via Chrome's banner; keep our books straight when they
// do. The border cannot be removed (the session is gone); its lease hides it.
chrome.debugger.onDetach.addListener((source) => {
  if (source.targetId && source.targetId === selfTarget) {
    selfTarget = null;
    holdSelf();
  }
  if (source.tabId && attached.has(source.tabId)) {
    attached.delete(source.tabId);
    borderScripts.delete(source.tabId); // the session is gone, and its scripts with it
    borderIds.delete(source.tabId);
    worlds.delete(source.tabId);
    markDriven(source.tabId);
    syncPage(source.tabId).catch(() => {});
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
  if (info.groupId !== undefined) {
    const before = tabGroupOf.get(tabId);
    tabGroupOf.set(tabId, info.groupId);
    // Chrome opens a new tab inside the active tab's group, so a tab the
    // human opens next to an agent's lands in the Cast group and wears its
    // colour. The group means "agent tabs": anything we neither opened nor
    // hold goes back out. After a moment, because a tab an agent's page
    // opened lands there too and is adopted (adoptOpened) a beat later.
    if (ownedGroups.has(info.groupId) && !ownedTabs.has(tabId) && !attached.has(tabId)) {
      setTimeout(() => {
        if (!ownedTabs.has(tabId) && !attached.has(tabId) && tabGroupOf.get(tabId) === info.groupId) chrome.tabs.ungroup([tabId]).catch(() => {});
      }, 400);
    }
    // An agent tab the human dragged out of the Cast group is theirs to keep:
    // the idle cleanup and the reaper leave it open from now on. Closing a
    // tab takes it out of its group first too (this event, then onRemoved),
    // and every closed agent tab was claimed and logged as dragged out; so
    // the claim is decided a moment later, for a tab that is still open.
    if (ownedGroups.has(before) && !ownedGroups.has(info.groupId) && ownedTabs.has(tabId) && !claimed.has(tabId)) {
      setTimeout(() => claimDraggedOut(tabId).catch(() => {}), DRAG_SETTLE_MS);
    }
  }
  send({ op: "tab", kind: "updated", tab: describeTab(t) });
});

/** How long after a tab leaves an owned group it must still be open, outside one, to count as dragged out. */
const DRAG_SETTLE_MS = 500;
async function claimDraggedOut(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || !ownedTabs.has(tabId) || claimed.has(tabId) || ownedGroups.has(t.groupId)) return;
  claimed.add(tabId);
  persistOwned();
  note(`tab ${tabId} dragged out of the Cast group; kept`);
  send({ op: "tab", kind: "updated", tab: describeTab(t) });
}
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attached.delete(tabId);
  const roles = [lentTabs.delete(tabId), reclaimed.delete(tabId), claimed.delete(tabId), adoptedFrom.delete(tabId), handoffs.delete(tabId)].some(Boolean);
  touched.delete(tabId);
  if (ownedTabs.delete(tabId) || roles) persistOwned();
  tabGroupOf.delete(tabId);
  borderScripts.delete(tabId);
  borderIds.delete(tabId);
  worlds.delete(tabId);
  send({ op: "tab", kind: "removed", tab: { tabId, url: "", title: "", active: false, windowId: info.windowId, attached: false } });
});

// --------------------------------------------------------------------------
// Tab roles: lent, driven, waiting on the human, adopted, idle
// --------------------------------------------------------------------------

/**
 * The toolbar badge for one tab says who has it: WAIT while an agent waits on
 * the human there (a handoff), RUN while an agent drives it, ON while the
 * human has lent it to agents. Chrome shows it only when the icon is pinned.
 */
function paintBadge(tabId) {
  const h = handoffs.get(tabId);
  const [text, color, title] =
    h && h.state === "waiting" ? ["WAIT", "#b26a00", "an agent is waiting for you on this tab; click to continue"]
    : attached.has(tabId) ? ["RUN", "#c62828", "an agent is driving this tab; click to take it back"]
    : lentTabs.has(tabId) ? ["ON", "#1a73e8", "lent to agents; click to take it back"]
    : ["", null, null];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `Codecast: ${title || status.state}` }).catch(() => {});
}

/** What the in-page script (page.js) should be doing on this tab. */
function pageStatus(tabId) {
  const h = handoffs.get(tabId);
  if (h && h.state === "waiting") return { state: "waiting", handoff: { id: h.id, text: h.text } };
  if (attached.has(tabId)) return { state: "running" };
  return { state: "idle" };
}

/**
 * Tell the tab's page.js its state, injecting it first when the tab has none
 * (a fresh navigation, a tab attached before this build). An idle tab is never
 * injected into: the script goes only where an agent is. True when the page
 * heard it; a chrome:// page or the Web Store cannot be scripted at all.
 */
async function syncPage(tabId) {
  const status = pageStatus(tabId);
  const tell = () => chrome.tabs.sendMessage(tabId, { op: "page-state", status }, { frameId: 0 });
  if (await tell().then(() => true, () => false)) return true;
  if (status.state === "idle" || !chrome.scripting) return false;
  const injected = await chrome.scripting
    .executeScript({ target: { tabId, frameIds: [0] }, files: ["page.js"] })
    .then(() => true, (err) => (note(`page script on tab ${tabId}: ${String((err && err.message) || err)}`), false));
  return injected && (await tell().then(() => true, () => false));
}

/**
 * Why the idle cleanup and the CLI's reaper (engineReap.ts) must leave a tab
 * open, or undefined: the human is mid-handoff on it, lent it, pinned it,
 * dragged it out of the Cast group, or it is playing sound.
 */
function keepReason(t) {
  const h = handoffs.get(t.id);
  if (h && h.state === "waiting") return "handoff";
  if (lentTabs.has(t.id)) return "lent";
  if (t.pinned) return "pinned";
  if (claimed.has(t.id)) return "claimed";
  if (t.audible) return "audible";
  return undefined;
}

/** Tell the host a tab's description changed (lent, handoff settled, adopted). */
async function announceTab(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t) send({ op: "tab", kind: "updated", tab: describeTab(t) });
}

/** An agent's tab, as opposed to one of the human's: opened for an agent, or driven by one now. */
const isAgentTab = (tabId) => ownedTabs.has(tabId) || attached.has(tabId);

/** One page.js and badge refresh for a tab whose role changed. */
function refreshTab(tabId) {
  paintBadge(tabId);
  syncPage(tabId).catch(() => {});
  announceTab(tabId).catch(() => {});
}

// ------------------------------------------------------------- handoff

/**
 * `cast browser handoff`: the CLI sends `Cast.handoff` over the tab's CDP
 * session and this worker answers it itself. The card waits until the human
 * clicks Continue (a trusted click in page.js, or the toolbar popup), the
 * timeout passes, or the CLI cancels. The tab's description carries
 * `handoff: {id, state}`, which the CLI's subscription reads from the host's
 * tab list to wake the session.
 */
async function setHandoff(tabId, p) {
  await loadOwnership();
  if (p.cancel) {
    const h = handoffs.get(tabId);
    if (h && h.state === "waiting") settleHandoff(tabId, "cancelled");
    return { id: h ? h.id : null, state: h ? h.state : "none" };
  }
  const text = String(p.text || "").trim().slice(0, 2000);
  if (!text) throw new Error("a handoff needs words for the human: what to do on this page");
  const id = typeof p.id === "string" && /^[\w-]{4,64}$/.test(p.id) ? p.id : randomHex(8);
  const wait = Math.min(Math.max(Number(p.timeoutMs) || HANDOFF_DEFAULT_MS, 10_000), HANDOFF_MAX_MS);
  handoffs.set(tabId, { id, text, at: Date.now(), expires: Date.now() + wait, state: "waiting" });
  persistOwned();
  paintBadge(tabId);
  const shown = await syncPage(tabId);
  announceTab(tabId).catch(() => {});
  // Raising is the CLI's to ask for (--show); a handoff alone never takes the human's screen.
  if (p.raise) {
    const t = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
    if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  return { id, state: "waiting", shown, expires: Date.now() + wait };
}

function settleHandoff(tabId, state) {
  const h = handoffs.get(tabId);
  if (!h || h.state !== "waiting") return false;
  h.state = state;
  h.settledAt = Date.now();
  persistOwned();
  note(`handoff ${h.id} on tab ${tabId} ${state}`);
  refreshTab(tabId);
  return true;
}

/** Expire waiting handoffs, and forget settled ones once the CLI has had an hour to read them. */
function sweepHandoffs() {
  const now = Date.now();
  for (const [tabId, h] of handoffs) {
    if (h.state === "waiting" && now > h.expires) settleHandoff(tabId, "expired");
    else if (h.state !== "waiting" && now - (h.settledAt || 0) > 60 * 60 * 1000) {
      handoffs.delete(tabId);
      persistOwned();
    }
  }
}

// ------------------------------------------------------- lend / take back

/** The human lends one of their tabs to agents: it is listed to sessions as an agent tab no session holds yet. */
async function lendTab(tabId, on) {
  await loadOwnership();
  if (on) {
    lentTabs.add(tabId);
    reclaimed.delete(tabId);
    persistOwned();
    note(`tab ${tabId} lent to agents`);
    refreshTab(tabId);
    return;
  }
  if (attached.has(tabId) || ownedTabs.has(tabId)) return takeBack(tabId);
  lentTabs.delete(tabId);
  persistOwned();
  refreshTab(tabId);
}

/**
 * The human takes a tab back from agents: the debugger lets go, the tab
 * leaves the Cast group and every session's grant, and no attach reaches it
 * until it is lent again. Sessions holding it are disconnected with the
 * reason, so the agent learns it lost the tab rather than finding it gone.
 */
async function takeBack(tabId) {
  await loadOwnership();
  lentTabs.delete(tabId);
  ownedTabs.delete(tabId);
  adoptedFrom.delete(tabId);
  claimed.delete(tabId);
  reclaimed.add(tabId);
  const h = handoffs.get(tabId);
  if (h && h.state === "waiting") settleHandoff(tabId, "cancelled");
  persistOwned();
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && ownedGroups.has(t.groupId)) await chrome.tabs.ungroup([tabId]).catch(() => {});
  await detachTab(tabId);
  send({ op: "detached", tabId, reason: "reclaimed" });
  note(`tab ${tabId} taken back by the human`);
  refreshTab(tabId);
}

// ---------------------------------------------------------- popup adoption

/** Each window's active tab and the one before, to give the human their tab back after an agent's popup took it. */
const activeHistory = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const h = activeHistory.get(windowId);
  if (!h || h.current !== tabId) activeHistory.set(windowId, { current: tabId, previous: h ? h.current : undefined });
});
chrome.windows.onRemoved.addListener((windowId) => activeHistory.delete(windowId));
chrome.tabs.query({ active: true }).then((tabs) => {
  for (const t of tabs) if (t.id !== undefined && !activeHistory.has(t.windowId)) activeHistory.set(t.windowId, { current: t.id });
}).catch(() => {});

/**
 * A tab an agent's page opened (window.open, a target=_blank link) belongs
 * with the agent: it becomes an agent tab, joins the opener's group, and the
 * host grants it to every session that holds the opener (the `opener` field
 * of its description), so `cast browser tabs` lists it there. If it took the
 * window's active tab from the human, they get their tab back; a popup window
 * that took focus gives it up. The opener comes from webNavigation: a tab's
 * own openerTabId names the window's active tab, not the background agent tab
 * whose page opened it.
 */
async function adoptOpened(tabId, opener) {
  await loadOwnership();
  if (!isAgentTab(opener) || reclaimed.has(opener)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  ownedTabs.add(tabId);
  adoptedFrom.set(tabId, opener);
  persistOwned();
  touch(tabId);
  const [win, openerTab, agentWindow] = await Promise.all([
    chrome.windows.get(tab.windowId).catch(() => null),
    chrome.tabs.get(opener).catch(() => null),
    agentWindowId(),
  ]);
  if (win && win.type === "normal") {
    if (agentWindow !== undefined && openerTab && openerTab.windowId === agentWindow && tab.windowId !== agentWindow) {
      await chrome.tabs.move(tabId, { windowId: agentWindow, index: -1 }).catch(() => {});
    }
    const h = activeHistory.get(tab.windowId);
    const previous = h && (h.current === tabId ? h.previous : h.current);
    if (tab.active && previous !== undefined && previous !== tabId && previous !== opener) {
      await chrome.tabs.update(previous, { active: true }).catch(() => {});
    }
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (now && openerTab && ownedGroups.has(openerTab.groupId) && openerTab.windowId === now.windowId && now.groupId !== openerTab.groupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: openerTab.groupId }).catch(() => {});
      tabGroupOf.set(tabId, openerTab.groupId);
    }
  } else if (win && win.focused) {
    await chrome.windows.update(win.id, { focused: false }).catch(() => {});
  }
  note(`tab ${tabId} opened by agent tab ${opener}; adopted`);
  announceTab(tabId).catch(() => {});
}

if (chrome.webNavigation) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
    adoptOpened(tabId, sourceTabId).catch((err) => note(`adopt tab ${tabId}: ${String((err && err.message) || err)}`));
  });
  // page.js lives and dies with its document: a tab an agent holds or waits on gets it again on every main-frame commit.
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    if (frameId === 0 && pageStatus(tabId).state !== "idle") syncPage(tabId).catch(() => {});
  });
}

// ------------------------------------------------------------ agent window

/**
 * The options page's "separate window" setting: agent tabs open in one window
 * of their own, created unfocused beside the human's, never minimized (a
 * minimized window's tab never answers a screenshot and its timers throttle,
 * focus emulation or not). Its id lasts the browser session; closing it means
 * the next agent tab makes a new one.
 */
async function agentWindowId() {
  const { agentWindowId: id } = await chrome.storage.session.get("agentWindowId").catch(() => ({}));
  if (typeof id !== "number") return undefined;
  const w = await chrome.windows.get(id).catch(() => null);
  return w && w.type === "normal" ? id : undefined;
}

async function separateWindowWanted() {
  const { agentWindow } = await chrome.storage.local.get("agentWindow").catch(() => ({}));
  return agentWindow === "separate";
}

let agentWindowQueue = Promise.resolve();
/** A tab in the agent window, making the window (unfocused) when there is none. One at a time, so sessions share it. */
function openInAgentWindow(props) {
  const run = async () => {
    const windowId = await agentWindowId();
    if (windowId !== undefined) return chrome.tabs.create({ ...props, windowId, active: false });
    const user = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const base = { url: props.url, focused: false, type: "normal", state: "normal", width: 1280, height: 900 };
    // Beside the human's window where Chrome accepts the bounds; it refuses a window mostly off screen.
    const beside = user && typeof user.left === "number" ? [{ left: user.left + (user.width || 0) + 8, top: user.top }, { left: Math.max(0, user.left - 1288), top: user.top }] : [];
    let w = null;
    for (const at of [...beside, {}]) {
      w = await chrome.windows.create({ ...base, ...at }).catch(() => null);
      if (w) break;
    }
    if (!w) throw new Error("Chrome would not open the agent window");
    await chrome.storage.session.set({ agentWindowId: w.id });
    const t = (w.tabs && w.tabs[0]) || (await chrome.tabs.query({ windowId: w.id }))[0];
    if (!t) throw new Error("the agent window opened with no tab");
    return t;
  };
  const next = agentWindowQueue.then(run, run);
  agentWindowQueue = next.catch(() => {});
  return next;
}

// ------------------------------------------------------------ idle cleanup

/**
 * Close agent tabs nobody drove for TAB_IDLE_MS, the bound the CLI's reaper
 * uses for the same tabs, so whichever side notices first does the same
 * thing. A tab a client still holds is in use; a tab keepReason names stays;
 * the human's own focused tab is never closed under them. The clock starts at
 * the first sight of a tab this worker has no time for (after a restart).
 */
async function cleanupIdle() {
  await loadOwnership();
  const now = Date.now();
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  for (const tabId of [...ownedTabs]) {
    if (attached.has(tabId) || !touched.has(tabId)) {
      touch(tabId);
      continue;
    }
    const idle = now - touched.get(tabId);
    if (idle < TAB_IDLE_MS) continue;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || keepReason(t)) continue;
    if (t.active && focused && focused.focused && t.windowId === focused.id) continue;
    await chrome.tabs.remove(tabId).then(
      () => note(`closed agent tab ${tabId}, idle ${Math.round(idle / 60_000)} min`),
      () => {},
    );
  }
}

chrome.alarms.create("cast-tab-roles", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "cast-tab-roles") return;
  loadOwnership().then(() => {
    sweepHandoffs();
    return cleanupIdle();
  }).catch((err) => note(`tab sweep: ${String((err && err.message) || err)}`));
});

/** The popup's view of one tab, and what its buttons do. */
async function tabAction(msg) {
  await loadOwnership();
  const tabId = msg.tabId;
  if (typeof tabId !== "number") throw new Error("no tab");
  if (msg.op === "tab-lend") await lendTab(tabId, true);
  else if (msg.op === "tab-unlend") await lendTab(tabId, false);
  else if (msg.op === "tab-take-back") await takeBack(tabId);
  else if (msg.op === "tab-continue") settleHandoff(tabId, "done");
  else if (msg.op !== "tab-state") throw new Error(`unknown op ${msg.op}`);
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return { gone: true };
  const h = handoffs.get(tabId);
  const g = ownedGroups.has(t.groupId) ? groups.get(t.groupId) : null;
  return {
    tabId,
    title: t.title || t.url || "",
    url: t.url || "",
    attached: attached.has(tabId),
    owned: ownedTabs.has(tabId),
    lent: lentTabs.has(tabId),
    adopted: adoptedFrom.has(tabId),
    keep: keepReason(t) || null,
    group: g ? { title: plainOf(g.title), color: g.color } : null,
    handoff: h ? { id: h.id, text: h.text, state: h.state, expires: h.expires } : null,
    // Chrome refuses scripts and debuggers on its own pages and the Web Store.
    lendable: /^(https?|file):/i.test(t.url || ""),
  };
}
