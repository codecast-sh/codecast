import { describe, it, expect } from "vitest";
import { mergeFileChanges } from "../fileChangeExtractor";
import type { FileChange } from "../../store/diffViewerStore";

function fc(partial: Partial<FileChange> & { id: string; timestamp: number; sequenceIndex: number }): FileChange {
  return {
    messageId: "m",
    filePath: "a.ts",
    changeType: "edit",
    newContent: "x",
    ...partial,
  };
}

describe("mergeFileChanges", () => {
  it("returns the client set when the server has nothing (un-materialized/old conversations)", () => {
    const client = [
      fc({ id: "1", timestamp: 10, sequenceIndex: 0 }),
      fc({ id: "2", timestamp: 20, sequenceIndex: 1 }),
    ];
    const merged = mergeFileChanges([], client);
    expect(merged.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("returns the server set when the client window is empty", () => {
    const server = [fc({ id: "1", timestamp: 10, sequenceIndex: 0 })];
    expect(mergeFileChanges(server, []).map((c) => c.id)).toEqual(["1"]);
  });

  it("dedupes by id, preferring the server copy", () => {
    const client = [fc({ id: "1", timestamp: 10, sequenceIndex: 0, newContent: "client" })];
    const server = [fc({ id: "1", timestamp: 10, sequenceIndex: 0, newContent: "server" })];
    const merged = mergeFileChanges(server, client);
    expect(merged).toHaveLength(1);
    expect(merged[0].newContent).toBe("server");
  });

  it("unions complete server changes with old client-only ones (straddle case)", () => {
    // Old edit only in the loaded window, newer edits materialized server-side.
    const client = [fc({ id: "old", timestamp: 5, sequenceIndex: 0 })];
    const server = [
      fc({ id: "new1", timestamp: 30, sequenceIndex: 0 }),
      fc({ id: "new2", timestamp: 40, sequenceIndex: 1 }),
    ];
    const merged = mergeFileChanges(server, client);
    expect(merged.map((c) => c.id)).toEqual(["old", "new1", "new2"]);
  });

  it("orders by (timestamp, in-message seq) and re-indexes sequenceIndex to the merged position", () => {
    // Two edits share a timestamp (same message) — seq breaks the tie.
    const server = [
      fc({ id: "b", timestamp: 100, sequenceIndex: 1 }),
      fc({ id: "a", timestamp: 100, sequenceIndex: 0 }),
      fc({ id: "c", timestamp: 200, sequenceIndex: 0 }),
    ];
    const merged = mergeFileChanges(server, []);
    expect(merged.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(merged.map((c) => c.sequenceIndex)).toEqual([0, 1, 2]);
  });

  it("backfills a missing commit hash from the client copy", () => {
    // Server row materialized before the tool result (hash) arrived; client extracted it later.
    const server = [fc({ id: "k", timestamp: 10, sequenceIndex: 0, changeType: "commit", filePath: "git commit" })];
    const client = [
      fc({ id: "k", timestamp: 10, sequenceIndex: 0, changeType: "commit", filePath: "git commit", commitHash: "abc1234" }),
    ];
    expect(mergeFileChanges(server, client)[0].commitHash).toBe("abc1234");
  });

  it("keeps the server commit hash when it has one", () => {
    const server = [fc({ id: "k", timestamp: 10, sequenceIndex: 0, commitHash: "server7" })];
    const client = [fc({ id: "k", timestamp: 10, sequenceIndex: 0, commitHash: "client7" })];
    expect(mergeFileChanges(server, client)[0].commitHash).toBe("server7");
  });
});
