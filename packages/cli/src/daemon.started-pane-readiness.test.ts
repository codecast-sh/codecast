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
  const codexReadiness = AGENT_CLIENTS.codex.paneReadiness;

  // Captured verbatim from a cold codex 0.153.4 pane on a private tmux server,
  // launched through the daemon's own launch text (ct-49538). The footer line —
  // `<model> <effort> · <cwd>` — is what paints last, and it is why the old
  // />\s*$/ readiness pattern could never match a ready codex pane.
  const CODEX_READY_PANE = [
    LAUNCH_ECHO,
    "╭─────────────────────────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.153.4)                              │",
    "│                                                         │",
    "│ model:       matrix   /model to change                  │",
    "│ directory:   /private/var/folders/…/matrix-codex-YuN0Ta │",
    "│ permissions: YOLO mode                                  │",
    "╰─────────────────────────────────────────────────────────╯",
    "",
    "› Ask Codex to do anything",
    " ",
    "  matrix default · /private/var/folders/sr/t5ddhmcd6q1gnzhx2xxydv680000gn/T/codecasttestscratch/matrix-codex-YuN0Ta",
  ].join("\n");

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
    expect(classifyStartedPane(CODEX_READY_PANE, codexPrompt, codexReadiness)).toBe("ready");
    const updateMenu = [LAUNCH_ECHO, "› 1. Update now", "  2. Skip", "  Press enter to continue"].join("\n");
    expect(classifyStartedPane(updateMenu, codexPrompt, codexReadiness)).toBe("booting");
  });

  // ── Codex's readiness pattern (ct-49754) ─────────────────────────────────
  // The old pattern was />\s*$/, and codex paints its footer BELOW the composer,
  // so no line of a ready codex pane ends in ">". A pane sitting at a live
  // composer classified "booting" on all ten polls of a 20s probe and stayed
  // that way for the full 120s budget, so the session never bound by readiness.
  test("codex's real ready frame reads ready", () => {
    expect(classifyStartedPane(CODEX_READY_PANE, codexPrompt, codexReadiness)).toBe("ready");
    // The defect itself: the frame that must read ready has no line ending in ">".
    expect(/>\s*$/.test(CODEX_READY_PANE)).toBe(false);
  });

  test("the composer alone is not ready until the footer paints below it", () => {
    // Codex paints the glyph first and the footer after — 218ms to 1561ms apart
    // over three cold boots — so the footer is what says the frame is finished
    // rather than half drawn. Codex changes no terminal mode between the shell
    // and a live composer, so this ordering is the only evidence the pane gives.
    const halfPainted = CODEX_READY_PANE.slice(0, CODEX_READY_PANE.lastIndexOf("›") + 30);
    expect(halfPainted).toContain("› Ask Codex to do anything");
    expect(classifyStartedPane(halfPainted, codexPrompt, codexReadiness)).toBe("booting");
  });

  test("the footer of an earlier frame does not make a repaint ready", () => {
    // Codex repaints its whole header during a boot, so a capture can hold a
    // finished frame above a half-painted one. The rule reads below the LAST
    // composer glyph, not the first, or the old frame's footer would answer for
    // the new one.
    const repaint = CODEX_READY_PANE + "\n\n› Ask Codex to do anything";
    expect(classifyStartedPane(repaint, codexPrompt, codexReadiness)).toBe("booting");
  });

  // ── Terminal-mode rules (ct-49538) ───────────────────────────────────────
  // grok and opencode both run full screen and hide the cursor while they load,
  // then show it again on the frame their composer goes live. Those are facts
  // the client told the terminal, so unlike a screen scrape they cannot be
  // faked by a shell that happens to paint the same characters.
  test("grok's ❯ counts only on the alternate screen", () => {
    const grokPrompt = AGENT_CLIENTS.grok.promptReadyPattern;
    const grokReadiness = AGENT_CLIENTS.grok.paneReadiness;
    const pane = LAUNCH_ECHO + "\n│ ❯ \nShift+Tab:mode  │  Ctrl+x:shortcuts";
    expect(classifyStartedPane(pane, grokPrompt, grokReadiness, { alternateScreen: true, cursorVisible: true })).toBe("ready");
    // The same characters on the primary screen are a shell prompt (starship,
    // pure and agnoster all render ❯), never grok: measured, grok took the
    // alternate screen 1.5s before its own ❯ painted.
    expect(classifyStartedPane(pane, grokPrompt, grokReadiness, { alternateScreen: false, cursorVisible: true })).toBe("booting");
  });

  test("opencode's footer counts only once it shows the cursor again", () => {
    const ocPrompt = AGENT_CLIENTS.opencode.promptReadyPattern;
    const ocReadiness = AGENT_CLIENTS.opencode.paneReadiness;
    const pane = LAUNCH_ECHO + "\n┃  Ask anything...\ntab agents  ctrl+p commands";
    expect(classifyStartedPane(pane, ocPrompt, ocReadiness, { alternateScreen: true, cursorVisible: true })).toBe("ready");
    // Cursor still hidden: opencode is painting, not listening. Measured window
    // between the two: 5.7s.
    expect(classifyStartedPane(pane, ocPrompt, ocReadiness, { alternateScreen: true, cursorVisible: false })).toBe("booting");
  });

  test("a mode a caller could not read is not a satisfied one", () => {
    // tmux failed to answer, so the pane keeps polling rather than being called
    // ready on a rule nobody checked. The caller's budget bounds the wait.
    const grok = AGENT_CLIENTS.grok;
    const pane = LAUNCH_ECHO + "\n│ ❯ ";
    expect(classifyStartedPane(pane, grok.promptReadyPattern, grok.paneReadiness, undefined)).toBe("booting");
    // With no rule at all the pattern alone still decides, as it did before.
    expect(classifyStartedPane(pane, grok.promptReadyPattern)).toBe("ready");
  });

  test("claude keeps the pattern alone", () => {
    // Claude hides its cursor when ready and never leaves the primary screen, so
    // neither mode says anything about it. It carries no readiness rule and its
    // verdict is the pattern, exactly as before.
    expect(AGENT_CLIENTS.claude.paneReadiness).toBeUndefined();
    expect(classifyStartedPane(LAUNCH_ECHO + "\n❯ ", claudePrompt, AGENT_CLIENTS.claude.paneReadiness)).toBe("ready");
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
    expect(delivery).toContain("probeStartedPane(entry, isMachineDeliveredMessage(content) ? assertMachinePromptAbsent : undefined)");
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
