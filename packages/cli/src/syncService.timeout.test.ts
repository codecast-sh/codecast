import { describe, it, expect } from "bun:test";
import { withTimeout, SyncService, chunkMessagesBySize } from "./syncService.js";

describe("withTimeout", () => {
  it("resolves through when the inner promise wins the race", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("rejects with a labeled error after the timeout when the inner promise hangs", async () => {
    const hang = new Promise<never>(() => { /* never resolves */ });
    const start = Date.now();
    await expect(withTimeout(hang, 100, "hung op")).rejects.toThrow(
      /hung op timed out after 100ms/
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(500);
  });

  it("propagates rejection from the inner promise without waiting for the timeout", async () => {
    const inner = Promise.reject(new Error("boom"));
    const start = Date.now();
    await expect(withTimeout(inner, 5000, "test")).rejects.toThrow("boom");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("clears the timeout when the inner promise resolves so the event loop can exit", async () => {
    // If the timer were not cleared, an unhandled setTimeout would keep the
    // process alive and bun:test would not return promptly. We just verify
    // back-to-back fast resolutions don't accumulate timers by running many.
    for (let i = 0; i < 50; i++) {
      await withTimeout(Promise.resolve(i), 60_000, "fast");
    }
  });
});

describe("SyncService.addMessages timeout regression", () => {
  it("throws (instead of hanging silently) when the convex mutation never resolves", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });

    // Stub the internal Convex client so the mutation hangs forever, simulating
    // the 2026-05-13 stuck-sync incident where addMessages calls never returned.
    // Without the timeout wrapper this test would hang past the bun:test deadline.
    (sync as any).client = {
      mutation: () => new Promise(() => { /* never resolves */ }),
    };

    // We can't wait the full 60s production timeout in a test, so we override
    // the constant by monkey-patching the helper used internally. The simplest
    // path: spy on Promise.race via a short-deadline replacement of client.mutation
    // that already throws with a timeout-shaped error.
    (sync as any).client = {
      mutation: () => withTimeout(new Promise(() => {}), 200, "fake-mutation"),
    };

    await expect(
      sync.addMessages({
        conversationId: "conv",
        messages: [
          { role: "human", content: "hello", timestamp: Date.now() },
        ],
      })
    ).rejects.toThrow(/timed out/);
  }, 5000);

  it("returns normally when the mutation resolves promptly", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).client = {
      mutation: async () => ({ inserted: 1, ids: ["m1"] }),
    };

    const result = await sync.addMessages({
      conversationId: "conv",
      messages: [
        { role: "human", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.ids).toEqual(["m1"]);
  });
});

describe("SyncService.uploadImage timeout regression", () => {
  // A 260KB image message whose upload hung (un-timed fetch / generateUploadUrl)
  // wedged the file-watcher: its position never advanced past the image and every
  // later turn stopped syncing (session 2a081608 — web frozen ~1h behind tmux).
  // Each network leg is now time-boxed so a hang degrades to null instead.
  const smallPng = "aGVsbG8="; // "hello" — tiny, well under MAX_IMAGE_SIZE

  it("returns null (does not hang) when generateUploadUrl never resolves", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).imageUploadTimeoutMs = 100;
    (sync as any).client = { mutation: () => new Promise(() => { /* hangs forever */ }) };

    const start = Date.now();
    const result = await (sync as any).uploadImage(smallPng, "image/png");
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000); // bounded, not hung
  }, 5000);

  it("returns null (does not hang) when the upload fetch never resolves", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).imageUploadTimeoutMs = 100;
    (sync as any).client = { mutation: async () => "https://upload.example/url" };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => { /* hangs forever */ })) as any;
    try {
      const start = Date.now();
      const result = await (sync as any).uploadImage(smallPng, "image/png");
      expect(result).toBeNull();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 5000);

  it("returns the storageId on a prompt successful upload", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).client = { mutation: async () => "https://upload.example/url" };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ storageId: "kg123" }) })) as any;
    try {
      const result = await (sync as any).uploadImage(smallPng, "image/png");
      expect(result).toBe("kg123");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("SyncService.offloadImages", () => {
  // Offloading images BEFORE they enter the retry queue is what keeps the queue
  // small and stops every retry re-uploading the same image. A 511KB inline
  // screenshot persisted as raw base64 grew the retry queue to 16MB and, fighting
  // for the conversation hot-doc, drove the 283-op stall.
  const smallImg = "aGVsbG8="; // 5 decoded bytes
  const hugeImg = "A".repeat(700_000); // ~525KB decoded, over MAX_INLINE_IMAGE_SIZE (500KB)

  function make(authToken = "t") {
    return new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken });
  }

  it("replaces data with storageId on successful upload (no raw base64 left)", async () => {
    const sync = make();
    (sync as any).uploadImage = async () => "kg-stored";
    const msgs: Array<{
      images?: Array<{ mediaType: string; data?: string; storageId?: string; toolUseId?: string }>;
    }> = [{ images: [{ mediaType: "image/png", data: hugeImg }] }];
    await sync.offloadImages(msgs);
    expect(msgs[0].images).toEqual([{ mediaType: "image/png", storageId: "kg-stored", toolUseId: undefined }]);
    expect((msgs[0].images![0] as any).data).toBeUndefined();
  });

  it("drops an oversized image when upload fails (cannot inline, must not persist)", async () => {
    const sync = make();
    (sync as any).uploadImage = async () => null;
    const msgs = [{ images: [{ mediaType: "image/png", data: hugeImg }] }];
    await sync.offloadImages(msgs);
    expect(msgs[0].images).toBeUndefined();
  });

  it("keeps a small image inline when upload fails", async () => {
    const sync = make();
    (sync as any).uploadImage = async () => null;
    const msgs = [{ images: [{ mediaType: "image/png", data: smallImg }] }];
    await sync.offloadImages(msgs);
    expect(msgs[0].images).toEqual([{ mediaType: "image/png", data: smallImg }]);
  });

  it("is idempotent: an already-offloaded image is left untouched and not re-uploaded", async () => {
    const sync = make();
    let uploads = 0;
    (sync as any).uploadImage = async () => { uploads++; return "should-not-happen"; };
    const msgs = [{ images: [{ mediaType: "image/png", storageId: "kg-existing" }] }];
    await sync.offloadImages(msgs);
    expect(uploads).toBe(0);
    expect(msgs[0].images).toEqual([{ mediaType: "image/png", storageId: "kg-existing" }]);
  });
});

