// pi branch-switch delta sync (ct-39160) + grok streaming growth. The daemon
// re-parses the whole pi/grok JSONL each pass and the parser resolves only the
// ACTIVE branch (pi's id/parentId tree; grok's rewind filter). A /tree branch
// switch makes the active branch diverge (or shrink) while the file grows, so
// the old count-based guard (allMessages.length <= previousCount) either
// silently dropped the new branch's turns or spliced branch A's prefix onto
// branch B's tail. computePiSyncDelta replaces it with a per-message-signature
// diff: new turns are active messages not yet synced OR whose payload changed
// under a stable uuid (grok streams chunks into a coalesced message, so a
// mid-turn sync must not freeze it at its first prefix), orphans are synced
// uuids no longer on the branch. These tests drive that seam against the
// parsers' real semantics.
import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parsePiSessionFile, parseGrokSessionFile, type ParsedMessage } from "./parser.js";
import { computePiSyncDelta, messageSyncSig } from "./daemon.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "pi", name), "utf8");

const sigsOf = (msgs: ParsedMessage[]): Map<string, string> =>
  new Map(msgs.map((m) => [m.uuid!, messageSyncSig(m)]));

// Model the synced conversation as a uuid -> content map and apply one sync pass the
// way the daemon does: upsert the new turns (addMessages patches/inserts by uuid),
// then delete the orphans (deleteMessagesByUuid). Returns the advanced synced map.
function applyPass(
  conversation: Map<string, string>,
  active: ParsedMessage[],
  synced: Map<string, string>,
): Map<string, string> {
  const { newMessages, orphanUuids, nextSynced } = computePiSyncDelta(active, synced);
  for (const m of newMessages) conversation.set(m.uuid!, m.content);
  for (const uuid of orphanUuids) conversation.delete(uuid);
  return nextSynced;
}

// Reconstruct the conversation's content in the active branch's order — this is what
// the web renders (messages ordered along the active branch). Asserting it equals
// the active branch exactly proves there is no splice and no orphan left behind.
function renderedInBranchOrder(conversation: Map<string, string>, active: ParsedMessage[]): string[] {
  return active.map((m) => conversation.get(m.uuid!)!).filter((c) => c !== undefined);
}

const mk = (uuid: string, content: string): ParsedMessage => ({
  uuid,
  role: "user",
  content,
  timestamp: 0,
});

describe("computePiSyncDelta — same-length divergent /tree branch (branch.jsonl)", () => {
  // branch.jsonl's leaf is the ACTIVE branch (a2b00003). Slicing to the abandoned
  // leaf (a2a00003) reconstructs the file's earlier state, before the /tree switch.
  const lines = fixture("branch.jsonl").split("\n").filter((l) => l.trim());
  const branchAContent = lines.slice(0, 6).join("\n"); // session, model_change, u1, a1, u2a, a2a
  const branchA = parsePiSessionFile(branchAContent);
  const branchB = parsePiSessionFile(fixture("branch.jsonl"));

  test("both branches have the same length — the case the count guard silently drops", () => {
    // 4 messages each (model_change is not a turn). allMessages.length (4) <=
    // previousCount (4) => the old guard returns without syncing branch B.
    expect(branchA.map((m) => m.content)).toEqual([
      "start",
      "ok, ask me two things",
      "ABANDONED question",
      "ABANDONED answer",
    ]);
    expect(branchB.map((m) => m.content)).toEqual([
      "start",
      "ok, ask me two things",
      "ACTIVE question",
      "ACTIVE answer",
    ]);
    expect(branchA.length).toBe(branchB.length);
  });

  test("branch B's turns sync (not silently skipped) and its orphans are identified", () => {
    const conversation = new Map<string, string>();
    let synced = applyPass(conversation, branchA, new Map());
    // Branch A fully synced.
    expect([...synced.keys()].sort()).toEqual(["a1000003", "a2a00003", "u1000003", "u2a00003"]);

    // /tree switch: the file now resolves to branch B.
    const delta = computePiSyncDelta(branchB, synced);
    // The new branch's turns are sent, NOT dropped despite the equal length.
    expect(delta.newMessages.map((m) => m.content)).toEqual(["ACTIVE question", "ACTIVE answer"]);
    // The abandoned branch's turns are the orphans to delete.
    expect(delta.orphanUuids.sort()).toEqual(["a2a00003", "u2a00003"]);
  });

  test("after the switch the synced conversation equals branch B exactly (no splice)", () => {
    const conversation = new Map<string, string>();
    let synced = applyPass(conversation, branchA, new Map());
    synced = applyPass(conversation, branchB, synced);

    // The final synced set equals branch B's uuid set exactly.
    expect([...synced.keys()].sort()).toEqual([...branchB.map((m) => m.uuid!)].sort());
    // The rendered conversation is branch B verbatim — the abandoned turns are gone,
    // the shared prefix is intact, the new turns are appended (never a splice).
    expect(renderedInBranchOrder(conversation, branchB)).toEqual([
      "start",
      "ok, ask me two things",
      "ACTIVE question",
      "ACTIVE answer",
    ]);
    expect([...conversation.keys()]).not.toContain("u2a00003");
    expect([...conversation.keys()]).not.toContain("a2a00003");
  });
});

