const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 41729;

async function save(token, port) {
  await chrome.storage.local.set({ bridge: { token, port } });
  await chrome.runtime.sendMessage({ op: "reconnect" });
  setTimeout(refreshStatus, 600);
}

/**
 * `cast browser extension setup` opens this page as
 * options.html#token=T&port=P so nothing has to be pasted. A fragment never
 * leaves the browser, and it is cleared from the address bar as soon as it
 * is read so the token does not linger in history or a screenshot.
 */
async function pairFromFragment() {
  const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = (frag.get("token") || "").trim();
  if (!token) return false;
  const port = parseInt(frag.get("port") || "", 10) || DEFAULT_PORT;
  history.replaceState(null, "", location.pathname);
  await save(token, port);
  $("notice").textContent = `Paired from the terminal on port ${port}. Connecting.`;
  $("notice").hidden = false;
  return true;
}

async function load() {
  const { bridge } = await chrome.storage.local.get("bridge");
  $("token").value = (bridge && bridge.token) || "";
  $("port").value = (bridge && bridge.port) || DEFAULT_PORT;
}

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ op: "status" });
    if (!s) throw new Error("no status");
    const cls = s.state === "connected" ? "ok" : s.state === "bad-token" ? "bad" : "muted";
    const driven = s.attached && s.attached.length ? ` — driving ${s.attached.length} tab(s)` : "";
    $("status").innerHTML = `<span class="${cls}">${s.state}</span> ${s.detail || ""}${driven}`;
  } catch {
    $("status").textContent = "service worker not responding — reload the extension";
  }
}

$("save").addEventListener("click", () => {
  save($("token").value.trim(), parseInt($("port").value, 10) || DEFAULT_PORT);
});

pairFromFragment().then(load);
refreshStatus();
setInterval(refreshStatus, 2000);