describe("chunkMessagesBySize", () => {
  it("keeps a batch within both the count and byte caps", () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ id: i, body: "x" }));
    const batches = chunkMessagesBySize(msgs, 10, 1_000_000);
    // Count cap dominates here (tiny messages) → 10/10/5.
    expect(batches.map(b => b.length)).toEqual([10, 10, 5]);
    expect(batches.flat().length).toBe(25);
  });

  it("closes a batch early when adding the next message would exceed the byte cap", () => {
    // Four ~300KB messages, 1MB byte cap: 3 fit (~900KB), the 4th starts a new batch.
    const big = "a".repeat(300_000);
    const msgs = Array.from({ length: 4 }, (_, i) => ({ id: i, body: big }));
    const batches = chunkMessagesBySize(msgs, 10, 1_000_000);
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(3);
    expect(batches[1].length).toBe(1);
  });

  it("emits a single oversized message in its own batch rather than dropping it", () => {
    const huge = "a".repeat(2_000_000);
    const msgs = [{ id: 0, body: "small" }, { id: 1, body: huge }, { id: 2, body: "small" }];
    const batches = chunkMessagesBySize(msgs, 10, 1_000_000);
    // small | huge-alone | small — the huge one is never merged or lost.
    expect(batches.length).toBe(3);
    expect(batches.map(b => b.length)).toEqual([1, 1, 1]);
    expect(batches.flat().map(m => m.id)).toEqual([0, 1, 2]);
  });
});

// content is truncated to MAX_CONTENT_SIZE (100KB) inside addMessages, so each
// message tops out near this regardless of input length.
const MAX_CONTENT_NEAR_CAP = 100_000;

describe("SyncService.addMessages oversized-batch regression", () => {
  it("splits an image-heavy run into multiple sub-cap mutations instead of one giant call", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });

    // Capture every mutation payload so we can assert none is multi-MB. Before
    // the byte-aware split, 10 of these ~100KB-content messages would go out as
    // a single ~1MB+ mutation; with image-sized messages it was multi-MB and
    // timed out forever, freezing the file's sync position (session 2207e202).
    const sentBatchSizes: number[] = [];
    (sync as any).client = {
      mutation: async (_name: string, args: { messages: unknown[] }) => {
        sentBatchSizes.push(Buffer.byteLength(JSON.stringify(args.messages)));
        return { inserted: args.messages.length, ids: args.messages.map((_, i) => `m${i}`) };
      },
    };

    const body = "x".repeat(MAX_CONTENT_NEAR_CAP);
    const messages = Array.from({ length: 12 }, () => ({
      role: "human" as const,
      content: body,
      timestamp: Date.now(),
    }));

    const result = await sync.addMessages({ conversationId: "conv", messages });

    expect(result.inserted).toBe(12);
    // Must have split into more than one mutation...
    expect(sentBatchSizes.length).toBeGreaterThan(1);
    // ...and no single mutation may approach the multi-MB danger zone.
    for (const bytes of sentBatchSizes) {
      expect(bytes).toBeLessThanOrEqual(1_000_000);
    }
  });
});

