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
  await chrome.runtime.sendMessage({ op: "reconnect" }).catch(() => {});
  setTimeout(refresh, 600);
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh();
setInterval(refresh, 1500);
