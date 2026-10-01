/**
 * The mobile app's tab bar and screen header, as plain values both renderers
 * accept: the React Native tab layout (mobile/app/(tabs)/_layout.tsx) feeds
 * them to expo-router's Tabs, and the web PhoneAppChrome (the marketing
 * hero's phone) spreads them into inline styles. Geometry, type and the tab
 * list live here; colours stay with each renderer's theme (the app's
 * Theme.bgAlt and Theme.text, the web's --sol-bg-alt and --sol-text), which
 * are the same Solarized values. Keys are limited to ones React Native and
 * React DOM share, so padding is spelled per side and numbers are pixels.
 */

export const MOBILE_TAB_BAR_STYLE = {
  borderTopWidth: 1,
  height: 84,
  paddingTop: 8,
  paddingBottom: 28,
} as const;

export const MOBILE_TAB_LABEL_STYLE = { fontSize: 10 } as const;

export const MOBILE_TAB_ICON_SIZE = 22;

/** The unread count on a tab's icon. */
export const MOBILE_TAB_BADGE_STYLE = {
  position: "absolute",
  top: -4,
  right: -8,
  borderRadius: 8,
  minWidth: 16,
  height: 16,
  alignItems: "center",
  justifyContent: "center",
  paddingLeft: 3,
  paddingRight: 3,
} as const;

export const MOBILE_TAB_BADGE_TEXT_STYLE = { color: "#fff", fontSize: 9, fontWeight: "700" } as const;

export const MOBILE_HEADER_STYLE = { borderBottomWidth: 1 } as const;

export const MOBILE_HEADER_TITLE_STYLE = { fontSize: 16 } as const;

/** The tabs the bar shows, in order: the route, the screen's title, the bar's label, and its FontAwesome glyph. */
export const MOBILE_TABS = [
  { name: "inbox", title: "Inbox", label: "Inbox", icon: "inbox" },
  { name: "chat", title: "Chat", label: "Chat", icon: "comments" },
  { name: "tasks", title: "Tasks", label: "Tasks", icon: "check-square-o" },
  // "Notifications" doesn't fit a 5-tab bar in mono: a short label, the full title on the screen's header.
  { name: "notifications", title: "Notifications", label: "Alerts", icon: "bell" },
  { name: "settings", title: "Settings", label: "Settings", icon: "cog" },
] as const;

export type MobileTabName = (typeof MOBILE_TABS)[number]["name"];

export const MOBILE_TAB = Object.fromEntries(MOBILE_TABS.map((t) => [t.name, t])) as {
  [K in MobileTabName]: Extract<(typeof MOBILE_TABS)[number], { name: K }>;
};