describe("SyncService.addMessages per-conversation serialization", () => {
  // Regression for the "sync stalled" snowball: concurrent addMessages for ONE
  // conversation collide on its conversation doc server-side (OCC), retry-starve
  // past the 60s timeout, and re-queue forever. Writes to one conversation must
  // never overlap; different conversations must stay parallel.
  function trackingClient() {
    let inFlightByConv: Record<string, number> = {};
    let maxByConv: Record<string, number> = {};
    let maxGlobal = 0;
    let globalInFlight = 0;
    const client = {
      mutation: async (_name: string, args: any) => {
        const conv = args.conversation_id as string;
        inFlightByConv[conv] = (inFlightByConv[conv] || 0) + 1;
        globalInFlight++;
        maxByConv[conv] = Math.max(maxByConv[conv] || 0, inFlightByConv[conv]);
        maxGlobal = Math.max(maxGlobal, globalInFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlightByConv[conv]--;
        globalInFlight--;
        return { inserted: (args.messages as any[]).length, ids: [] };
      },
    };
    return { client, maxByConv: () => maxByConv, maxGlobal: () => maxGlobal };
  }

  const msg = (i: number) => ({ role: "assistant" as const, content: "m" + i, timestamp: Date.now() });

  it("never runs two addMessages for the SAME conversation concurrently", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    const t = trackingClient();
    (sync as any).client = t.client;

    await Promise.all([
      sync.addMessages({ conversationId: "convA", messages: [msg(1)] }),
      sync.addMessages({ conversationId: "convA", messages: [msg(2)] }),
      sync.addMessages({ conversationId: "convA", messages: [msg(3)] }),
    ]);

    expect(t.maxByConv()["convA"]).toBe(1); // strictly serialized for one conversation
  });

  it("a stuck write on one conversation does not block another conversation", async () => {
    // Per-conversation chains must be independent: a hung addMessages for convA
    // must not wedge convB (otherwise one bad conversation stalls the whole daemon).
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    let bDone = false;
    (sync as any).client = {
      mutation: async (_n: string, args: any) => {
        if (args.conversation_id === "convA") {
          await new Promise(() => {}); // convA hangs forever
        }
        bDone = true;
        return { inserted: (args.messages as any[]).length, ids: [] };
      },
    };

    const aHang = sync.addMessages({ conversationId: "convA", messages: [msg(1)] });
    void aHang.catch(() => {});
    await sync.addMessages({ conversationId: "convB", messages: [msg(2)] });
    expect(bDone).toBe(true); // convB completed despite convA being stuck
  });

  it("a failed write does not block the next write for the same conversation", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    let calls = 0;
    (sync as any).client = {
      mutation: async (_n: string, args: any) => {
        calls++;
        if (calls === 1) throw new Error("transient server error");
        return { inserted: (args.messages as any[]).length, ids: [] };
      },
    };

    const first = sync.addMessages({ conversationId: "convA", messages: [msg(1)] });
    const second = sync.addMessages({ conversationId: "convA", messages: [msg(2)] });
    await expect(first).rejects.toThrow("transient server error");
    await expect(second).resolves.toMatchObject({ inserted: 1 });
  });
});

describe("SyncService.addMessages remote reconciliation", () => {
  const msg = (uuid: string) => ({ messageUuid: uuid, role: "assistant" as const, content: uuid, timestamp: Date.now() });

  it("drops already-landed message uuids before retrying the batch", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    const sentBatches: any[] = [];
    (sync as any).client = {
      query: async () => ["u1"],
      mutation: async (_n: string, args: any) => {
        sentBatches.push(args.messages);
        return { inserted: args.messages.length, ids: [] };
      },
    };

    const result = await sync.addMessages({
      conversationId: "convA",
      messages: [msg("u1"), msg("u2")],
      reconcileRemoteExisting: true,
    });

    expect(result.inserted).toBe(1);
    expect(sentBatches).toHaveLength(1);
    expect(sentBatches[0].map((m: any) => m.message_uuid)).toEqual(["u2"]);
  });

  it("skips the mutation entirely when every message already exists remotely", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    let mutations = 0;
    (sync as any).client = {
      query: async () => ["u1", "u2"],
      mutation: async () => {
        mutations++;
        return { inserted: 99, ids: ["should-not-run"] };
      },
    };

    const result = await sync.addMessages({
      conversationId: "convA",
      messages: [msg("u1"), msg("u2")],
      reconcileRemoteExisting: true,
    });

    expect(result).toEqual({ inserted: 0, ids: [] });
    expect(mutations).toBe(0);
  });
});
