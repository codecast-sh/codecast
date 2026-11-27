import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { SESSION_TRAILER_HOOK } from "./sessionTrailerHook.js";
import {
  PROMOTED_AGENTS_FILE, PROMOTION_HOLD_REASON, PROMOTION_SETTLE_MS, promotionHold, readPromotedAgents, recordPromotedAgent, sendMessageGuardOutput, type PromotedAgents, type PromotionGateDeps,
} from "./subagentPromotion.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "promote-"));
const PARENT = "86a160aa-623c-4db9-9ce0-f1f1c403cace";
const AGENT = "a8665f73ab2350b5e";
const JSONL = `/home/.claude/projects/-p/${PARENT}/subagents/agent-${AGENT}.jsonl`;

// The PreToolUse payload Claude Code 2.1.332 sent for a SendMessage (spike case 7).
const payload = (to: string, extra: object = {}) => JSON.stringify({
  session_id: PARENT, transcript_path: `/home/.claude/projects/-p/${PARENT}.jsonl`, hook_event_name: "PreToolUse", tool_name: "SendMessage",
  tool_input: { to, summary: "Resume", message: "Reply RESUMED.", type: "message", recipient: to, recipient_kind: "agent", content: "Reply RESUMED." },
  tool_use_id: "toolu_011T", ...extra,
});

describe("the SendMessage guard", () => {
  const promoted: PromotedAgents = { [PARENT]: { [AGENT]: { short_id: "jx7abcd", at: 1 } } };
  const lookup = (p: string) => promoted[p];
  test("denies a SendMessage to a promoted agent, naming the session to reach", () => {
    const out = JSON.parse(sendMessageGuardOutput(payload(AGENT), lookup));
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This agent was taken over and now runs as its own session jx7abcd. Reach it with: cast send jx7abcd" } });
  });
  test("a sibling subagent's call carries the root parent's session_id and is denied too; a ref suffix is dropped", () => {
    expect(sendMessageGuardOutput(payload(`${AGENT} [e7fb8a]`, { agent_id: "aother", agent_type: "general-purpose" }), lookup)).toContain("jx7abcd");
  });
  test("lets every other call through", () => {
    expect(sendMessageGuardOutput(payload("aca2c98614b1916fb"), lookup)).toBe("");
    expect(sendMessageGuardOutput(payload(AGENT).replace(PARENT, "other-parent"), lookup)).toBe("");
    expect(sendMessageGuardOutput(JSON.stringify({ session_id: PARENT, tool_name: "Bash", tool_input: { command: AGENT } }), lookup)).toBe("");
    expect(sendMessageGuardOutput("not json", lookup)).toBe("");
  });
});

describe("the hook script", () => {
  // A fake cast on PATH records whether the script handed the call over.
  function run(input: string, env: Record<string, string>) {
    const bin = tmp();
    const log = path.join(bin, "called");
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/sh\ncat > /dev/null\necho called >> ${log}\n`, { mode: 0o755 });
    const script = path.join(bin, "hook.sh");
    fs.writeFileSync(script, SESSION_TRAILER_HOOK, { mode: 0o755 });
    const r = spawnSync("/bin/bash", [script], { input, encoding: "utf-8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env } });
    expect(r.status).toBe(0);
    return fs.existsSync(log);
  }
  test("a SendMessage reaches cast only once something was promoted, whatever the trailer setting", () => {
    const dir = tmp();
    expect(run(payload(AGENT), { CODECAST_DIR: dir })).toBe(false);
    recordPromotedAgent(dir, PARENT, AGENT, "jx7abcd", 1);
    expect(run(payload(AGENT), { CODECAST_DIR: dir })).toBe(true);
    expect(run(payload(AGENT), { CODECAST_DIR: dir, CODECAST_SESSION_TRAILER: "0" })).toBe(true);
  });
  test("the trailer screen is unchanged", () => {
    const commit = JSON.stringify({ session_id: PARENT, tool_name: "Bash", tool_input: { command: "git commit -m x" } });
    expect(run(commit, { CODECAST_DIR: tmp() })).toBe(true);
    expect(run(commit, { CODECAST_DIR: tmp(), CODECAST_SESSION_TRAILER: "0" })).toBe(false);
    expect(run(JSON.stringify({ tool_name: "Read", tool_input: {} }), { CODECAST_DIR: tmp() })).toBe(false);
  });
});

describe("the deny list", () => {
  test("is keyed by parent, keeps the first write, and is written whole", () => {
    const dir = tmp();
    expect(recordPromotedAgent(dir, PARENT, AGENT, "jx7abcd", 100)).toBe(100);
    expect(recordPromotedAgent(dir, PARENT, AGENT, "jx7abcd", 900)).toBe(100);
    recordPromotedAgent(dir, PARENT, "a0559479375992e8a", "jx7efgh", 200);
    expect(readPromotedAgents(dir)).toEqual({ [PARENT]: { [AGENT]: { short_id: "jx7abcd", at: 100 }, a0559479375992e8a: { short_id: "jx7efgh", at: 200 } } });
    expect(fs.readdirSync(dir)).toEqual([PROMOTED_AGENTS_FILE]);
  });
});

describe("promotionHold", () => {
  function deps(dir: string, state: "running" | "stopped", mtime: number | null, clock = { t: 10_000 }) {
    const seen: string[] = [];
    const d: PromotionGateDeps = {
      configDir: dir,
      now: () => clock.t,
      sleep: async (ms) => { seen.push(`sleep:${ms}`); clock.t += ms; },
      runState: async () => {
        seen.push(readPromotedAgents(dir)[PARENT]?.[AGENT] ? "state:denied-first" : "state:not-denied");
        return state;
      },
      mtimeMs: () => mtime,
    };
    return { d, seen, clock };
  }
  test("a running in-process copy holds the message; the deny entry is written before anything is read", async () => {
    const dir = tmp();
    const { d, seen } = deps(dir, "running", 0);
    expect(await promotionHold(JSONL, "jx7abcd", d)).toBe(PROMOTION_HOLD_REASON);
    expect(seen).toEqual([`sleep:${PROMOTION_SETTLE_MS}`, "state:denied-first"]);
    expect(readPromotedAgents(dir)[PARENT][AGENT].short_id).toBe("jx7abcd");
  });
  test("a stopped copy whose transcript is still settles goes ahead; the settle is waited once", async () => {
    const dir = tmp();
    const { d, seen } = deps(dir, "stopped", 0);
    expect(await promotionHold(JSONL, "jx7abcd", d)).toBeNull();
    expect(await promotionHold(JSONL, "jx7abcd", d)).toBeNull();
    expect(seen).toEqual([`sleep:${PROMOTION_SETTLE_MS}`, "state:denied-first", "state:denied-first"]);
  });
  test("a transcript that moved in the last seconds holds, even when the state reads stopped", async () => {
    const { d } = deps(tmp(), "stopped", 11_500);
    expect(await promotionHold(JSONL, "jx7abcd", d)).toBe(PROMOTION_HOLD_REASON);
  });
  test("a path that is no subagent transcript is not gated", async () => {
    const dir = tmp();
    const { d, seen } = deps(dir, "running", 0);
    expect(await promotionHold(`/home/.claude/projects/-p/${PARENT}.jsonl`, "jx7abcd", d)).toBeNull();
    expect(seen).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
