import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "./useMountEffect";

const MIGRATION_KEY = "codecast-prefs-migrated-v1";

export function useLocalStorageMigration() {
  const updateUI = useInboxStore((s) => s.updateClientUI);
  const updateLayout = useInboxStore((s) => s.updateClientLayout);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const hasServerPrefs = useInboxStore((s) => !!s.clientState.ui);

  useMountEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(MIGRATION_KEY)) return;
    if (hasServerPrefs) {
      localStorage.setItem(MIGRATION_KEY, "1");
      return;
    }

    const ui: Record<string, any> = {};
    const layouts: Record<string, any> = {};
    const dismissed: Record<string, any> = {};

    const theme = localStorage.getItem("codecast-theme");
    if (theme === "dark" || theme === "light") ui.theme = theme;
    if (localStorage.getItem("sidebarCollapsed") === "true") ui.sidebar_collapsed = true;
    if (localStorage.getItem("zenMode") === "true") ui.zen_mode = true;
    if (localStorage.getItem("stickyHeadersDisabled") === "true") ui.sticky_headers_disabled = true;
    if (localStorage.getItem("diffPanelOpen") === "true") ui.diff_panel_open = true;
    const viewMode = localStorage.getItem("file-diff-view-mode");
    if (viewMode === "unified" || viewMode === "split") ui.file_diff_view_mode = viewMode;
    if (localStorage.getItem("inbox-shortcuts") === "hidden") ui.inbox_shortcuts_hidden = true;

    try {
      const teamData = JSON.parse(localStorage.getItem("codecast-active-team") || "{}");
      if (teamData?.state?.activeTeamId) ui.active_team_id = teamData.state.activeTeamId;
    } catch {}

    try {
      const dl = localStorage.getItem("dashboard-layout");
      if (dl) layouts.dashboard = JSON.parse(dl);
    } catch {}
    try {
      const il = localStorage.getItem("inbox-layout");
      if (il) {
        const p = JSON.parse(il);
        layouts.inbox = { main: p["inbox-main"], sidebar: p["inbox-sidebar"] };
      }
    } catch {}
    try {
      const cdl = localStorage.getItem("conversation-diff-layout");
      if (cdl) {
        const p = JSON.parse(cdl);
        layouts.conversation_diff = { content: p["content-panel"], diff: p["diff-panel"] };
      }
    } catch {}
    try {
      const fdl = localStorage.getItem("file-diff-layout");
      if (fdl) {
        const p = JSON.parse(fdl);
        layouts.file_diff = { tree: p["file-tree"], content: p["diff-content"] };
      }
    } catch {}

    if (localStorage.getItem("codecast-desktop-banner-dismissed") === "1") dismissed.desktop_app = true;
    const setupTs = localStorage.getItem("codecast-setup-banner-dismissed");
    if (setupTs) dismissed.setup_prompt = parseInt(setupTs, 10);

    if (Object.keys(ui).length > 0) updateUI(ui as any);
    for (const [k, v] of Object.entries(layouts)) updateLayout(k as any, v);
    for (const [k, v] of Object.entries(dismissed)) updateDismissed(k as any, v);

    localStorage.setItem(MIGRATION_KEY, "1");
  });
}
