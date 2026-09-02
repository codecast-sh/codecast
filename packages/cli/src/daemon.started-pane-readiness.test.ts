import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import { classifyStartedPane } from "./daemon.js";

// Regression coverage for the unbound blank new session (root-caused 2026-09-02).
//
// A web "New Session" with no first message launched Claude fine, but the
// daemon linked a started pane to its conversation only by discovering a new
// <uuid>.jsonl under ~/.claude/projects. Claude writes that file on the first
// turn, so a session nobody typed into had nothing to discover: discovery timed
// out after 60s and the conversation kept the web's stub as its session id
// (card never left the unstarted state) while the agent sat at its prompt.
// One daemon log held 71 such timeouts against 54 links.
//
// Fix: the daemon already knows the uuid it passed as `--session-id`; the pane
// at its input prompt is the link signal. classifyStartedPane is the pure
// readiness verdict shared by first-message delivery and discovery.

const claudePrompt = AGENT_CLIENTS.claude.promptReadyPattern;

// Real capture of the stranded pane (cc-claude-14aehd8dm63p), trimmed.
const LAUNCH_ECHO =
  "/Users/ashot/.bun/bin/bun /Users/ashot/src/codecast/packages/cli/src/index.ts _disclaimed -- env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT " +
  "/Users/ashot/.codecast/bin/claude --permission-mode bypassPermissions --session-id a2373c3a-74fe-40d0-80a0-aefb50730803 --model fable";
const READY_PANE = [
  LAUNCH_ECHO,
  "~/src/codecast (main):" + LAUNCH_ECHO,
  " ▐▛███▛█   Claude Code v2.1.258",
  "▝▜██████▀  Fable 5.1 with high effort · Claude Max",
  "  ▝▝ ▝▝    ~/src/codecast",
  "",
  "",
  "────────────────────────────────────────",
  "❯                             ",
  "────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents           /rc",
].join("\n");

describe("classifyStartedPane", () => {
  test("a blank fresh session at its prompt is ready — no transcript needed", () => {
    expect(classifyStartedPane(READY_PANE, claudePrompt)).toBe("ready");
  });

  test("only the echoed launch command is still booting", () => {
    expect(classifyStartedPane(LAUNCH_ECHO + "\n", claudePrompt)).toBe("booting");
  });

  test("the workspace trust prompt is trust, never ready, even though it paints ❯", () => {
    const pane = [LAUNCH_ECHO, "Quick safety check", "Do you trust this folder?", "❯ 1. Yes, I trust this folder", "  2. No"].join("\n");
    expect(classifyStartedPane(pane, claudePrompt)).toBe("trust");
  });

  test("a launch error below the echo is fatal; shell rc noise above it is not", () => {
    expect(classifyStartedPane(LAUNCH_ECHO + "\nbash: claude: command not found\n", claudePrompt)).toBe("fatal");
    expect(classifyStartedPane("zsh: command not found: compdef\n" + LAUNCH_ECHO + "\n", claudePrompt)).toBe("booting");
  });
});

describe("discovery binds the assigned session id at prompt readiness", () => {
  const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
  const daemonSource = fs.readFileSync(daemonPath, "utf8");
  const idx = daemonSource.indexOf("async function discoverAndLinkSession(");
  const body = daemonSource.slice(idx, daemonSource.indexOf("\n}\n", idx));

  test("the pane probe runs before the JSONL scan and links entry.sessionId", () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    const probeAt = body.indexOf("probeStartedPane(entry)");
    const linkAt = body.indexOf('link(entry.sessionId, "prompt readiness")');
    const scanAt = body.indexOf("UUID_JSONL_RE");
    expect(probeAt).toBeGreaterThan(0);
    expect(linkAt).toBeGreaterThan(probeAt);
    // existingFiles is built from UUID_JSONL_RE before the loop; the in-loop
    // scan is the second use and must come after the readiness link.
    expect(body.indexOf("UUID_JSONL_RE", scanAt + 1)).toBeGreaterThan(linkAt);
  });

  test("first-message delivery reuses the same probe instead of its own capture loop", () => {
    const at = daemonSource.indexOf("const tryStartedTmux = async");
    const delivery = daemonSource.slice(at, at + 4000);
    expect(delivery).toContain("probeStartedPane(entry)");
    expect(delivery).not.toContain("trustPromptPatterns");
  });

  test("a restarted daemon resumes discovery for persisted, still-unlinked panes", () => {
    const bootAt = daemonSource.indexOf("syncServiceRef = syncService;");
    expect(daemonSource.slice(bootAt, bootAt + 200)).toContain("resumeStartedSessionDiscovery()");
    const fnAt = daemonSource.indexOf("function resumeStartedSessionDiscovery()");
    const fn = daemonSource.slice(fnAt, daemonSource.indexOf("\n}\n", fnAt));
    expect(fn).toContain("discoverAndLinkSession(conversationId, entry.tmuxSession, entry.projectPath)");
    expect(fn).toContain("reverse[conversationId]");
  });
});
