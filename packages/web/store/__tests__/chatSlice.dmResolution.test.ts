import { describe, expect, it } from "bun:test";
// chatSlice is loaded through the store, as the app loads it: importing it
// first trips the store's import cycle.
import "../inboxStore";
import { CHAT_CHANNEL_STUB_PREFIX, findDmChannelId, resolveChannelStubId } from "../chatSlice";

// Real Convex ids are 32 chars — the store branches on that everywhere to tell a
// server row from a local stub.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

// ── DM channel resolution: real rows beat stubs ─────────────────────────────
//
// A press that races the channel sync creates a stub DM whose dm_key matches
// the real channel. The server's idempotent open answers with the EXISTING
// row (someone else's client_id), so nothing supersedes the stub — it lives
// forever in the cache. These pin that a persisted stub can never again
// shadow the real channel, and that a stub in flight can be resolved to the
// row that makes it real.

describe("findDmChannelId", () => {
  const DM_KEY = "team1:usera:userb";
  const REAL = serverId("dmreal");
  const STUB = `${CHAT_CHANNEL_STUB_PREFIX}abc123`;

  it("prefers the real row when a stub carries the same dm_key", () => {
    // Stub first in insertion order — the order that used to poison the key.
    const rows = {
      [STUB]: { _id: STUB, dm_key: DM_KEY },
      [REAL]: { _id: REAL, dm_key: DM_KEY },
    };
    expect(findDmChannelId(rows, DM_KEY)).toBe(REAL);
  });

  it("falls back to the stub when no real row has arrived", () => {
    const rows = { [STUB]: { _id: STUB, dm_key: DM_KEY } };
    expect(findDmChannelId(rows, DM_KEY)).toBe(STUB);
  });

  it("finds nothing for an unknown key", () => {
    expect(findDmChannelId({ [REAL]: { _id: REAL, dm_key: DM_KEY } }, "other")).toBeNull();
  });
});

describe("resolveChannelStubId", () => {
  const DM_KEY = "team1:usera:userb";
  const REAL = serverId("dmreal");
  const STUB = `${CHAT_CHANNEL_STUB_PREFIX}abc123`;

  it("resolves through the create echo (client_id)", () => {
    const rows = {
      [STUB]: { client_id: STUB },
      [REAL]: { client_id: STUB },
    };
    expect(resolveChannelStubId(rows, STUB)).toBe(REAL);
  });

  it("resolves through a matching dm_key when the DM already existed", () => {
    const rows = {
      [STUB]: { client_id: STUB, dm_key: DM_KEY },
      [REAL]: { client_id: "someone-elses-create", dm_key: DM_KEY },
    };
    expect(resolveChannelStubId(rows, STUB)).toBe(REAL);
  });

  it("never answers with another stub", () => {
    const OTHER_STUB = `${CHAT_CHANNEL_STUB_PREFIX}zzz999`;
    const rows = {
      [STUB]: { client_id: STUB, dm_key: DM_KEY },
      [OTHER_STUB]: { client_id: OTHER_STUB, dm_key: DM_KEY },
    };
    expect(resolveChannelStubId(rows, STUB)).toBeNull();
  });

  it("passes an unresolved stub back as null", () => {
    expect(resolveChannelStubId({ [STUB]: { client_id: STUB } }, STUB)).toBeNull();
  });
});
