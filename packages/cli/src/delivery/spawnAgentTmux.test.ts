import { describe, test, expect } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  spawnAgentTmux,
  validateSpawnCwd,
  type TmuxRunner,
  type SpawnAgentTmuxDeps,
} from "./spawnAgentTmux.js";

// A fake tmux runner: records every argv it's handed, never touches a real server.
function recordingTmux(): { runner: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return "";
  };
  return { runner, calls };
}

function baseDeps(over?: Partial<SpawnAgentTmuxDeps>): SpawnAgentTmuxDeps {
  return { config: null, log: () => {}, ...over };
}

// A real directory we know exists, for the happy path.
const REAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-test-"));

describe("validateSpawnCwd", () => {
  test("accepts an existing absolute directory", () => {
    expect(validateSpawnCwd(REAL_DIR)).toBe(path.resolve(REAL_DIR));
  });

  test("refuses a non-existent path (no $HOME-fallback)", () => {
    expect(validateSpawnCwd("/nope/does/not/exist/anywhere-123")).toBeNull();
  });

  test("refuses a file (must be a directory)", () => {
    const f = path.join(REAL_DIR, "afile");
    fs.writeFileSync(f, "x");
    expect(validateSpawnCwd(f)).toBeNull();
  });

  test("refuses a relative path", () => {
    expect(validateSpawnCwd("relative/dir")).toBeNull();
  });

  test("refuses injection-looking paths that don't exist (existence rule, not a metachar ban)", () => {
    expect(validateSpawnCwd("/tmp/$(rm -rf ~)")).toBeNull();
    expect(validateSpawnCwd("/tmp/foo;reboot")).toBeNull();
    expect(validateSpawnCwd("/tmp/foo`id`")).toBeNull();
  });

  test("accepts a REAL directory whose name contains shell metacharacters (execFile keeps them inert)", () => {
    const weird = path.join(REAL_DIR, "proj (archive) & $tuff");
    fs.mkdirSync(weird);
    expect(validateSpawnCwd(weird)).toBe(path.resolve(weird));
  });

  test("refuses control characters", () => {
    expect(validateSpawnCwd(`${REAL_DIR}\nrm -rf ~`)).toBeNull();
    expect(validateSpawnCwd(`${REAL_DIR}\0x`)).toBeNull();
  });
});

describe("spawnAgentTmux — arg sanitization", () => {
  test("an injection attempt in the command stays inert (sent literally via -l, never via a shell)", async () => {
    const { runner, calls } = recordingTmux();
    const evil = `bash /tmp/x.sh"; rm -rf ~ #`;
    const res = await spawnAgentTmux(
      { tmuxSession: "ct-claude-abc123", cwd: REAL_DIR, agentType: "claude", command: evil },
      baseDeps({ tmux: runner }),
    );
    expect(res.ok).toBe(true);

    // No tmux argv is ever a shell string — each is an array of discrete args.
    for (const argv of calls) {
      expect(Array.isArray(argv)).toBe(true);
    }
    // The command reaches tmux as a single literal arg behind `send-keys ... -l`,
    // so the shell never sees `;` or `"` as syntax.
    const sendLiteral = calls.find((a) => a[0] === "send-keys" && a.includes("-l"));
    expect(sendLiteral).toBeDefined();
    expect(sendLiteral).toContain(evil);
    // The literal command is the LAST arg, after `-l` — not spliced into a shell line.
    expect(sendLiteral![sendLiteral!.length - 1]).toBe(evil);
    // No argv was ever assembled as a single interpolated shell command.
    expect(calls.some((a) => a.length === 1 && /rm -rf/.test(a[0]))).toBe(false);
  });

  test("refuses an unsafe tmux session name before any spawn", async () => {
    const { runner, calls } = recordingTmux();
    const res = await spawnAgentTmux(
      { tmuxSession: "ct-claude; rm -rf ~", cwd: REAL_DIR, agentType: "claude", command: "echo hi" },
      baseDeps({ tmux: runner }),
    );
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0); // never touched tmux
  });
});

describe("spawnAgentTmux — managed-session tagging", () => {
  test("tags @codecast_session_id and @codecast_agent_type so orphans can't slip", async () => {
    const { runner, calls } = recordingTmux();
    const res = await spawnAgentTmux(
      {
        tmuxSession: "ct-codex-xyz789",
        cwd: REAL_DIR,
        agentType: "codex",
        command: "bash /tmp/run.sh",
        sessionId: "sess-1234",
      },
      baseDeps({ tmux: runner }),
    );
    expect(res.ok).toBe(true);

    const setOpts = calls.filter((a) => a[0] === "set-option");
    const flat = setOpts.map((a) => a.join(" "));
    expect(flat.some((s) => s.includes("@codecast_session_id") && s.includes("sess-1234"))).toBe(true);
    expect(flat.some((s) => s.includes("@codecast_agent_type") && s.includes("codex"))).toBe(true);

    // The new-session is created before the tags and before send-keys.
    const order = calls.map((a) => a[0]);
    expect(order.indexOf("new-session")).toBeLessThan(order.indexOf("set-option"));
    expect(order.lastIndexOf("set-option")).toBeLessThan(order.indexOf("send-keys"));
  });
});

describe("spawnAgentTmux — missing-path refusal", () => {
  test("refuses (does not spawn, no $HOME-fallback) when cwd is absent", async () => {
    const { runner, calls } = recordingTmux();
    const res = await spawnAgentTmux(
      { tmuxSession: "ct-claude-missing", cwd: "/definitely/not/here-998877", agentType: "claude", command: "echo hi" },
      baseDeps({ tmux: runner }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("/definitely/not/here-998877");
    expect(calls.length).toBe(0);
  });
});

describe("spawnAgentTmux — ownership (never auto-own a remote)", () => {
  test("skips the spawn when another device owns the conversation", async () => {
    const { runner, calls } = recordingTmux();
    const res = await spawnAgentTmux(
      {
        tmuxSession: "cc-claude-conv01",
        cwd: REAL_DIR,
        agentType: "claude",
        command: "claude --resume x",
        sessionId: "s1",
        conversationId: "conv-000000000001",
      },
      baseDeps({
        tmux: runner,
        isRemoteDevice: true,
        claimOwnership: async () => ({ won: false, owner: "otherdevice" }),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("owned by another device");
    expect(calls.length).toBe(0); // lost the claim → never spawned
  });

  test("spawns + registers when this device wins the claim", async () => {
    const { runner, calls } = recordingTmux();
    // Record into an array so TS doesn't control-flow-narrow a `let … | null` to
    // `null` (the mutation happens inside an injected callback it can't see).
    const registrations: { sessionId: string; tmux: string; conv: string }[] = [];
    const res = await spawnAgentTmux(
      {
        tmuxSession: "cc-claude-conv02",
        cwd: REAL_DIR,
        agentType: "claude",
        command: "claude --resume y",
        sessionId: "s2",
        conversationId: "conv-000000000002",
      },
      baseDeps({
        tmux: runner,
        claimOwnership: async () => ({ won: true }),
        registerManagedSession: (sessionId, tmux, conv) => {
          registrations.push({ sessionId, tmux, conv });
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(calls.some((a) => a[0] === "new-session")).toBe(true);
    expect(registrations[0]).toEqual({ sessionId: "s2", tmux: "cc-claude-conv02", conv: "conv-000000000002" });
  });
});
