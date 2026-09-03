import { describe, expect, test } from "bun:test";
import {
  DAEMON_FRESH_MS,
  INPUT_ACTIVE_MS,
  PRESENCE_BUCKET_MS,
  PRESENCE_FRESH_MS,
  PRESENCE_IDLE_MAX_MS,
  bucketTs,
  derivePresenceState,
  type PresenceStateInput,
} from "./presenceState";

const NOW = 1_800_000_000_000;

function at(agoMs: number): number {
  return NOW - agoMs;
}

function state(input: PresenceStateInput) {
  return derivePresenceState(input, NOW);
}

describe("derivePresenceState", () => {
  test("no signals at all is offline", () => {
    expect(state({})).toBe("offline");
    expect(state({ presence: null, devices: [] })).toBe("offline");
  });

  test("fresh surface with recent input is active", () => {
    expect(
      state({ presence: { last_seen: at(10_000), last_input_at: at(30_000) } }),
    ).toBe("active");
  });

  test("active/idle boundary sits exactly at INPUT_ACTIVE_MS", () => {
    const presence = (inputAgo: number) => ({
      presence: { last_seen: at(5_000), last_input_at: at(inputAgo) },
    });
    expect(state(presence(INPUT_ACTIVE_MS - 1))).toBe("active");
    expect(state(presence(INPUT_ACTIVE_MS))).toBe("idle");
  });

  test("idle/away boundary sits exactly at PRESENCE_IDLE_MAX_MS", () => {
    const presence = (inputAgo: number) => ({
      presence: { last_seen: at(5_000), last_input_at: at(inputAgo) },
    });
    expect(state(presence(PRESENCE_IDLE_MAX_MS - 1))).toBe("idle");
    expect(state(presence(PRESENCE_IDLE_MAX_MS))).toBe("away");
  });

  test("a stale surface contributes nothing", () => {
    expect(
      state({
        presence: {
          last_seen: at(PRESENCE_FRESH_MS + 1),
          // Recent input on a dead surface is a contradiction (the heartbeat
          // is what carries input) — the stale row must win.
          last_input_at: at(1_000),
        },
      }),
    ).toBe("offline");
  });

  test("machine input keeps a user active while the app sits idle", () => {
    expect(
      state({
        presence: {
          last_seen: at(10_000),
          last_input_at: at(PRESENCE_IDLE_MAX_MS + 60_000),
        },
        devices: [{ last_seen: at(15_000), last_input_at: at(20_000) }],
      }),
    ).toBe("active");
  });

  test("machine_wide opt-out ignores devices entirely", () => {
    expect(
      state({
        machineWide: false,
        devices: [{ last_seen: at(15_000), last_input_at: at(20_000) }],
      }),
    ).toBe("offline");
  });

  test("remote and input-less devices never count", () => {
    expect(
      state({
        devices: [
          { last_seen: at(5_000), last_input_at: at(5_000), is_remote: true },
          { last_seen: at(5_000) },
        ],
      }),
    ).toBe("offline");
  });

  test("device alive with old input reads idle then away", () => {
    const dev = (inputAgo: number) => ({
      devices: [{ last_seen: at(10_000), last_input_at: at(inputAgo) }],
    });
    expect(state(dev(INPUT_ACTIVE_MS + 1_000))).toBe("idle");
    expect(state(dev(PRESENCE_IDLE_MAX_MS + 1_000))).toBe("away");
  });

  test("daemon-only liveness is away, and stale daemon is offline", () => {
    expect(state({ daemonLastSeen: at(DAEMON_FRESH_MS - 1_000) })).toBe("away");
    expect(state({ daemonLastSeen: at(DAEMON_FRESH_MS + 1_000) })).toBe("offline");
  });

  test("an alive surface outranks the daemon fallback", () => {
    // Surface alive but input ancient: away via the input path, not offline.
    expect(
      state({
        presence: {
          last_seen: at(10_000),
          last_input_at: at(PRESENCE_IDLE_MAX_MS * 10),
        },
        daemonLastSeen: at(DAEMON_FRESH_MS * 10),
      }),
    ).toBe("away");
  });

  test("future input timestamps clamp to active, not explode", () => {
    expect(
      state({ presence: { last_seen: at(1_000), last_input_at: NOW + 60_000 } }),
    ).toBe("active");
  });
});

test("the browser-safe presence graph excludes Convex registrations", async () => {
  const stateSource = await Bun.file(`${import.meta.dir}/presenceState.ts`).text();
  const policySource = await Bun.file(`${import.meta.dir}/presencePolicy.ts`).text();
  expect(stateSource).not.toContain('from "./pushRouter"');
  expect(policySource).not.toMatch(/\.\/functions|_generated\/server|convex\/server/);
});

describe("bucketTs", () => {
  test("floors into stable buckets", () => {
    const base = Math.floor(NOW / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS;
    expect(bucketTs(base)).toBe(base);
    expect(bucketTs(base + 1)).toBe(base);
    expect(bucketTs(base + PRESENCE_BUCKET_MS - 1)).toBe(base);
    expect(bucketTs(base + PRESENCE_BUCKET_MS)).toBe(base + PRESENCE_BUCKET_MS);
  });

  test("passes undefined through", () => {
    expect(bucketTs(undefined)).toBeUndefined();
  });
});
