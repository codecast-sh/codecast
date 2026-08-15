const $ = (id) => document.getElementById(id);

async function load() {
  const { bridge } = await chrome.storage.local.get("bridge");
  if (bridge) {
    $("token").value = bridge.token || "";
    $("port").value = bridge.port || 41729;
  } else {
    $("port").value = 41729;
  }
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

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const port = parseInt($("port").value, 10) || 41729;
  await chrome.storage.local.set({ bridge: { token, port } });
  await chrome.runtime.sendMessage({ op: "reconnect" });
  setTimeout(refreshStatus, 600);
});

load();
refreshStatus();
setInterval(refreshStatus, 2000);
