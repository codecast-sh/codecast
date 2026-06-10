import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAUDE_UUID_RE,
  isForkArtifactSessionId,
  removeForkArtifactJsonl,
  rewriteSubagentJsonlToUuid,
} from "./resumeCommand.js";

// Regression coverage for the fork-resume doppelgänger conversation
// (root-caused 2026-06-09, conv jx782hj vs jx79y0x).
//
// Root cause recap: resuming a fork (`resume_session {fork:true}`) reconstitutes
// the transcript to `forked-<orig>-<uuid>.jsonl`, copies it to a UUID file for
// `claude --resume`, and remaps the conversation cache to the UUID — deleting
// the forked id's cache entry. The source file stayed on disk, so the sync
// watcher rediscovered it ~400ms later as an unknown session and minted a brand
// new conversation for it. That doppelgänger tops the inbox (fresh 149-msg
// sync), receives the user's messages (delivery still resolves the live tmux by
// the forked id's resume-tmux name) but never receives output (the live
// transcript is the UUID copy, syncing to the original conversation) — the
// visible symptom is a conversation that "stopped syncing", plus an ack-less
// re-delivery loop.
//
// Fix: (1) the resume path deletes the fork-artifact source right after the
// UUID copy + remap; (2) the watcher refuses to mint conversations for
// `forked-*` session files (defense in depth for the write→delete race).

describe("isForkArtifactSessionId", () => {
  test("matches server-minted fork session ids", () => {
    expect(
      isForkArtifactSessionId("forked-azjz8ulql2fxfulwa4v4w-4181aeab-629f-4f4f-bdc3-9b84ceccc6f0"),
    ).toBe(true);
  });

  test("does not match subagent or UUID session ids", () => {
    expect(isForkArtifactSessionId("agent-ac3f2b1d")).toBe(false);
    expect(isForkArtifactSessionId("290a5496-17c2-4a2b-a3c4-4f689a375929")).toBe(false);
    // A UUID that merely embeds the word is still not a fork id
    expect(isForkArtifactSessionId("not-forked-prefix")).toBe(false);
  });
});

describe("removeForkArtifactJsonl", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-artifact-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJsonl = (sessionId: string): string => {
    const p = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      p,
      JSON.stringify({ sessionId, type: "user", message: { content: "hi" } }) + "\n",
    );
    return p;
  };

  test("rewrite + cleanup leaves only the UUID copy (the regression)", () => {
    const forkedId = "forked-azjz8ulql2fxfulwa4v4w-4181aeab-629f-4f4f-bdc3-9b84ceccc6f0";
    const sourcePath = writeJsonl(forkedId);

    const rewrite = rewriteSubagentJsonlToUuid(forkedId, sourcePath);
    expect(rewrite.rewrote).toBe(true);
    expect(CLAUDE_UUID_RE.test(rewrite.resumeId)).toBe(true);

    expect(removeForkArtifactJsonl(forkedId, sourcePath)).toBe(true);

    // Exactly one file remains: the resumable UUID copy. A lingering source is
    // what the sync watcher minted the doppelgänger conversation from.
    const remaining = fs.readdirSync(dir);
    expect(remaining).toEqual([`${rewrite.resumeId}.jsonl`]);
    expect(fs.readFileSync(path.join(dir, remaining[0]), "utf-8")).toContain(
      `"sessionId":"${rewrite.resumeId}"`,
    );
  });

  test("leaves subagent sources alone — they are real transcripts", () => {
    const agentId = "agent-ac3f2b1d";
    const sourcePath = writeJsonl(agentId);

    const rewrite = rewriteSubagentJsonlToUuid(agentId, sourcePath);
    expect(rewrite.rewrote).toBe(true);

    expect(removeForkArtifactJsonl(agentId, sourcePath)).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  test("returns false without throwing when the source is already gone", () => {
    expect(
      removeForkArtifactJsonl("forked-x-y", path.join(dir, "forked-x-y.jsonl")),
    ).toBe(false);
  });
});
