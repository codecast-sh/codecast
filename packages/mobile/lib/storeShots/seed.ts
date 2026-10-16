// Loads the Acme world (./world) into the app's store through the store's own
// sync writers, so every screen renders it exactly as it renders server rows.
// Runs once at boot in store shots mode (./flag), after the SQLite cache has
// hydrated so the cache cannot merge stale rows over it.

import { placeInboxRows, sessionPlacement, useInboxStore } from "@codecast/web/store/inboxStore";
import { deriveLiveActivityState } from "@codecast/shared/contracts";
import { liveActivityNative } from "../../modules/codecast-live-activity";
import {
  API_TRANSCRIPT,
  CHANNELS,
  CHAT_RAIL,
  CURRENT_USER,
  ENG_MESSAGES,
  ENG_REACTIONS,
  ASK,
  HUDDLE_PARTICIPANTS,
  HUDDLE_ROOM,
  INBOX,
  LIVE_ROOMS,
  PLANS,
  TASKS,
  TEAMS,
  TEAM_ID,
  TEAM_MEMBERS,
  SESSIONS,
} from "./world";

function write(label: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.warn(`[storeShots] seeding ${label} failed`, e);
  }
}

/** The sessions at `now`: the inbox rows and the conversation records the
 *  session screen reads. */
function stampLive(now: number) {
  const st = useInboxStore.getState();
  const inbox = INBOX(now);
  st.syncTable("sessions", inbox);
  for (const row of inbox) st.syncRecord("conversations", row._id, row);
}

export function seedStoreShots(now = Date.now()) {
  const s = useInboxStore.getState();
  const user = CURRENT_USER(now);
  write("currentUser", () => s.syncTable("currentUser", user));
  write("teams", () => s.syncTable("teams", TEAMS));
  write("teamMembers", () => s.syncTable("teamMembers", TEAM_MEMBERS(now)));
  write("clientState", () =>
    s.syncTable("clientState", {
      user_id: user._id,
      ui: { active_team_id: TEAM_ID, inbox_scope: "mine", sounds_enabled: false },
    }),
  );
  write("callConfig", () => s.syncTable("callConfig", { enabled: true, url: "wss://shots.invalid", teams: [TEAM_ID] }));
  write("myCalls", () => s.syncTable("myCalls", { incoming: [], outgoing: [], membership: null }));
  write("liveRooms", () => s.syncTable("liveRooms", LIVE_ROOMS));

  write("sessions", () => stampLive(now));
  // Liveness decays: a working row whose heartbeat is older than the trust
  // window reads as stopped (shared/contracts/agentStatus.ts), and a session
  // screen quiet for 5 minutes offers to resume. Re-stamp the sessions so the
  // world always stands at "now", however long a capture takes.
  setInterval(() => stampLive(Date.now()), 15_000);
  write("messages", () => s.applyTailMessages(SESSIONS.api._id, 0, API_TRANSCRIPT(now) as any, null));

  write("chatChannels", () =>
    s.syncTable(
      "chatChannels",
      CHANNELS.map((c: any) => ({ _id: c._id, team_id: TEAM_ID, name: c.name, kind: c.kind, dm_key: c.dm_key, topic: c.topic, is_default: c.is_default, created_at: now - 90 * 86_400_000, updated_at: now })),
    ),
  );
  write("chatMessages", () => s.syncTable("chatMessages", ENG_MESSAGES(now)));
  write("chatReactions", () => s.syncTable("chatReactions", ENG_REACTIONS(now)));
  write("chatRail", () => s.syncTable("chatRail", CHAT_RAIL(now)));

  write("plans", () => s.syncTable("plans", PLANS(now)));
  write("tasks", () => s.syncTable("tasks", TASKS(now)));

  write("liveLoading", () => {
    for (const scope of ["sessions", "tasks", "plans", "docs", "chat"]) s.setLiveLoading(scope, false);
  });
  useInboxStore.setState({ clientStateInitialized: true });
}

// Probe for tuning the fixtures: where each row lands, read in the running app
// over the Hermes inspector (`__storeShots.place()`).
(global as any).__storeShots = {
  seed: seedStoreShots,
  // The huddle screen with no room behind it: Alex in #eng with Sarah and
  // Maya, Sarah speaking. Captions come from the stub's transcripts.getLive.
  huddle: () =>
    (global as any).__call?.stage({
      phase: "connected",
      roomKey: HUDDLE_ROOM,
      muted: false,
      cameraOn: false,
      speakerOn: true,
      speaking: ["hero-u-sarah"],
      error: null,
      participants: HUDDLE_PARTICIPANTS,
    }),
  // The Lock Screen strip as the server would derive it for this inbox: the
  // question waiting on Alex on top, then the agents still working.
  lock: () => {
    const now = Date.now();
    const rows = INBOX(now);
    const pick = (title: string) => rows.find((r) => r.title === title)!;
    const strip = [
      { row: pick("Webhook API half"), status: "waiting" as const, detail: ASK.question },
      { row: pick("Retry failed webhooks"), status: "working" as const, detail: "14 of 16 tests green" },
      { row: pick("Dashboard retry UI"), status: "working" as const, detail: "Wiring the endpoint's states" },
      { row: pick("Rate limiter for the public API"), status: "working" as const, detail: "4,000 req/s holds on one node" },
    ].map(({ row, status, detail }) => ({
      id: row._id,
      title: row.title,
      detail,
      agent: row.agent_type,
      project: row.project_path.split("/").pop(),
      status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
    return liveActivityNative?.start(deriveLiveActivityState(strip, now));
  },
  place: () => {
    const st = useInboxStore.getState() as any;
    const placed = placeInboxRows(st) as any;
    const sections = Object.fromEntries(
      Object.entries(placed)
        .filter(([, v]) => Array.isArray(v) && (v as any[]).every((r) => r && typeof r === "object" && "_id" in r))
        .map(([k, v]) => [k, (v as any[]).map((r) => r._id)]),
    );
    const rows = Object.fromEntries(Object.values(st.sessions).map((r: any) => [r._id, sessionPlacement(r)]));
    return { sections, rows };
  },
};

