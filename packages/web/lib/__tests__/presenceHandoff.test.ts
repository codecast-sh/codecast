import { describe, expect, test } from "bun:test";
import { confirmPageUrl, confirmPresenceViaWeb, type OpenedChallenge, type PresenceHandoffDeps } from "../presenceHandoff";

type Status = "pending" | "granted" | "used" | "expired";

/**
 * A browser and a backend in memory: `open` records the page, and the test
 * plays the person on it (`settle` pushes the challenge's new status the way
 * the /confirm page's finish would; `closePage` is the person closing it).
 */
function rig(opts: { begins: OpenedChallenge[]; enroll?: OpenedChallenge; android?: boolean }) {
  const statuses = new Map<string, Status>();
  const watchers = new Map<string, (s: Status | null) => void>();
  const pages: string[] = [];
  let closePage: (() => void) | null = null;
  let closedByUs = 0;
  const begins = [...opts.begins];
  const deps: PresenceHandoffDeps = {
    webBase: "https://codecast.sh/",
    begin: async () => begins.shift()!,
    enroll: async () => opts.enroll ?? { error: "no enrollment in this rig" },
    open: (url) => {
      pages.push(url);
      statuses.set(new URL(url).searchParams.get("c")!, "pending");
      if (opts.android) return Promise.resolve("opened");
      return new Promise((resolve) => (closePage = () => resolve("closed")));
    },
    close: () => {
      closedByUs++;
      closePage?.();
    },
    watch: (id, onStatus) => {
      watchers.set(id, onStatus);
      return () => watchers.delete(id);
    },
    read: async (id) => statuses.get(id) ?? null,
    ttlMs: 20,
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    deps,
    pages,
    closed: () => closedByUs,
    tick,
    /** The challenge reaches `status`, and its watcher hears of it. */
    async settle(id: string, status: Status, push = true) {
      statuses.set(id, status);
      if (push) watchers.get(id)?.(status);
      await tick();
    },
    async closePage() {
      closePage?.();
      await tick();
    },
  };
}

describe("Touch ID handed to the web's confirm page", () => {
  test("the page is the web origin's /confirm with the challenge id", () => {
    expect(confirmPageUrl("https://codecast.sh/", "k1 7")).toBe("https://codecast.sh/confirm?c=k1%207");
  });

  test("granted on the page: the page closes and the action proceeds with the grant string the begin handed this client", async () => {
    const r = rig({ begins: [{ challenge_id: "c1", grant: "c1.g" }] });
    const result = confirmPresenceViaWeb("approve", "d1", r.deps);
    await r.tick();
    expect(r.pages).toEqual(["https://codecast.sh/confirm?c=c1"]);
    // The page's url carries the challenge id, never the grant string.
    expect(r.pages[0]).not.toContain(".g");
    await r.settle("c1", "granted");
    expect(await result).toBe("c1.g");
    expect(r.closed()).toBe(1);
  });

  test("closing the page without confirming refuses, and a grant that landed before its push still counts", async () => {
    const cancelled = rig({ begins: [{ challenge_id: "c1", grant: "c1.g" }] });
    const no = confirmPresenceViaWeb("approve", "d1", cancelled.deps);
    await cancelled.tick();
    await cancelled.closePage();
    expect(await no).toBeNull();

    const raced = rig({ begins: [{ challenge_id: "c2", grant: "c2.g" }] });
    const yes = confirmPresenceViaWeb("reveal", "s1", raced.deps);
    await raced.tick();
    await raced.settle("c2", "granted", false);
    await raced.closePage();
    expect(await yes).toBe("c2.g");
  });

  test("no passkey yet: enroll on the page first, then confirm on it", async () => {
    const r = rig({ begins: [{ error: "Set up Touch ID first", needs_passkey: true }, { challenge_id: "p1", grant: "p1.g" }], enroll: { challenge_id: "e1" } });
    const result = confirmPresenceViaWeb("approve", "d1", r.deps);
    await r.tick();
    expect(r.pages).toEqual(["https://codecast.sh/confirm?c=e1"]);
    await r.settle("e1", "used");
    await r.tick();
    expect(r.pages[1]).toBe("https://codecast.sh/confirm?c=p1");
    await r.settle("p1", "granted");
    expect(await result).toBe("p1.g");
  });

  test("an enrollment the person abandons stops there", async () => {
    const r = rig({ begins: [{ error: "Set up Touch ID first", needs_passkey: true }], enroll: { challenge_id: "e1" } });
    const result = confirmPresenceViaWeb("approve", "d1", r.deps);
    await r.tick();
    await r.closePage();
    expect(await result).toBeNull();
    expect(r.pages).toHaveLength(1);
  });

  test("a challenge the server will not open throws its words", async () => {
    const r = rig({ begins: [{ error: "Nothing to confirm: it was removed, or it is not yours" }] });
    await expect(confirmPresenceViaWeb("approve", "d1", r.deps)).rejects.toThrow("Nothing to confirm");
    expect(r.pages).toHaveLength(0);
  });

  test("a browser that cannot say when it closes (Android) settles at the challenge's expiry", async () => {
    const r = rig({ begins: [{ challenge_id: "c1", grant: "c1.g" }], android: true });
    const result = confirmPresenceViaWeb("approve", "d1", r.deps);
    await new Promise((res) => setTimeout(res, 40));
    expect(await result).toBeNull();
  });
});
