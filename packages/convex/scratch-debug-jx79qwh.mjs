// Throwaway: replay the web's two inbox channels as the real user and classify
// jx79qwh with the web classifier's exact branch order. Delete after use.
import { ConvexHttpClient } from "convex/browser";

const TOKEN = process.env.MINTED_JWT;
const CONV_ID = "jx79qwhm88x4qkd5p7m5vdjths8awwcr";
const client = new ConvexHttpClient("https://convex.codecast.sh");
client.setAuth(TOKEN);

const pick = (r) => r && {
  agent_status: r.agent_status, is_idle: r.is_idle, awaiting_input: r.awaiting_input,
  is_unresponsive: r.is_unresponsive, is_connected: r.is_connected,
  has_pending: r.has_pending, pending_api_error: r.pending_api_error,
  pending_api_error_kind: r.pending_api_error_kind, is_pinned: r.is_pinned,
  message_count: r.message_count, updated_at: new Date(r.updated_at).toISOString(),
};

// Mirror of isSessionWaitingForInput (inboxStore.ts) — branch by branch
function classify(s) {
  const DEAD = new Set(["stopped", "crashed", "completed"]);
  const dead = !!s.agent_status && DEAD.has(s.agent_status);
  const canDeliver = !s.is_unresponsive && !dead;
  if (s.awaiting_input && !s.is_pinned) return "NEEDS_INPUT (awaiting_input)";
  if (s.pending_api_error && s.message_count > 0 && !s.is_pinned) return "NEEDS_INPUT (pending_api_error)";
  if (s.agent_status === "permission_blocked") return s.message_count > 0 && !s.is_pinned ? "NEEDS_INPUT (permission_blocked)" : "working";
  if (canDeliver && s.has_pending) return "working (has_pending)";
  if (dead) return s.message_count > 0 && !s.is_pinned ? "NEEDS_INPUT (dead)" : "working";
  const ACTIVE = new Set(["working", "responding", "tool_running", "thinking"]);
  const active = !!s.agent_status && ACTIVE.has(s.agent_status);
  const idle = active ? false : s.is_idle;
  return idle && s.message_count > 0 && !s.is_pinned ? "NEEDS_INPUT (idle fallthrough)" : "working";
}

const [base, overlay, full] = await Promise.all([
  client.query("conversations:listInboxSessions", { include_liveness: false }),
  client.query("conversations:sessionsLiveness", {}),
  client.query("conversations:listInboxSessions", {}),
]);

const baseRow = base.sessions.find((s) => s._id === CONV_ID);
const overlayRow = overlay.liveness[CONV_ID];
const fullRow = full.sessions.find((s) => s._id === CONV_ID);

console.log("BASE row (include_liveness:false):", JSON.stringify(pick(baseRow), null, 1));
console.log("OVERLAY entry:", JSON.stringify(overlayRow, null, 1));
console.log("FULL row (liveness bundled):", JSON.stringify(pick(fullRow), null, 1));
console.log("base sessions:", base.sessions.length, "| overlay entries:", Object.keys(overlay.liveness).length, "| in overlay:", !!overlayRow);
if (fullRow) console.log("FULL verdict:", classify(fullRow));
if (baseRow) {
  const merged = { ...baseRow, ...(overlayRow ?? {}) };
  console.log("BASE+OVERLAY verdict (what a fresh web client renders):", classify(merged));
  console.log("BASE-only verdict (overlay never arrived):", classify(baseRow));
}
