const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await readBridgeStatus();
  const { bridge } = await chrome.storage.local.get("bridge");
  renderBridgeStatus($("status"), s, (bridge && bridge.port) || CAST_DEFAULT_PORT);
  const rows = await Promise.all(
    (s.attached || []).map(async (id) => {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (!t) return null;
      const g = t.groupId >= 0 ? await chrome.tabGroups.get(t.groupId).catch(() => null) : null;
      return { id, title: t.title || t.url || "", group: g };
    }),
  );
  $("tabs").replaceChildren(
    ...rows.filter(Boolean).map((r) => {
      const li = document.createElement("li");
      li.title = "Show this tab";
      li.style.cursor = "pointer";
      li.addEventListener("click", () => chrome.tabs.update(r.id, { active: true }));
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


$("reconnect").addEventListener("click", async () => {
  await reconnectWorker();
  setTimeout(refresh, 600);
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh();
setInterval(refresh, 1500);

// ------------------------------------------------------------- this tab

/**
 * The tab the human is looking at, and what they can do about it:
 * WAIT  an agent handed them a step here  → Continue
 * RUN   an agent drives it                 → Take back
 * ON    they lent it to agents             → Stop lending
 * AGENT an agent's tab, idle               → Take back
 * —     their own tab                      → Lend to agents
 */
let viewed = null;

async function refreshTab() {
  // `?tab=<id>` shows the popup for one tab when it is opened as a page (screenshots, tests).
  const pinned = Number(new URLSearchParams(location.search).get("tab")) || undefined;
  const [active] = pinned ? [await chrome.tabs.get(pinned).catch(() => undefined)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const box = $("tab");
  if (!active || active.id === undefined) return void (box.hidden = true);
  const t = await askWorker({ op: "tab-state", tabId: active.id });
  if (!t || t.error || t.gone) return void (box.hidden = true);
  viewed = t;
  const role = t.handoff && t.handoff.state === "waiting" ? "waiting" : t.attached ? "running" : t.lent ? "lent" : t.owned ? "agent" : "human";
  const view = {
    waiting: { badge: "WAIT", primary: ["Continue", "tab-continue"], secondary: ["Take back", "tab-take-back"] },
    running: { badge: "RUN", primary: ["Take back", "tab-take-back"] },
    lent: { badge: "ON", primary: ["Stop lending", "tab-unlend"] },
    agent: { badge: "AGENT", primary: ["Take back", "tab-take-back"] },
    human: { badge: "YOURS", primary: t.lendable ? ["Lend to agents", "tab-lend"] : null },
  }[role];
  box.hidden = false;
  box.dataset.role = role;
  box.querySelector("[data-badge]").textContent = view.badge;
  box.querySelector("[data-name]").textContent = t.title;
  box.querySelector("[data-ask]").textContent = role === "waiting" ? t.handoff.text : "";
  setButton($("primary"), view.primary);
  setButton($("secondary"), view.secondary);
}

function setButton(button, spec) {
  button.hidden = !spec;
  if (!spec) return;
  button.textContent = spec[0];
  button.dataset.op = spec[1];
}

for (const id of ["primary", "secondary"]) {
  $(id).addEventListener("click", async (e) => {
    const op = e.currentTarget.dataset.op;
    if (!viewed || !op) return;
    e.currentTarget.disabled = true;
    await askWorker({ op, tabId: viewed.tabId });
    e.currentTarget.disabled = false;
    refreshTab();
  });
}
refreshTab();
setInterval(refreshTab, 1500);
