// Loads the Acme world (./world) into the shared store through the store's own
// sync writers, so every screen renders it exactly as it renders server rows.
// Both apps call it once at boot in their fixture mode: the phone's store
// shots (packages/mobile/lib/storeShots/seed.ts) and the web docs shots
// (../docsShots). Mobile's Metro reaches this file, so imports stay relative.

import { placeInboxRows, sessionPlacement, useInboxStore } from "../../store/inboxStore";
import { stampRoster } from "../activeTeam";
import { ACME_PARTS } from "./parts";
import {
  API_TRANSCRIPT,
  CHANNELS,
  CHAT_RAIL,
  CURRENT_USER,
  ENG_MESSAGES,
  RAIL_MESSAGES,
  ENG_REACTIONS,
  INBOX,
  LIVE_ROOMS,
  PLANS,
  SESSIONS,
  TASKS,
  TEAMS,
  TEAM_ID,
  TEAM_MEMBERS,
} from "./world";

function write(label: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.warn(`[acmeWorld] seeding ${label} failed`, e);
  }
}

/** The sessions at `now`: the inbox rows and the conversation records the
 *  session screen reads. */
export function stampAcmeSessions(now: number) {
  const st = useInboxStore.getState();
  const inbox = [...INBOX(now), ...ACME_PARTS.flatMap((p) => p.sessions?.(now) ?? [])];
  st.syncTable("sessions", inbox);
  for (const row of inbox) st.syncRecord("conversations", row._id, row);
}

/** `ui` and `extra` layer an app's own client state (its look, its seen tours) over the world's. */
export function seedAcmeWorld({ now = Date.now(), ui = {}, extra = {} }: { now?: number; ui?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const s = useInboxStore.getState();
  const user = CURRENT_USER(now);
  write("currentUser", () => s.syncTable("currentUser", user));
  write("teams", () => s.syncTable("teams", TEAMS));
  write("teamMembers", () => s.syncTable("teamMembers", stampRoster(TEAM_MEMBERS(now), TEAM_ID)));
  write("clientState", () =>
    s.syncTable("clientState", {
      user_id: user._id,
      ...extra,
      ui: { active_team_id: TEAM_ID, inbox_scope: "mine", sounds_enabled: false, ...ui },
    }),
  );
  write("callConfig", () => s.syncTable("callConfig", { enabled: true, url: "wss://shots.invalid", teams: [TEAM_ID] }));
  write("myCalls", () => s.syncTable("myCalls", { incoming: [], outgoing: [], membership: null }));
  write("liveRooms", () => s.syncTable("liveRooms", LIVE_ROOMS));

  write("sessions", () => stampAcmeSessions(now));
  // Liveness decays: a working row whose heartbeat is older than the trust
  // window reads as stopped (shared/contracts/agentStatus.ts), and a session
  // screen quiet for 5 minutes offers to resume. Re-stamp the sessions so the
  // world always stands at "now", however long a capture takes. A scene that
  // empties the inbox (a fresh account) sets __acmeHoldSessions to keep it empty.
  setInterval(() => (globalThis as any).__acmeHoldSessions || stampAcmeSessions(Date.now()), 15_000);
  write("messages", () => s.applyTailMessages(SESSIONS.api._id, 0, API_TRANSCRIPT(now) as any, null));
  for (const part of ACME_PARTS) if (part.seed) write(part.name, () => part.seed!(s, now));

  write("chatChannels", () =>
    s.syncTable(
      "chatChannels",
      CHANNELS.map((c: any) => ({ _id: c._id, team_id: TEAM_ID, name: c.name, kind: c.kind, dm_key: c.dm_key, topic: c.topic, is_default: c.is_default, created_at: now - 90 * 86_400_000, updated_at: now })),
    ),
  );
  write("chatMessages", () => s.syncTable("chatMessages", [...ENG_MESSAGES(now), ...RAIL_MESSAGES(now)]));
  write("chatReactions", () => s.syncTable("chatReactions", ENG_REACTIONS(now)));
  write("chatRail", () => s.syncTable("chatRail", CHAT_RAIL(now)));

  write("plans", () => s.syncTable("plans", PLANS(now)));
  write("tasks", () => s.syncTable("tasks", TASKS(now)));

  write("liveLoading", () => {
    for (const scope of ["sessions", "tasks", "plans", "docs", "chat"]) s.setLiveLoading(scope, false);
  });
  useInboxStore.setState({ clientStateInitialized: true });
}

/** Where each row lands, for tuning the fixtures from a console. */
export function placeAcmeInbox() {
  const st = useInboxStore.getState() as any;
  const placed = placeInboxRows(st) as any;
  const sections = Object.fromEntries(
    Object.entries(placed)
      .filter(([, v]) => Array.isArray(v) && (v as any[]).every((r) => r && typeof r === "object" && "_id" in r))
      .map(([k, v]) => [k, (v as any[]).map((r) => r._id)]),
  );
  const rows = Object.fromEntries(Object.values(st.sessions).map((r: any) => [r._id, sessionPlacement(r)]));
  return { sections, rows };
}
