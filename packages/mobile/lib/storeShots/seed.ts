// Loads the Acme world (./world) into the app's store through the store's own
// sync writers, so every screen renders it exactly as it renders server rows.
// Runs once at boot in store shots mode (./flag), after the SQLite cache has
// hydrated so the cache cannot merge stale rows over it.

import { placeInboxRows, sessionPlacement, useInboxStore } from "@codecast/web/store/inboxStore";
import {
  API_TRANSCRIPT,
  CHANNELS,
  CHAT_RAIL,
  CURRENT_USER,
  ENG_MESSAGES,
  ENG_REACTIONS,
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

  const inbox = INBOX(now);
  write("sessions", () => s.syncTable("sessions", inbox));
  write("conversations", () => {
    for (const row of inbox) s.syncRecord("conversations", row._id, row);
  });
  write("messages", () => s.applyTailMessages(SESSIONS.api._id, 0, API_TRANSCRIPT(now) as any, null));

  write("chatChannels", () =>
    s.syncTable(
      "chatChannels",
      CHANNELS.map((c) => ({ _id: c._id, team_id: TEAM_ID, name: c.name, kind: c.kind, topic: c.topic, is_default: c.is_default, created_at: now - 90 * 86_400_000, updated_at: now })),
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

