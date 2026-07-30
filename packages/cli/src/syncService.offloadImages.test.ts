import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncService } from "./syncService.js";

function makeService(): SyncService {
  return new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBase64(size: number): string {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(Math.max(0, size - PNG_SIGNATURE.length))]).toString("base64");
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

    const small = pngBase64(1000);
    const huge = pngBase64(600_000); // > MAX_INLINE_IMAGE_SIZE
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

  it("reads Codex local image paths as bytes and reuses the uploaded object", async () => {
    const sync = makeService();
    const dir = await mkdtemp(join(tmpdir(), "codecast-image-"));
    const imagePath = join(dir, "capture.png");
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("image-body")]);
    await writeFile(imagePath, bytes);
    const uploads: Array<{ data: string; mediaType: string }> = [];
    (sync as any).uploadImage = async (data: string, mediaType: string) => {
      uploads.push({ data, mediaType });
      return "sid-local";
    };

    try {
      const first = [{ images: [{ mediaType: "image/png", localPath: imagePath }] }];
      const second = [{ images: [{ mediaType: "image/png", localPath: imagePath }] }];
      await sync.offloadImages(first);
      await sync.offloadImages(second);

      expect(uploads).toEqual([{ data: bytes.toString("base64"), mediaType: "image/png" }]);
      expect(first[0].images).toEqual([{ mediaType: "image/png", storageId: "sid-local" }] as any);
      expect(second[0].images).toEqual([{ mediaType: "image/png", storageId: "sid-local" }] as any);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("drops an invalid local image instead of uploading its path or bytes", async () => {
    const sync = makeService();
    const dir = await mkdtemp(join(tmpdir(), "codecast-image-"));
    const imagePath = join(dir, "not-an-image.png");
    await writeFile(imagePath, imagePath);
    let uploads = 0;
    (sync as any).uploadImage = async () => {
      uploads++;
      return "should-not-upload";
    };

    try {
      const messages = [{ images: [{ mediaType: "image/png", localPath: imagePath }] }];
      await sync.offloadImages(messages);
      expect(uploads).toBe(0);
      expect(messages[0].images).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
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
    const messages: Array<{
      images?: Array<{ mediaType: string; data?: string; storageId?: string; toolUseId?: string }>;
    }> = Array.from({ length: 12 }, (_, i) => ({
      images: [{ mediaType: "image/png", data: String(i) }],
    }));
    await sync.offloadImages(messages);

    expect(maxActive).toBeGreaterThan(1);
    // Bounded by the configured concurrency (6).
    expect(maxActive).toBeLessThanOrEqual(6);
    expect(messages[11].images?.[0].storageId).toBe("sid-11");
  });
});
