import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CLAUDE_UUID_RE,
  combineClaudeResumeFlags,
  copyJsonlAsSession,
  extractJsonlPermissionMode,
  rewriteSubagentJsonlToUuid,
} from "./resumeCommand.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

const trash: string[] = [];
afterEach(() => {
  while (trash.length) {
    const p = trash.pop()!;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

describe("CLAUDE_UUID_RE", () => {
  test("matches v4 UUIDs", () => {
    expect(CLAUDE_UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  test("rejects subagent nanoid-style IDs", () => {
    expect(CLAUDE_UUID_RE.test("agent-abcdef1234")).toBe(false);
    expect(CLAUDE_UUID_RE.test("jx70ntfabc")).toBe(false);
  });
});

describe("combineClaudeResumeFlags", () => {
  test("appends permission flag when absent", () => {
    expect(combineClaudeResumeFlags("", "--permission-mode bypassPermissions"))
      .toBe("--permission-mode bypassPermissions");
    expect(combineClaudeResumeFlags("--verbose", "--permission-mode bypassPermissions"))
      .toBe("--verbose --permission-mode bypassPermissions");
  });

  test("skips permission flag when any equivalent is already present", () => {
    expect(combineClaudeResumeFlags("--dangerously-skip-permissions", "--permission-mode bypassPermissions"))
      .toBe("--dangerously-skip-permissions");
    expect(combineClaudeResumeFlags("--allow-dangerously-skip-permissions", "--permission-mode bypassPermissions"))
      .toBe("--allow-dangerously-skip-permissions");
    expect(combineClaudeResumeFlags("--permission-mode default", "--permission-mode bypassPermissions"))
      .toBe("--permission-mode default");
  });

  test("jsonlBypass forces --dangerously-skip-permissions before permFlags resolve", () => {
    const result = combineClaudeResumeFlags("--verbose", "--permission-mode bypassPermissions", true);
    expect(result).toContain("--dangerously-skip-permissions");
    // permFlags shouldn't double-add since hasClaudePermissionFlag is now true
    expect(result).not.toContain("--permission-mode bypassPermissions");
  });

  test("handles null/undefined base args", () => {
    expect(combineClaudeResumeFlags(null, "--allow-dangerously-skip-permissions"))
      .toBe("--allow-dangerously-skip-permissions");
    expect(combineClaudeResumeFlags(undefined, null)).toBe("");
  });
});

describe("extractJsonlPermissionMode", () => {
  test("returns permissionMode from first user line", () => {
    const jsonl = [
      '{"type":"summary","summary":"x"}',
      '{"type":"user","permissionMode":"bypassPermissions","message":{}}',
    ].join("\n");
    expect(extractJsonlPermissionMode(jsonl)).toBe("bypassPermissions");
  });

  test("returns undefined when no user line", () => {
    expect(extractJsonlPermissionMode('{"type":"summary"}')).toBeUndefined();
  });

  test("returns undefined on malformed JSON", () => {
    expect(extractJsonlPermissionMode('{"type":"user", broken')).toBeUndefined();
  });
});

describe("rewriteSubagentJsonlToUuid", () => {
  test("no-op when sessionId is already a UUID", () => {
    const dir = tmpDir("resume-cmd");
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);

    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = rewriteSubagentJsonlToUuid(uuid, path.join(dir, `${uuid}.jsonl`));
    expect(result).toEqual({ resumeId: uuid, rewrote: false });
  });

  test("no-op when JSONL file is missing", () => {
    const dir = tmpDir("resume-cmd");
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);

    const result = rewriteSubagentJsonlToUuid("subagent-xyz", path.join(dir, "subagent-xyz.jsonl"));
    expect(result.rewrote).toBe(false);
    expect(result.resumeId).toBe("subagent-xyz");
  });

  test("rewrites non-UUID sessionId into a fresh UUID-named JSONL", () => {
    const dir = tmpDir("resume-cmd");
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);

    const oldId = "agent-abc123";
    const sourcePath = path.join(dir, `${oldId}.jsonl`);
    const content = `{"type":"user","sessionId":"${oldId}","message":{}}\n{"type":"assistant","sessionId":"${oldId}","message":{}}\n`;
    fs.writeFileSync(sourcePath, content);

    const result = rewriteSubagentJsonlToUuid(oldId, sourcePath);
    expect(result.rewrote).toBe(true);
    expect(CLAUDE_UUID_RE.test(result.resumeId)).toBe(true);
    expect(result.newJsonlPath).toBeDefined();
    expect(fs.existsSync(result.newJsonlPath!)).toBe(true);

    const rewritten = fs.readFileSync(result.newJsonlPath!, "utf-8");
    expect(rewritten).not.toContain(`"sessionId":"${oldId}"`);
    expect(rewritten).toContain(`"sessionId":"${result.resumeId}"`);
    // Original file untouched
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(content);
  });

  test("escapes regex metacharacters in sessionId", () => {
    const dir = tmpDir("resume-cmd");
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);

    // sessionIds with regex-meaningful characters shouldn't blow up
    const oldId = "agent.with+special?chars";
    const sourcePath = path.join(dir, `${oldId}.jsonl`);
    fs.writeFileSync(sourcePath, `{"sessionId":"${oldId}"}\n`);

    const result = rewriteSubagentJsonlToUuid(oldId, sourcePath);
    expect(result.rewrote).toBe(true);
    const rewritten = fs.readFileSync(result.newJsonlPath!, "utf-8");
    expect(rewritten).toContain(`"sessionId":"${result.resumeId}"`);
  });
});

describe("copyJsonlAsSession", () => {
  const PARENT = "11111111-2222-4333-8444-555555555555";
  const FORK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  function writeParent(dir: string, content: string): string {
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);
    const p = path.join(dir, `${PARENT}.jsonl`);
    fs.writeFileSync(p, content);
    return p;
  }

  test("copies next to the source under the target id, rewriting only sessionId fields", () => {
    const dir = tmpDir("fork-copy");
    const line1 = `{"sessionId":"${PARENT}","type":"user","message":{"role":"user","content":"hello"},"uuid":"u1"}`;
    const line2 = `{"sessionId":"${PARENT}","type":"assistant","message":{"role":"assistant","content":"hi"},"uuid":"u2"}`;
    const src = writeParent(dir, `${line1}\n${line2}\n`);

    const newPath = copyJsonlAsSession(src, PARENT, FORK);
    expect(newPath).toBe(path.join(dir, `${FORK}.jsonl`));
    const copied = fs.readFileSync(newPath!, "utf-8");
    expect(copied).not.toContain(PARENT);
    expect(copied).toContain(`"sessionId":"${FORK}"`);
    // Message content bytes untouched — this is what keeps the prompt cache warm.
    expect(copied).toContain(`"content":"hello"`);
    expect(copied.split("\n").length).toBe(3); // two lines + trailing newline
    // Source untouched.
    expect(fs.readFileSync(src, "utf-8")).toContain(`"sessionId":"${PARENT}"`);
  });

  test("drops a partially-flushed (invalid JSON) trailing line from a live source", () => {
    const dir = tmpDir("fork-copy");
    const full = `{"sessionId":"${PARENT}","uuid":"u1"}`;
    const partial = `{"sessionId":"${PARENT}","uuid":"u2","mess`; // mid-flush
    const src = writeParent(dir, `${full}\n${partial}`);

    const newPath = copyJsonlAsSession(src, PARENT, FORK);
    const copied = fs.readFileSync(newPath!, "utf-8");
    expect(copied).toBe(`{"sessionId":"${FORK}","uuid":"u1"}\n`);
  });

  test("keeps a complete final line that merely lacks its newline", () => {
    const dir = tmpDir("fork-copy");
    const l1 = `{"sessionId":"${PARENT}","uuid":"u1"}`;
    const l2 = `{"sessionId":"${PARENT}","uuid":"u2"}`;
    const src = writeParent(dir, `${l1}\n${l2}`); // no trailing \n

    const newPath = copyJsonlAsSession(src, PARENT, FORK);
    const copied = fs.readFileSync(newPath!, "utf-8");
    expect(copied).toContain(`"uuid":"u2"`);
  });

  test("idempotent: existing target is returned untouched", () => {
    const dir = tmpDir("fork-copy");
    const src = writeParent(dir, `{"sessionId":"${PARENT}","uuid":"u1"}\n`);
    const existing = path.join(dir, `${FORK}.jsonl`);
    fs.writeFileSync(existing, "already-here\n");

    const newPath = copyJsonlAsSession(src, PARENT, FORK);
    expect(newPath).toBe(existing);
    expect(fs.readFileSync(existing, "utf-8")).toBe("already-here\n");
  });

  test("returns null when the source is missing", () => {
    const dir = tmpDir("fork-copy");
    fs.mkdirSync(dir, { recursive: true });
    trash.push(dir);
    expect(copyJsonlAsSession(path.join(dir, "missing.jsonl"), PARENT, FORK)).toBeNull();
  });
});
