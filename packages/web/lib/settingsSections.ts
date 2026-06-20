// Settings modal sections and their mapping from the legacy /settings/* URLs.
//
// Settings render in a modal (components/settings/SettingsModal.tsx), not as
// pages. The old routes stay alive for hard loads (bookmarks, OAuth returns,
// plain <a href> links): SettingsLayout maps the URL through
// `settingsSectionForPath` and bounces home with the modal open, and the
// router compat shim (src/compat) intercepts in-app push/Link navigations to
// these paths so the modal opens in place with no route change at all.
//
// Pure module — no React. Imported by the store, the router compat layer, and
// the modal component; keep it dependency-free.

export type SettingsSectionId =
  | "general"
  | "accounts"
  | "notifications"
  | "team"
  | "sync"
  | "integrations"
  | "agents"
  | "agent-features"
  | "claude-accounts"
  | "cli"
  | "devices"
  | "desktop";

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

const PATH_TO_SECTION: Record<string, SettingsSectionId> = {
  "/settings": DEFAULT_SETTINGS_SECTION,
  "/settings/profile": "general",
  "/settings/accounts": "accounts",
  "/settings/notifications": "notifications",
  "/settings/team": "team",
  "/settings/sync": "sync",
  "/settings/integrations/github-app": "integrations",
  "/settings/agents": "agents",
  "/settings/agent-features": "agent-features",
  "/settings/claude-accounts": "claude-accounts",
  "/settings/cli": "cli",
  "/settings/devices": "devices",
  "/settings/desktop": "desktop",
};

export interface SettingsPathHit {
  section: SettingsSectionId;
  /** Query string (no leading "?") carried by the settings URL, e.g. the
   * GitHub OAuth error return or the team-setup handoff. Empty when none. */
  search: string;
}

/**
 * Map a /settings/* URL (path with optional query/hash) to its modal section.
 * Returns null for non-settings paths AND for the flow pages that remain real
 * routes (/settings/team/create, /settings/team/join,
 * /settings/accounts/link-github).
 */
export function settingsSectionForPath(path: string): SettingsPathHit | null {
  const qIndex = path.indexOf("?");
  const search = qIndex === -1 ? "" : path.slice(qIndex + 1).split("#")[0];
  const clean = (qIndex === -1 ? path : path.slice(0, qIndex)).split("#")[0].replace(/\/+$/, "") || "/";
  const section = PATH_TO_SECTION[clean];
  return section ? { section, search } : null;
}
