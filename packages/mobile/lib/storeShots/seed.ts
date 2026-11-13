// The phone layer of the Acme world: seeds it through the shared seed
// (@codecast/web/lib/acmeWorld/seed), then adds what only the phone has (the
// heavy perf account, the huddle and Lock Screen probes). Runs once at boot in
// store shots mode (./flag), after the SQLite cache has hydrated so the cache
// cannot merge stale rows over it.

import { deriveLiveActivityState } from "@codecast/shared/contracts";
import { placeAcmeInbox, seedAcmeWorld } from "@codecast/web/lib/acmeWorld/seed";
import { ASK, HUDDLE_PARTICIPANTS, HUDDLE_ROOM, INBOX } from "@codecast/web/lib/acmeWorld/world";
import { liveActivityNative } from "../../modules/codecast-live-activity";
import { seedHeavy } from "./heavy";

export function seedStoreShots(now = Date.now()) {
  // The shots wear the Modern look whatever the default resolves to.
  seedAcmeWorld({ now, ui: { mobile_modern_style: true } });
  try {
    seedHeavy(now);
  } catch (e) {
    console.warn("[storeShots] seeding heavy failed", e);
  }
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
  place: placeAcmeInbox,
};

