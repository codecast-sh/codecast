import { describe, expect, test } from "bun:test";
import { DAEMON_LAST_SEEN_THROTTLE_MS, touchDaemonLastSeen } from "./daemonLiveness";

function fakeDb(user: any) {
  const patches: any[] = [];
  return {
    patches,
    db: {
      get: async () => user,
      patch: async (_id: any, p: any) => { patches.push(p); Object.assign(user, p); },
    },
  };
}

describe("touchDaemonLastSeen", () => {
  test("a burst of daemon calls writes the users row once per window", async () => {
    const { db, patches } = fakeDb({ daemon_last_seen: undefined });
    for (let i = 0; i < 20; i++) await touchDaemonLastSeen({ db }, "u1" as any);
    expect(patches.length).toBe(1);
  });

  test("a stale stamp is refreshed; a passed-in fresh doc is not re-read or written", async () => {
    const stale = fakeDb({ daemon_last_seen: Date.now() - DAEMON_LAST_SEEN_THROTTLE_MS - 1 });
    await touchDaemonLastSeen({ db: stale.db }, "u1" as any);
    expect(stale.patches.length).toBe(1);
    const fresh = fakeDb({});
    await touchDaemonLastSeen({ db: fresh.db }, "u1" as any, { daemon_last_seen: Date.now() });
    expect(fresh.patches.length).toBe(0);
  });
});
