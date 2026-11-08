import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncService } from "./syncService.js";
import { serializeTranscript } from "./workers/ingestClient.js";

// 2026-11-05: a Claude session sent a file from ~/Desktop with SendUserFile.
// The daemon's read of it did not return for 2h56m (macOS holds such a read
// while a privacy prompt waits), and the sync pass waiting on it held the
// transcript's lock, so every later pass failed with "ingest transaction
// deadline" and 49 messages sat unsynced. A local read must never outlive its
// own short bound, and a stuck path must not be read again while it is stuck.

function makeService(): SyncService {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  (sync as any).localFileIoTimeoutMs = 150;
  return sync;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("local file reads inside a transcript pass", () => {
  it("a sent file whose read never returns leaves the pass and its lock free", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuck-read-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "littlebird-agent-icon.png");
    await writeFile(path, "png bytes");

    const realReadFile = fsPromises.readFile;
    let reads = 0;
    const spy = spyOn(fsPromises, "readFile").mockImplementation(((p: any, ...rest: any[]) => {
      if (p === path) { reads++; return new Promise(() => {}); }
      return (realReadFile as any)(p, ...rest);
    }) as any);
    cleanups.push(() => spy.mockRestore());

    const sync = makeService();
    let uploads = 0;
    (sync as any).uploadBytes = async () => { uploads++; return "sid"; };
    const pass = (toolUseId: string) => serializeTranscript("ingest-session:stuck-read", async () => {
      const messages = [{ files: [{ localPath: path, name: "littlebird-agent-icon.png", toolUseId }] }];
      await sync.offloadFiles(messages);
      return messages[0].files[0];
    }, { timeoutMs: 2_000 });

    const first = await pass("t1");
    expect(first).toMatchObject({ name: "littlebird-agent-icon.png", error: "unreadable" });
    expect(first).not.toHaveProperty("storageId");

    // The next pass gets the lock at once and does not queue a second read
    // behind the first one, which still has not returned.
    const started = Date.now();
    const second = await pass("t2");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(second).toMatchObject({ error: "unreadable" });
    expect(reads).toBe(1);
    expect(uploads).toBe(0);
  });

  it("a linked screenshot whose open blocks in the kernel does not hold the message", async () => {
    // A FIFO with no writer blocks open() the way a held privacy check does.
    const dir = await mkdtemp(join(tmpdir(), "stuck-open-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fifo = join(dir, "shot.png");
    execFileSync("mkfifo", [fifo]);
    // Open the write side last so the blocked reader returns and its pool thread is freed.
    cleanups.push(async () => { const writer = await open(fifo, "w"); await writer.close(); });

    const sync = makeService();
    const content = `Here it is: ![shot](${fifo})`;
    const messages = [{ role: "assistant", content }];
    const started = Date.now();
    await sync.rescueLocalImageLinks(messages);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(messages[0].content).toBe(content);
  });
});
