import { describe, it, expect } from "bun:test";
import { SyncService } from "./syncService.js";

function makeService(put: (bytes: Uint8Array, mediaType: string) => Promise<string | null>) {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  const calls: string[] = [];
  (sync as any).putBytes = async (bytes: Uint8Array, mediaType: string) => {
    calls.push(mediaType);
    return put(bytes, mediaType);
  };
  return { sync, calls };
}

const png = (fill: number) => new Uint8Array(64).fill(fill);

describe("SyncService.uploadBytes content dedup", () => {
  it("uploads the same bytes once and returns the same storage id", async () => {
    let n = 0;
    const { sync, calls } = makeService(async () => `sid-${++n}`);
    expect(await sync.uploadBytes(png(1), "image/png")).toBe("sid-1");
    expect(await sync.uploadBytes(png(1), "image/png")).toBe("sid-1");
    expect(calls.length).toBe(1);
  });

  it("shares one in-flight upload between concurrent copies", async () => {
    let release!: (v: string) => void;
    const { sync, calls } = makeService(() => new Promise((r) => (release = r)));
    const both = Promise.all([sync.uploadBytes(png(2), "image/png"), sync.uploadBytes(png(2), "image/png")]);
    release("sid-shared");
    expect(await both).toEqual(["sid-shared", "sid-shared"]);
    expect(calls.length).toBe(1);
  });

  it("tries again after a failed upload", async () => {
    let fail = true;
    const { sync, calls } = makeService(async () => (fail ? null : "sid-ok"));
    expect(await sync.uploadBytes(png(3), "image/png")).toBeNull();
    fail = false;
    expect(await sync.uploadBytes(png(3), "image/png")).toBe("sid-ok");
    expect(calls.length).toBe(2);
  });

  it("keeps different content and different types apart", async () => {
    let n = 0;
    const { sync, calls } = makeService(async () => `sid-${++n}`);
    await sync.uploadBytes(png(4), "image/png");
    await sync.uploadBytes(png(5), "image/png");
    await sync.uploadBytes(png(4), "image/jpeg");
    expect(calls.length).toBe(3);
  });
});
