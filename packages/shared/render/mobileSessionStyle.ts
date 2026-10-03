/**
 * The mobile session screen's look (packages/mobile/app/session/[id].tsx), as
 * plain values both renderers accept: the React Native screen feeds them to
 * StyleSheet.create, and the web phone views (components/PhoneSession.tsx,
 * the marketing hero's phone) spread them into inline styles. Geometry and
 * type live here; theme colours stay with each renderer (the app's Theme,
 * the web's --sol-* tokens, the same Solarized values). Keys are limited to
 * ones React Native and React DOM share, so padding is spelled per side and
 * numbers are pixels on the web. Hairline borders stay with each renderer.
 */

/** The slim title bar under the status bar: back, title, actions. */
export const MOBILE_SESSION_HEADER_HEIGHT = 40;

/** Every metadata chip in the app's chrome (session header strip, model switcher, footer status). */
export const MOBILE_CHIP_HEIGHT = 22;

export const MOBILE_CHIP_STYLE = {
  shell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: MOBILE_CHIP_HEIGHT,
    borderRadius: 6,
    paddingLeft: 7,
    paddingRight: 7,
    maxWidth: 160,
  },
  text: {
    fontSize: 11,
    fontWeight: "600",
  },
} as const;

/** A status dot: the live dot in the header strip and the pulsing one beside a status label. */
const DOT = { width: 6, height: 6, borderRadius: 3 } as const;

export const MOBILE_SESSION_STYLE = {
  pinnedHeader: { flexDirection: "row", alignItems: "center", paddingLeft: 6, paddingRight: 6, gap: 2 },
  headerIconBtn: { width: 34, height: 34, justifyContent: "center", alignItems: "center" },
  headerTitleText: { flex: 1, fontSize: 15, fontWeight: "600" },
  floatingSessionCard: { paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4 },
  sessionMeta: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "nowrap", paddingRight: 8 },
  metaBadgeIcon: { flexDirection: "row", alignItems: "center", gap: 4 },
  messageCountText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.2 },
  dot: DOT,
  messageList: { padding: 16 },
  messageBubble: { marginBottom: 2, borderRadius: 12, overflow: "hidden" },
  userBubble: { borderWidth: 1, alignSelf: "stretch", maxWidth: "100%", marginTop: 12, marginBottom: 4 },
  assistantBubble: { alignSelf: "stretch" },
  assistantBubbleFirst: { marginTop: 8 },
  bubbleHeader: { flexDirection: "row", justifyContent: "flex-start", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 4 },
  bubbleRole: { fontSize: 12, fontWeight: "500" },
  bubbleTime: { fontSize: 11 },
  bubbleContent: { paddingLeft: 14, paddingRight: 14, paddingBottom: 10 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  userAvatar: { width: 18, height: 18, borderRadius: 9, justifyContent: "center", alignItems: "center", marginRight: 4 },
  userAvatarText: { fontSize: 10, fontWeight: "700" },
  agentDot: { ...DOT, marginRight: 4 },
  modelBadge: { fontSize: 9, marginLeft: 4 },
  toolCallOnlyBubble: { marginBottom: 1 },
  toolCallsCompact: { paddingLeft: 14, paddingRight: 14, paddingTop: 2, paddingBottom: 2, gap: 1 },
  toolCallsContainer: { paddingLeft: 14, paddingRight: 14, paddingBottom: 8, gap: 2 },
  toolCallHeader: { fontSize: 12, lineHeight: 18 },
  toolCallName: { fontSize: 12, fontWeight: "600" },
  toolCallSummary: { fontSize: 12 },
  toolCallResultHint: { fontSize: 11 },
  composerCard: { marginLeft: 10, marginRight: 10, marginTop: 6, borderRadius: 20 },
  composerActions: { flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 8, paddingBottom: 8, paddingTop: 2 },
  composerSpacer: { flex: 1, alignItems: "center", justifyContent: "center" },
  composerStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  textInput: { paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 4, fontSize: 15, minHeight: 38 },
  imageButton: { width: 32, height: 32, justifyContent: "center", alignItems: "center" },
  sendButton: { minWidth: 44, height: 44, borderRadius: 22, justifyContent: "center", alignItems: "center", paddingLeft: 12, paddingRight: 12 },
} as const;

/** The composer's placeholder, live and resumable. */
export const MOBILE_COMPOSER_PLACEHOLDER = { active: "Type a message...", idle: "Send to resume session..." } as const;

/**
 * Agent statuses the composer shows between its buttons, with their tint and
 * label. Statuses not listed (idle, disconnected) show nothing. The tints are
 * the same in the app's light and dark palettes.
 */
export const MOBILE_COMPOSER_STATUS: Record<string, { color: string; label: string }> = {
  working: { color: "#10b981", label: "Working" },
  thinking: { color: "#6c71c4", label: "Thinking" },
  compacting: { color: "#f59e0b", label: "Compacting" },
  // Both settle verdicts that park the session on a machine wake read as one
  // word, matching the inbox's Dormant section: "waiting" is the daemon's
  // inference from open background work, "dormant" the agent's declaration.
  waiting: { color: "#268bd2", label: "Dormant" },
  dormant: { color: "#268bd2", label: "Dormant" },
  permission_blocked: { color: "#cb4b16", label: "Needs Input" },
  connected: { color: "#2aa198", label: "Connected" },
};

/** How the app names each agent in a transcript and the header strip. */
export const MOBILE_AGENT_LABEL: Record<string, string> = {
  claude_code: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
  pi: "pi",
  grok: "Grok",
};

/** Each agent's tint in the header strip; others take the theme's (grok its text colour, the rest its accent). */
export const MOBILE_AGENT_TINT: Record<string, string> = {
  codex: "#10b981",
  cursor: "#60a5fa",
  gemini: "#1a73e8",
  opencode: "#f97316",
  pi: "#14b8a6",
};

/** The tile behind each agent's logo; others take the theme's (grok its text colour, the rest Solarized orange). */
export const MOBILE_AGENT_LOGO_BG: Record<string, string> = {
  codex: "#0f0f0f",
  cursor: "#1a1a2e",
  gemini: "#1a73e8",
  opencode: "#f97316",
  pi: "#14b8a6",
  muse: "#0866FF",
};

/** Muse Spark's mark: Meta's infinity logo (24x24, evenodd), on web and mobile alike. */
export const MUSE_MARK_PATH =
  "M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z";

/** How the app's transcript and header strip say when something happened. */
export function mobileRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/** The app's two breathing dots: each fades to `low` and back, one leg per `leg` ms, eased in and out. */
export const MOBILE_PULSE = {
  /** The live dot in the session's header strip. */
  live: { leg: 1000, low: 0.3 },
  /** The dot beside an agent status (composer, session rows). */
  status: { leg: 800, low: 0.3 },
} as const;
