import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import { classifyStartedPane } from "./daemon.js";
import { CODEX_TRUST_ACCEPTED_PANE, CODEX_TRUST_PANE } from "./test-helpers/trustDialogFrames.js";

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

  // ── Codex's trust dialog on the launch path (ct-49749) ───────────────────
  // The detector here knew claude's wording only, so this frame classified
  // "booting": codex's readiness pattern wants a line ending in ">", the trust
  // screen has none, and discovery polled a dialog nobody was answering for its
  // full 120s budget while the session never bound.
  const codexPrompt = AGENT_CLIENTS.codex.promptReadyPattern;

  test("codex's numbered trust dialog is trust, not booting", () => {
    expect(classifyStartedPane(CODEX_TRUST_PANE, codexPrompt)).toBe("trust");
  });

  test("the same frame below a launch echo still reads trust", () => {
    // The launch line is above the dialog and the rule reads the pane's live
    // tail, so a pane that has not yet scrolled its echo away classifies the
    // same way.
    expect(classifyStartedPane(LAUNCH_ECHO + "\n" + CODEX_TRUST_PANE, codexPrompt)).toBe("trust");
  });

  test("the answered dialog, still in scrollback, is no longer trust", () => {
    // Codex scrolls the dialog away instead of clearing it, so the option rows
    // stay in the capture with the composer painted below them. Read over the
    // whole capture the verdict would stay "trust" forever and every 2s poll
    // would press Enter again at a live composer.
    expect(CODEX_TRUST_ACCEPTED_PANE).toContain("1. Yes, continue");
    expect(classifyStartedPane(CODEX_TRUST_ACCEPTED_PANE, codexPrompt)).not.toBe("trust");
  });

  test("codex at its ordinary prompt is ready, not trust", () => {
    // The rule keys on codex's "Yes, continue"/"No, quit" option pair, so an
    // ordinary pane — and codex's update menu, which offers "Update now" and
    // "Skip" — must be untouched by it.
    const idle = [LAUNCH_ECHO, "› Ask Codex to do anything", "  ? for shortcuts", ">"].join("\n");
    expect(classifyStartedPane(idle, codexPrompt)).toBe("ready");
    const updateMenu = [LAUNCH_ECHO, "› 1. Update now", "  2. Skip", "  Press enter to continue"].join("\n");
    expect(classifyStartedPane(updateMenu, codexPrompt)).toBe("booting");
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
