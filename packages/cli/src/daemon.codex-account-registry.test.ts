// The daemon half of the Codex account registry (ct-49528): every path that
// starts a Codex process records the account it started on, the teardown path
// releases it, and the tick that names stale panes reconciles against tmux
// first. Source-level, like the Claude gate's daemon test: importing daemon.ts
// boots half the world, and what these guard against is a launch path added
// later without the record — a pane nobody can attribute, silently.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { codeLines, functionBlock } from "./test-helpers/sourceRegion.js";

const src = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

describe("codex panes record the account they launched on", () => {
  it("stamps at every path that starts a codex process", () => {
    // Each new-session lands one stamp: start_session, the blank/fresh start,
    // and the auto-resume (a resume is a new process reading auth.json afresh).
    const calls = codeLines(src).filter(({ line }) => line.includes("stampCodexPaneAccount("));
    // Three call sites plus the declaration.
    expect(calls.length).toBe(4);
    for (const anchor of [
      "await stampCodexPaneAccount(agentType, tmuxSession, conversationId);",
      "await stampCodexPaneAccount(blankAgentType, tmuxSession, conversationId);",
    ]) {
      expect(src).toContain(anchor);
    }
  });

  it("writes all three copies of the fact, and only for codex", () => {
    const body = functionBlock(src, "stampCodexPaneAccount").text;
    expect(body).toContain('if (agentType !== "codex") return;');
    expect(body).toContain('setTmuxSessionOption(tmuxSession, "@codecast_codex_account", account)');
    expect(body).toContain("markCodexPaneLive(tmuxSession, { account, conversationId })");
    expect(body).toContain("recordCodexAccount(conversationId, account)");
    // An account we cannot name is still registered — unattributed, so the
    // staleness check leaves the pane alone instead of ordering a restart.
    const markAt = body.indexOf("markCodexPaneLive");
    const guardAt = body.indexOf("if (account) {");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(markAt).toBeGreaterThan(guardAt);
  });

  it("releases the pane where the session is actually torn down", () => {
    const body = functionBlock(src, "killTmuxSessionAndTree").text;
    expect(body).toContain("markCodexPaneEnded(tmuxSession)");
  });
});

describe("naming the stale panes", () => {
  const body = functionBlock(src, "maintainCodexUsageSnapshot").text;

  // Naming stale panes from a registry that has not been reconciled would
  // report panes that died while the daemon was down, and miss ones a previous
  // build started.
  it("reconciles against tmux before it judges anything", () => {
    const reconcileAt = body.indexOf("await reconcileCodexPaneRegistry()");
    const noteAt = body.indexOf("noteStaleCodexPanes()");
    expect(reconcileAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeGreaterThan(reconcileAt);
  });

  // A corrupt profile index would otherwise take the usage refresh down with
  // the note, and a condition nobody has fixed yet would reprint every tick.
  it("never lets the note cost the refresh, and never repeats itself", () => {
    const note = functionBlock(src, "noteStaleCodexPanes").text;
    expect(note).toContain("staleCodexPanes(activeCodexProfileName())");
    expect(note).toContain("if (note === lastStaleCodexNote) return;");
    expect(note).toMatch(/catch \{\s*return;/);
  });

  // A tmux that could not be reached is not evidence of an empty machine.
  it("only adopts an empty list when tmux says it has no server", () => {
    const reconcile = functionBlock(src, "reconcileCodexPaneRegistry").text;
    expect(reconcile).toContain("if (!/no server running|no such file or directory/i.test(msg)) return;");
    expect(reconcile).toContain("reconcileCodexPanes(parseCodexPaneRows(stdout, REAP_FIELD_SEP))");
  });

  it("restores the registry at daemon start, before the first reconcile runs", () => {
    expect(src).toContain("seedCodexPanes()");
    const seedAt = src.indexOf("seedCodexPanes()\n");
    const tickAt = src.indexOf('maintainCodexUsageSnapshot("daemon start")');
    expect(seedAt).toBeGreaterThanOrEqual(0);
    expect(tickAt).toBeGreaterThanOrEqual(0);
  });
});
