// Regression: agents linked screenshots by local temp path
// ("[overview](/var/folders/…/shot.jpg)") — dead links in the web UI. The
// rescue pass uploads the file and rewrites the link to a storage URL before
// the message syncs, dedups through the persistent image cache, and keeps a
// stable URL even after the temp file is deleted.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncService } from "./syncService.js";

function makeService(): SyncService {
  return new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let priorCodecastDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rescue-links-"));
  // Point the persistent image cache away from the real ~/.codecast.
  priorCodecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});

afterEach(async () => {
  if (priorCodecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorCodecastDir;
  await rm(dir, { recursive: true, force: true });
});

describe("SyncService.rescueLocalImageLinks", () => {
  it("rewrites image and plain links to a local raster file with its storage URL", async () => {
    const sync = makeService();
    let uploads = 0;
    (sync as any).uploadImage = async () => { uploads++; return "sid-1"; };
    (sync as any).getImageUrl = async () => "https://convex.test/api/storage/u1";

    const img = join(dir, "shot.png");
    await writeFile(img, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64)]));

    const messages = [{
      role: "assistant",
      content: `Screenshots: ![overview](${img}) and [full view](${img})`,
    }];
    await sync.rescueLocalImageLinks(messages);

    expect(messages[0].content).toBe(
      "Screenshots: ![overview](https://convex.test/api/storage/u1) and [full view](https://convex.test/api/storage/u1)",
    );
    expect(uploads).toBe(1); // same file linked twice → one upload
  });

  it("dedups through the persistent cache across service instances and survives file deletion", async () => {
    const img = join(dir, "temp-shot.png");
    await writeFile(img, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(128)]));

    const first = makeService();
    (first as any).uploadImage = async () => "sid-2";
    (first as any).getImageUrl = async () => "https://convex.test/api/storage/u2";
    const firstPass = [{ role: "assistant", content: `![a](${img})` }];
    await first.rescueLocalImageLinks(firstPass);
    expect(firstPass[0].content).toContain("/api/storage/u2");

    // New daemon run, same file: cache hit, no upload.
    const second = makeService();
    let uploads = 0;
    (second as any).uploadImage = async () => { uploads++; return "sid-3"; };
    (second as any).getImageUrl = async () => "https://convex.test/api/storage/u3";
    const secondPass = [{ role: "assistant", content: `![b](${img})` }];
    await second.rescueLocalImageLinks(secondPass);
    expect(secondPass[0].content).toContain("/api/storage/u2");
    expect(uploads).toBe(0);

    // Temp file cleaned up: the path's last-known URL still resolves.
    await rm(img);
    const thirdPass = [{ role: "assistant", content: `![c](${img})` }];
    await second.rescueLocalImageLinks(thirdPass);
    expect(thirdPass[0].content).toContain("/api/storage/u2");
  });

  it("leaves user messages, non-image files, and unreadable paths untouched", async () => {
    const sync = makeService();
    (sync as any).uploadImage = async () => "sid-x";
    (sync as any).getImageUrl = async () => "https://convex.test/api/storage/ux";

    const img = join(dir, "real.png");
    await writeFile(img, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(16)]));
    const fake = join(dir, "not-an-image.png");
    await writeFile(fake, "just text");

    const userContent = `[Image ${img}] and ![x](${img})`;
    const messages = [
      { role: "human", content: userContent },
      { role: "assistant", content: `![fake](${fake}) ![gone](${join(dir, "missing.png")})` },
    ];
    await sync.rescueLocalImageLinks(messages);

    expect(messages[0].content).toBe(userContent); // user text is echo-matched — never rewritten
    expect(messages[1].content).toContain(fake); // sniff failed → left as authored
    expect(messages[1].content).toContain("missing.png"); // unreadable, no cache → left alone
  });
});
