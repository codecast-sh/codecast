import { describe, expect, test } from "bun:test";
import {
  isValidBlameSha,
  matchUncommittedLines,
  pickRowForSha,
  type CommitRowLite,
  type EditRowLite,
} from "./blameCore";
import { extractFileChanges } from "./fileChanges/extractor";

const FULL_SHA = "b556a7dd2f4e9a01c3b8d7e6f5a4b3c2d1e0f9a8";

const commitRow = (overrides: Partial<CommitRowLite>): CommitRowLite => ({
  commit_hash: FULL_SHA.slice(0, 7),
  conversation_id: "conv1",
  message_id: "msg1",
  timestamp: 100,
  ...overrides,
});

describe("pickRowForSha", () => {
  test("matches a short stored hash as a prefix of the full SHA", () => {
    const row = commitRow({});
    expect(pickRowForSha(FULL_SHA, [row])).toBe(row);
  });

  test("matches a full-length stored hash", () => {
    const row = commitRow({ commit_hash: FULL_SHA });
    expect(pickRowForSha(FULL_SHA, [row])).toBe(row);
  });

  test("rejects same-range rows that are not prefixes", () => {
    // Index range scan over [sha7, fullSha] can return a hash sharing the
    // 7-char prefix but diverging after it.
    const impostor = commitRow({ commit_hash: FULL_SHA.slice(0, 7) + "0000" });
    expect(pickRowForSha(FULL_SHA, [impostor])).toBeNull();
  });

  test("rejects hashes shorter than the minimum prefix", () => {
    const row = commitRow({ commit_hash: FULL_SHA.slice(0, 6) });
    expect(pickRowForSha(FULL_SHA, [row])).toBeNull();
  });

  test("prefers the newest matching row", () => {
    const older = commitRow({ timestamp: 100, conversation_id: "old" });
    const newer = commitRow({ timestamp: 200, conversation_id: "new" });
    expect(pickRowForSha(FULL_SHA, [older, newer])?.conversation_id).toBe("new");
  });

  test("returns null for missing hashes", () => {
    expect(pickRowForSha(FULL_SHA, [commitRow({ commit_hash: undefined })])).toBeNull();
    expect(pickRowForSha(FULL_SHA, [])).toBeNull();
  });
});

const editRow = (overrides: Partial<EditRowLite>): EditRowLite => ({
  conversation_id: "conv1",
  message_id: "msg1",
  file_path: "/repo/src/auth.ts",
  change_type: "edit",
  new_content: "",
  timestamp: 100,
  ...overrides,
});

describe("matchUncommittedLines", () => {
  test("attributes a line to the newest edit containing it", () => {
    const line = "const sessionToken = await refreshSession(user);";
    const older = editRow({ new_content: `x\n${line}\ny`, timestamp: 100, conversation_id: "old" });
    const newer = editRow({ new_content: `${line}`, timestamp: 200, conversation_id: "new" });
    const matches = matchUncommittedLines([line], [older, newer]);
    expect(matches.get(line.trim())?.conversation_id).toBe("new");
  });

  test("matches on trimmed content so indentation drift is tolerated", () => {
    const row = editRow({ new_content: "const sessionToken = await refresh();" });
    const matches = matchUncommittedLines(["    const sessionToken = await refresh();"], [row]);
    expect(matches.get("const sessionToken = await refresh();")).toBe(row);
  });

  test("skips short common lines", () => {
    const row = editRow({ new_content: "}\nreturn;" });
    expect(matchUncommittedLines(["}", "return;"], [row]).size).toBe(0);
  });

  test("leaves unmatched lines out", () => {
    const row = editRow({ new_content: "something else entirely" });
    expect(matchUncommittedLines(["const missing = lineNotInAnyEdit();"], [row]).size).toBe(0);
  });
});

describe("isValidBlameSha", () => {
  test("accepts full and short hex", () => {
    expect(isValidBlameSha(FULL_SHA)).toBe(true);
    expect(isValidBlameSha("abc1234")).toBe(true);
  });
  test("rejects non-hex and too-short input", () => {
    expect(isValidBlameSha("abc123")).toBe(false);
    expect(isValidBlameSha("not-a-sha")).toBe(false);
    expect(isValidBlameSha("")).toBe(false);
  });
});

// The extractor's commit-hash parse feeds the whole blame join — regression
// coverage for the original bug where `[main abc1234]` never matched because
// the regex required the entire bracket to be hex.
describe("extractFileChanges commit hash", () => {
  const commitMessage = (resultContent: string) =>
    extractFileChanges([
      {
        _id: "m1",
        timestamp: 1,
        tool_calls: [
          {
            id: "t1",
            name: "Bash",
            input: JSON.stringify({ command: 'git commit -m "fix: thing"' }),
          },
        ],
        tool_results: [{ tool_use_id: "t1", content: resultContent }],
      },
    ])[0];

  test("parses the hash from standard `[branch hash]` output", () => {
    const fc = commitMessage("[main b556a7dd] fix: thing\n 2 files changed, 10 insertions(+)");
    expect(fc.changeType).toBe("commit");
    expect(fc.commitHash).toBe("b556a7dd");
  });

  test("parses detached HEAD and root-commit forms", () => {
    expect(commitMessage("[detached HEAD 088d489a] fix: thing").commitHash).toBe("088d489a");
    expect(commitMessage("[main (root-commit) abc1234f] init").commitHash).toBe("abc1234f");
  });

  test("still parses a bare-hash bracket", () => {
    expect(commitMessage("[b556a7dd] fix: thing").commitHash).toBe("b556a7dd");
  });

  test("does not mistake a hex-tailed branch name for a hash", () => {
    expect(commitMessage("[fix-deadbeef] something").commitHash).toBeUndefined();
  });

  test("returns no hash on error results", () => {
    const fc = extractFileChanges([
      {
        _id: "m1",
        timestamp: 1,
        tool_calls: [
          { id: "t1", name: "Bash", input: JSON.stringify({ command: 'git commit -m "x"' }) },
        ],
        tool_results: [{ tool_use_id: "t1", content: "[main abc1234] x", is_error: true }],
      },
    ])[0];
    expect(fc.commitHash).toBeUndefined();
  });
});
