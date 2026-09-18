import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeIngestSyncDelta, provenSyncedPrefix, samePersistedFile, transcriptSignatureWatermark } from "./ingestClient.js";

const sig = (text: string) => createHash("sha256").update(text).digest("hex");
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `m${i}` }));

// What a daemon persisted after syncing the given messages: the watermark of
// the synced set, built in file order exactly as computeIngestSyncDelta does.
async function persisted(messages: { uuid?: string }[], signatures: string[]): Promise<string[]> {
  const { nextSynced } = await computeIngestSyncDelta(messages, signatures, new Map());
  return [await transcriptSignatureWatermark(nextSynced), await transcriptSignatureWatermark(nextSynced, 1)];
}

describe("restoring a signature-synced transcript after a daemon restart", () => {
  test("an unchanged file is proven fully synced, so nothing is re-sent", async () => {
    const m = msgs(400), s = m.map((x) => sig(x.uuid!));
    const seeded = await provenSyncedPrefix(m, s, await persisted(m, s));
    expect(seeded?.size).toBe(400);
    expect((await computeIngestSyncDelta(m, s, seeded!)).newMessages).toHaveLength(0);
  });

  test("a grown file re-sends only the appended tail", async () => {
    const m = msgs(10), s = m.map((x) => sig(x.uuid!));
    const watermark = await persisted(m.slice(0, 7), s.slice(0, 7));
    const seeded = await provenSyncedPrefix(m, s, watermark);
    const { newMessages, orphanUuids } = await computeIngestSyncDelta(m, s, seeded!);
    expect(newMessages.map((x) => x.uuid)).toEqual(["m7", "m8", "m9"]);
    expect(orphanUuids).toEqual([]);
  });

  test("a grok message that kept streaming under its uuid is re-sent, and only it", async () => {
    const m = msgs(5), before = m.map((x) => sig(`${x.uuid}:partial`));
    const watermark = await persisted(m, before);
    const after = [...before.slice(0, 4), sig("m4:complete")];
    const seeded = await provenSyncedPrefix(m, after, watermark);
    expect(seeded?.size).toBe(4);
    expect((await computeIngestSyncDelta(m, after, seeded!)).newMessages.map((x) => x.uuid)).toEqual(["m4"]);
  });

  test("messages without a uuid never enter the proof and are always offered", async () => {
    const m = [{ uuid: "a" }, {}, { uuid: "b" }], s = [sig("a"), sig("x"), sig("b")];
    const seeded = await provenSyncedPrefix(m, s, await persisted(m, s));
    expect([...seeded!.keys()]).toEqual(["a", "b"]);
    expect((await computeIngestSyncDelta(m, s, seeded!)).newMessages).toEqual([{}]);
  });

  test("a rewritten history proves nothing, so the caller falls back to a full re-sync", async () => {
    const m = msgs(6), s = m.map((x) => sig(x.uuid!));
    const watermark = await persisted(m, s);
    expect(await provenSyncedPrefix(m, [sig("other"), ...s.slice(1)], watermark)).toBeNull();
    expect(await provenSyncedPrefix(m.slice(0, 3), s.slice(0, 2), watermark)).toBeNull();
  });

  test("the moved watermark hashes exactly as before, so ledgers written by older daemons still match", async () => {
    // Reference: the implementation daemon.ts carried until 2026-09-17.
    const ref = createHash("sha256");
    const synced = new Map([["u1", sig("one")], ["u2", sig("two")]]);
    for (const [uuid, signature] of synced) for (const v of [uuid, signature]) ref.update(String(v.length)).update(":").update(v);
    expect(await transcriptSignatureWatermark(synced)).toBe(ref.digest("hex"));
  });
});

describe("a reboot does not make every transcript look replaced", () => {
  test("a renumbered volume is the same file; a new inode or birth time is not", () => {
    const recorded = { dev: 16777233, ino: 208040603, birthtimeMs: 1789600000000 };
    const afterReboot = { ...recorded, dev: 16777232 };
    expect(samePersistedFile(recorded, afterReboot)).toBe(true);
    expect(samePersistedFile(recorded, { ...recorded, ino: 208040604 })).toBe(false);
    expect(samePersistedFile(recorded, { ...recorded, birthtimeMs: 1789600000001 })).toBe(false);
  });

  // Every comparison against a ledger identity (written in an earlier boot)
  // must go through samePersistedFile. A raw dev comparison there replays the
  // transcript from its first byte after every reboot.
  test("the daemon compares ledger identities only through samePersistedFile", () => {
    const daemon = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "daemon.ts"), "utf8");
    expect(daemon).not.toMatch(/(previous|saved|g)\.dev\s*[!=]==/);
    expect(daemon.match(/samePersistedFile\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
