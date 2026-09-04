const $ = (id) => document.getElementById(id);

async function save(token, port) {
  await chrome.storage.local.set({ bridge: { token, port } });
  await chrome.runtime.sendMessage({ op: "reconnect" });
  setTimeout(refreshStatus, 600);
}

/** While a pairing offer is on screen the periodic refresh must not paint over it. */
let pairingOffer = null;

/**
 * `cast browser extension setup` opens this page as
 * options.html#token=T&port=P so nothing has to be typed. A fragment never
 * leaves the browser, and it is cleared from the address bar as soon as it
 * is read so the token does not linger in history or a screenshot.
 *
 * Setup reaches this page through a file: page (the only way to land in the
 * right Chrome without the token on a command line), so any local HTML file
 * the human opens could arrive here too. This page cannot tell the two apart;
 * the human can, because they just ran the command. So a token this extension
 * already holds reconnects on its own (a Chrome or host restart), and a new
 * one is shown with its port and waits for one click.
 */
async function pairFromFragment() {
  const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = (frag.get("token") || "").trim();
  if (!token) return false;
  const port = parseInt(frag.get("port") || "", 10) || CAST_DEFAULT_PORT;
  history.replaceState(null, "", location.pathname);
  const { bridge } = await chrome.storage.local.get("bridge");
  if (bridge && bridge.token === token && bridge.port === port) {
    // Shown until the worker reports; refreshStatus then owns the block.
    renderBridgeStatus($("status"), { state: "connecting", attached: [] }, port);
    $("status").querySelector("[data-title]").textContent = "Pairing from the terminal";
    await save(token, port);
    return true;
  }
  pairingOffer = { token, port };
  const root = $("status");
  root.classList.remove("state-ok", "state-wait", "state-bad", "state-none");
  root.classList.add("state-wait");
  root.querySelector("[data-title]").textContent = "Pair with cast?";
  root.querySelector("[data-text]").textContent =
    `A terminal on this machine asked to pair this extension with the bridge host on port ${port}. ` +
    "Continue only if you just ran cast browser extension setup.";
  $("reconnect").hidden = true;
  $("pair").hidden = false;
  return true;
}

$("pair").addEventListener("click", async () => {
  const offer = pairingOffer;
  if (!offer) return;
  pairingOffer = null;
  $("pair").hidden = true;
  renderBridgeStatus($("status"), { state: "connecting", attached: [] }, offer.port);
  $("status").querySelector("[data-title]").textContent = "Pairing from the terminal";
  await save(offer.token, offer.port);
  await load();
});

async function load() {
  const { bridge } = await chrome.storage.local.get("bridge");
  $("token").value = (bridge && bridge.token) || "";
  $("port").value = (bridge && bridge.port) || CAST_DEFAULT_PORT;
}

/** The tabs a session holds right now, each under its group's name. */
async function renderTabs(ids) {
  const list = $("tabs");
  const rows = await Promise.all(
    (ids || []).map(async (id) => {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (!t) return null;
      const g = t.groupId >= 0 ? await chrome.tabGroups.get(t.groupId).catch(() => null) : null;
      return { title: t.title || t.url || "", group: g };
    }),
  );
  list.replaceChildren(
    ...rows.filter(Boolean).map((r) => {
      const li = document.createElement("li");
      if (r.group) {
        const chip = document.createElement("span");
        chip.className = "group";
        chip.textContent = r.group.title || "cast";
        chip.style.background = GROUP_COLOR_HEX[r.group.color] || GROUP_COLOR_HEX.blue;
        li.appendChild(chip);
      }
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = r.title;
      li.appendChild(title);
      return li;
    }),
  );
}


async function refreshStatus() {
  if (pairingOffer) return;
  const s = await readBridgeStatus();
  const port = parseInt($("port").value, 10) || CAST_DEFAULT_PORT;
  const d = renderBridgeStatus($("status"), s, port);
  $("reconnect").hidden = d.cls !== "state-wait" && d.cls !== "state-bad";
  await renderTabs(s.attached);
}

$("save").addEventListener("click", () => {
  save($("token").value.trim(), parseInt($("port").value, 10) || CAST_DEFAULT_PORT);
});
$("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ op: "reconnect" }).catch(() => {});
  setTimeout(refreshStatus, 600);
});
$("version").textContent = `v${chrome.runtime.getManifest().version}`;

pairFromFragment().then(load).then(refreshStatus);
setInterval(refreshStatus, 2000);
