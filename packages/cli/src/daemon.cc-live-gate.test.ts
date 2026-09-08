// The daemon half of the OAuth refresh gate (ct-49526): which tmux panes count
// as a live claude, and that the refresh really is behind the gate rather than
// beside it.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import { parseLiveClaudeSessions } from "./daemon.js";

describe("parseLiveClaudeSessions", () => {
  it("takes the claude panes and their account stamps", () => {
    const rows = [
      "cc-claude-abc|claude|",
      "cc-claude-pinned|claude|work",
      "cc-codex-def|codex|",
      "cc-resume-claude-xyz|claude|",
    ].join("\n");
    expect(parseLiveClaudeSessions(rows)).toEqual([
      { id: "cc-claude-abc" },
      { id: "cc-claude-pinned", account: "work" },
      { id: "cc-resume-claude-xyz" },
    ]);
  });

  // A tmux too old to expand `#{@opt}` hands the placeholder back verbatim.
  // Reading that as an account name would attribute the pane to a profile
  // called "#{@codecast_cc_account}"; reading it as an agent type would drop
  // the pane. Both read as "not stamped", so an unstamped pane is skipped
  // rather than misattributed.
  it("treats an unexpanded tmux placeholder as no stamp at all", () => {
    expect(parseLiveClaudeSessions("cc-claude-abc|#{@codecast_agent_type}|#{@codecast_cc_account}")).toEqual([]);
    expect(parseLiveClaudeSessions("cc-claude-abc|claude|#{@codecast_cc_account}")).toEqual([
      { id: "cc-claude-abc" },
    ]);
  });

  it("keeps a session name that contains the field separator", () => {
    expect(parseLiveClaudeSessions("weird|name|claude|work")).toEqual([
      { id: "weird|name", account: "work" },
    ]);
  });

  it("ignores blank output and rows with too few fields", () => {
    expect(parseLiveClaudeSessions("")).toEqual([]);
    expect(parseLiveClaudeSessions("just-a-name\n\ncc-claude-a|claude")).toEqual([]);
  });
});

describe("maintainActiveCcToken", () => {
  const body = functionBlock(readFileSync(new URL("./daemon.ts", import.meta.url), "utf8"), "maintainActiveCcToken").text;

  // The gate is only a gate if the refresh sits behind it. A refresh that ran
  // beside the check would rotate the single-use refresh token out from under a
  // running claude exactly as before.
  it("reconciles the gate, then refreshes only when nothing holds the credential", () => {
    const reconcileAt = body.indexOf("await reconcileLiveClaudeGate()");
    const gateAt = body.indexOf("hasLiveClaudeOnActiveCredential()");
    const refreshAt = body.indexOf("await refreshActiveCredential()");
    expect(reconcileAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(reconcileAt);
    expect(refreshAt).toBeGreaterThan(gateAt);
    // The refresh is in the else branch of the gate check, not after it.
    expect(body.slice(gateAt, refreshAt)).toContain("} else {");
  });

  // The read back. When the gate defers, this is the only thing that folds the
  // rotation a live claude performed into its saved profile.
  it("always re-snapshots, deferred or not, and reports a refusal", () => {
    expect(body).toContain("await resnapshotIfActiveFresher({ warn:");
    const gateAt = body.indexOf("hasLiveClaudeOnActiveCredential()");
    expect(body.indexOf("resnapshotIfActiveFresher")).toBeGreaterThan(gateAt);
  });

  // Remotes run a pushed COPY of this credential; rotating it there invalidates
  // the primary's. The live gate is a second condition, never a replacement.
  it("keeps the remote device gate", () => {
    expect(body).toContain("if (isRemoteDevice() || ccTokenMaintInFlight) return;");
  });
});