describe("computePiSyncDelta — shrinking branch (20 turns -> switch to a 15-turn branch)", () => {
  const shared = [mk("s0", "0"), mk("s1", "1"), mk("s2", "2"), mk("s3", "3")];
  const branchA = [...shared, ...Array.from({ length: 16 }, (_, i) => mk(`a${i + 4}`, `A${i + 4}`))]; // 20
  const branchB = [...shared, ...Array.from({ length: 11 }, (_, i) => mk(`b${i + 4}`, `B${i + 4}`))]; // 15

  test("branch B syncs even though its count (15) is below the synced count (20)", () => {
    const synced = sigsOf(branchA); // branch A fully synced
    const delta = computePiSyncDelta(branchB, synced);
    // Old guard: 15 <= 20 => return, branch B never syncs. New: its 11 novel turns sync.
    expect(delta.newMessages.map((m) => m.uuid)).toEqual(
      Array.from({ length: 11 }, (_, i) => `b${i + 4}`),
    );
    // The 16 abandoned branch-A turns are orphans.
    expect(delta.orphanUuids.sort()).toEqual(
      Array.from({ length: 16 }, (_, i) => `a${i + 4}`).sort(),
    );
  });

  test("the resulting conversation equals branch B exactly", () => {
    const conversation = new Map<string, string>();
    let synced = applyPass(conversation, branchA, new Map());
    synced = applyPass(conversation, branchB, synced);
    expect([...synced.keys()].sort()).toEqual([...branchB.map((m) => m.uuid!)].sort());
    expect(renderedInBranchOrder(conversation, branchB)).toEqual(branchB.map((m) => m.content));
    // No branch-A orphan survives.
    for (const m of branchA.slice(4)) expect(conversation.has(m.uuid!)).toBe(false);
  });
});

describe("computePiSyncDelta — ordinary append-only growth is unaffected", () => {
  test("only the appended turns are new, no orphans", () => {
    const before = [mk("m0", "0"), mk("m1", "1")];
    const after = [...before, mk("m2", "2")];
    const delta = computePiSyncDelta(after, sigsOf(before));
    expect(delta.newMessages.map((m) => m.uuid)).toEqual(["m2"]);
    expect(delta.orphanUuids).toEqual([]);
    expect([...delta.nextSynced.keys()].sort()).toEqual(["m0", "m1", "m2"]);
  });

  test("a no-op pass (nothing changed) yields no work", () => {
    const msgs = [mk("m0", "0"), mk("m1", "1")];
    const delta = computePiSyncDelta(msgs, sigsOf(msgs));
    expect(delta.newMessages).toEqual([]);
    expect(delta.orphanUuids).toEqual([]);
  });
});

describe("computePiSyncDelta — grok streaming growth under a stable uuid", () => {
  // grok appends agent_message_chunk / tool_call / turn_completed lines DURING a
  // turn, and the parser coalesces them into one message keyed by its opening
  // line — so a watcher pass mid-turn and the final pass yield the SAME uuid
  // with different payloads. A uuid-membership diff froze every streamed
  // message at whatever prefix the first pass caught (lost prose, thinking,
  // toolCalls, stopReason). Drive the real parser over a mid-stream cut of the
  // fixture, then the full file, and assert the grown message is re-sent.
  const full = fs.readFileSync(
    path.join(import.meta.dir, "__fixtures__", "grok", "linear-tools.jsonl"),
    "utf8",
  );
  const lines = full.split("\n").filter((l) => l.trim());
  // Cut right after the first agent_message_chunk: the assistant message exists
  // but holds only its first streamed words.
  const midStream = lines.slice(0, 4).join("\n");

  test("a message that grew (content, toolCalls, stopReason) is re-sent, not filtered", () => {
    const pass1 = parseGrokSessionFile(midStream);
    const synced = sigsOf(pass1);
    const pass2 = parseGrokSessionFile(full);

    const grownUuid = pass1.find((m) => m.role === "assistant")!.uuid!;
    const grown = pass2.find((m) => m.uuid === grownUuid)!;
    // Precondition: same uuid, bigger payload (this is grok's normal shape).
    expect(grown.content.length).toBeGreaterThan(
      pass1.find((m) => m.uuid === grownUuid)!.content.length,
    );

    const delta = computePiSyncDelta(pass2, synced);
    expect(delta.newMessages.map((m) => m.uuid)).toContain(grownUuid);
    expect(delta.orphanUuids).toEqual([]);
  });

  test("after the final pass a repeat pass is a no-op", () => {
    const pass2 = parseGrokSessionFile(full);
    const delta = computePiSyncDelta(pass2, sigsOf(pass2));
    expect(delta.newMessages).toEqual([]);
    expect(delta.orphanUuids).toEqual([]);
  });
});
