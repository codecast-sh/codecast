import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeIngestSyncDelta, provenSyncedPrefix, samePersistedFile, transcriptSignatureWatermark } from "./ingestClient.js";
import { withMirrorSynced, writeMirrorSynced } from "../cloudAgents/transcript.js";

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

// Every cloud agent mirror syncs through the whole-file delta pass. Its
// ledger must keep the signature watermark, or a restart proves nothing and
// re-sends every mirrored message (489 per Codex Cloud task, every restart,
// 2026-09-30). And a restart's re-announced mirror has an empty delta, so the
// pass keeps the session (hosted, titled) before it returns on one.
describe("a cloud agent mirror across a restart", () => {
  const daemon = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "daemon.ts"), "utf8");
  test("a delta pass commits its ledger in signatures, whatever its client", () => {
    expect(daemon).toMatch(/const unit = signatureState \? "signatures"/);
  });
  test("the pass keeps a known mirror's session before it returns on an empty delta", () => {
    const pass = daemon.slice(daemon.indexOf("async function processTranscriptDeltaSessionPass("));
    const keep = pass.indexOf("const hostedHere = keptConversation ? await cloudAgents.keepSession(");
    // Nothing new, or another live device hosts the mirror and syncs it: return.
    const emptyReturn = pass.indexOf("if ((newMessages.length === 0 && orphanUuids.length === 0) || !hostedHere)");
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(emptyReturn);
    // A conversation this pass created is kept once, after it exists; a known one is not kept twice.
    expect(pass).toContain("if (mirror && conversationId !== keptConversation) await cloudAgents.keepSession(");
  });

  // A best-of-3 Codex Cloud task's main session kept 214 rows of another
  // attempt (jx7d2sy, 2026-10-02): its mirror was re-rendered to one attempt
  // as the daemon started, when nothing remembered what had been synced.
  test("a mirror re-rendered across a restart retracts the rows it no longer holds, for the same conversation only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-synced-"));
    try {
      const file = path.join(dir, "task_e_1.jsonl");
      writeMirrorSynced(file, "conv-1", ["t:user", "t:attempt1", "t:attempt3"]);
      const now = [{ uuid: "t:user" }, { uuid: "t:attempt1" }, { uuid: "t:note" }];
      const s = now.map((m) => sig(m.uuid));
      // The ledger proves nothing for a rewritten file: the saved set alone.
      const synced = withMirrorSynced(null, file, "conv-1")!;
      const { newMessages, orphanUuids } = await computeIngestSyncDelta(now, s, synced);
      expect(orphanUuids).toEqual(["t:attempt3"]);
      expect(newMessages.map((m) => m.uuid)).toEqual(["t:user", "t:attempt1", "t:note"]);
      // What the ledger proved stays as proved; the saved rows add only what it lacks.
      const proved = new Map([["t:user", s[0]]]);
      expect(await computeIngestSyncDelta(now, s, withMirrorSynced(proved, file, "conv-1")!)).toMatchObject({ orphanUuids: ["t:attempt3"], newMessages: [{ uuid: "t:attempt1" }, { uuid: "t:note" }] });
      // A recreated conversation never has rows of the old one retracted.
      expect(withMirrorSynced(null, file, "conv-2")).toBeNull();
      expect(fs.statSync(path.join(dir, "synced.json")).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pass seeds a mirror's synced set from what it saved, and saves it after each commit", () => {
    const pass = daemon.slice(daemon.indexOf("async function processTranscriptDeltaSessionPass("));
    expect(pass).toContain("(mirror ? withMirrorSynced(restored ?? null, filePath, conversationCache[sessionId]) : restored)");
    expect(pass).toContain("writeMirrorSynced(filePath, conversationId, finalSynced.keys())");
  });
});
