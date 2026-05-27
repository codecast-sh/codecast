import { describe, it, expect } from "bun:test";
import { SyncService } from "./syncService.js";

function makeService(): SyncService {
  return new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
}

describe("SyncService.offloadImages", () => {
  it("replaces uploadable images with their storageId, preserving order", async () => {
    const sync = makeService();
    (sync as any).uploadImage = async (data: string) => `sid-${data}`;

    const messages = [
      { images: [{ mediaType: "image/png", data: "A" }, { mediaType: "image/png", data: "B" }] },
      { images: [{ mediaType: "image/png", data: "C", toolUseId: "t1" }] },
    ];
    await sync.offloadImages(messages);

    expect(messages[0].images).toEqual([
      { mediaType: "image/png", storageId: "sid-A" },
      { mediaType: "image/png", storageId: "sid-B" },
    ] as any);
    expect(messages[1].images).toEqual([
      { mediaType: "image/png", storageId: "sid-C", toolUseId: "t1" },
    ] as any);
  });

  it("leaves already-offloaded images untouched (idempotent)", async () => {
    const sync = makeService();
    let calls = 0;
    (sync as any).uploadImage = async () => { calls++; return "sid"; };

    const messages = [{ images: [{ mediaType: "image/png", storageId: "existing" }] }];
    await sync.offloadImages(messages);

    expect(calls).toBe(0);
    expect(messages[0].images).toEqual([{ mediaType: "image/png", storageId: "existing" }] as any);
  });

  it("inlines small images whose upload failed and drops oversized ones", async () => {
    const sync = makeService();
    (sync as any).uploadImage = async () => null; // upload always fails

    const small = Buffer.alloc(1000).toString("base64");
    const huge = Buffer.alloc(600_000).toString("base64"); // > MAX_INLINE_IMAGE_SIZE
    const messages = [
      { images: [{ mediaType: "image/png", data: small }] },
      { images: [{ mediaType: "image/png", data: huge }] },
    ];
    await sync.offloadImages(messages);

    // Small one kept inline…
    expect(messages[0].images?.length).toBe(1);
    expect(messages[0].images?.[0].data).toBe(small);
    // …oversized one dropped → images cleared to undefined.
    expect(messages[1].images).toBeUndefined();
  });

  it("uploads concurrently rather than serially", async () => {
    const sync = makeService();
    let active = 0;
    let maxActive = 0;
    (sync as any).uploadImage = async (data: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return `sid-${data}`;
    };

    // 12 images across messages; serial would peak at maxActive=1.
    const messages = Array.from({ length: 12 }, (_, i) => ({
      images: [{ mediaType: "image/png", data: String(i) }],
    }));
    await sync.offloadImages(messages);

    expect(maxActive).toBeGreaterThan(1);
    // Bounded by the configured concurrency (6).
    expect(maxActive).toBeLessThanOrEqual(6);
    expect(messages[11].images?.[0].storageId).toBe("sid-11");
  });
});
