const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 41729;

async function save(token, port) {
  await chrome.storage.local.set({ bridge: { token, port } });
  await chrome.runtime.sendMessage({ op: "reconnect" });
  setTimeout(refreshStatus, 600);
}

/**
 * `cast browser extension setup` opens this page as
 * options.html#token=T&port=P so nothing has to be typed. A fragment never
 * leaves the browser, and it is cleared from the address bar as soon as it
 * is read so the token does not linger in history or a screenshot.
 */
async function pairFromFragment() {
  const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = (frag.get("token") || "").trim();
  if (!token) return false;
  const port = parseInt(frag.get("port") || "", 10) || DEFAULT_PORT;
  history.replaceState(null, "", location.pathname);
  // Shown until the worker reports; refreshStatus then owns the line.
  show("muted", `Paired from the terminal on port ${port}. Connecting.`);
  await save(token, port);
  return true;
}

async function load() {
  const { bridge } = await chrome.storage.local.get("bridge");
  $("token").value = (bridge && bridge.token) || "";
  $("port").value = (bridge && bridge.port) || DEFAULT_PORT;
}

function show(cls, text) {
  const el = $("status");
  el.className = cls;
  el.textContent = text;
}

/**
 * One status line, in words a person can act on. The worker's state names
 * are internal; each becomes a sentence that says what is true and, when
 * something is needed, the one command that provides it.
 */
function describe(s, port) {
  const driving = s.attached && s.attached.length ? ` Driving ${s.attached.length} tab${s.attached.length === 1 ? "" : "s"}.` : "";
  switch (s.state) {
    case "connected":
      return ["ok", `Paired and connected to cast on port ${port}. You can close this tab.${driving}`];
    case "connecting":
    case "disconnected":
      return ["muted", `Paired. Waiting for the bridge host on port ${port}; it starts with the next \`cast browser\` command in real mode.`];
    case "bad-token":
      return ["bad", "The host rejected this token. Run `cast browser extension setup` again; it hands this page the current token."];
    default:
      return ["muted", "No pairing yet. Run `cast browser extension setup` in a terminal on this machine."];
  }
}

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ op: "status" });
    if (!s) throw new Error("no status");
    const port = parseInt($("port").value, 10) || DEFAULT_PORT;
    show(...describe(s, port));
  } catch {
    show("bad", "The extension's service worker is not answering. Reload the extension from chrome://extensions.");
  }
}

$("save").addEventListener("click", () => {
  save($("token").value.trim(), parseInt($("port").value, 10) || DEFAULT_PORT);
});

pairFromFragment().then(load).then(refreshStatus);
setInterval(refreshStatus, 2000);
