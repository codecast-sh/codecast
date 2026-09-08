import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import {
  flushLiveClaudeGate,
  hasLiveClaudeOnActiveCredential,
  hasUnconfirmedClaudeSessions,
  liveClaudeSessions,
  markClaudeSessionEnded,
  markClaudeSessionLive,
  onLiveClaudeDrained,
  reconcileLiveClaudeSessions,
  resetLiveClaudeGate,
  seedLiveClaudeSessions,
  type LiveClaudeSession,
} from "./ccLiveGate.js";

describe("live claude gate on the OAuth refresh", () => {
  let isolated: IsolatedCodecastDir;
  const gateFile = () => path.join(isolated.dir, "cc-live-gate.json");
  const readGateFile = (): LiveClaudeSession[] =>
    JSON.parse(fs.readFileSync(gateFile(), "utf-8")).sessions;

  beforeEach(async () => {
    isolated = isolateCodecastDir("cc-live-gate-test-");
    await resetLiveClaudeGate();
  });

  afterEach(async () => {
    await resetLiveClaudeGate();
    isolated.restore();
  });

  it("holds while a claude runs on the keychain login and opens when it ends", () => {
    expect(hasLiveClaudeOnActiveCredential()).toBe(false);
    markClaudeSessionLive("cc-claude-abc");
    expect(hasLiveClaudeOnActiveCredential()).toBe(true);
    markClaudeSessionEnded("cc-claude-abc");
    expect(hasLiveClaudeOnActiveCredential()).toBe(false);
  });

  // A pinned session runs on the profile's setup-token, not on the credential
  // the daemon would rotate — it cannot be stranded by a refresh, so it must
  // not hold one off either.
  it("does not hold for a session pinned to a saved profile", () => {
    markClaudeSessionLive("cc-claude-pinned", "work");
    expect(hasLiveClaudeOnActiveCredential()).toBe(false);
    expect(liveClaudeSessions()).toEqual([{ id: "cc-claude-pinned", account: "work" }]);
  });

  it("fires the drain listener once, on the 1 to 0 transition", () => {
    let drains = 0;
    onLiveClaudeDrained(() => drains++);
    markClaudeSessionLive("cc-claude-1");
    markClaudeSessionLive("cc-claude-2");
    markClaudeSessionLive("cc-claude-pinned", "work");
    expect(drains).toBe(0);
    markClaudeSessionEnded("cc-claude-1");
    expect(drains).toBe(0); // one holder left
    markClaudeSessionEnded("cc-claude-pinned"); // never held the gate
    expect(drains).toBe(0);
    markClaudeSessionEnded("cc-claude-2");
    expect(drains).toBe(1);
    markClaudeSessionEnded("cc-claude-2"); // already gone
    expect(drains).toBe(1);
  });

  it("persists every mark so a restart can restore the gate", async () => {
    markClaudeSessionLive("cc-claude-abc");
    markClaudeSessionLive("cc-claude-pinned", "work");
    await flushLiveClaudeGate();
    expect(readGateFile()).toEqual([{ id: "cc-claude-abc" }, { id: "cc-claude-pinned", account: "work" }]);
    markClaudeSessionEnded("cc-claude-abc");
    await flushLiveClaudeGate();
    expect(readGateFile()).toEqual([{ id: "cc-claude-pinned", account: "work" }]);
  });

  // The restart the gate exists for: a claude that outlived the daemon still
  // holds the credential, and an empty in-memory set would let the first
  // maintenance tick rotate the single-use refresh token out from under it.
  it("seeds a restored session as unconfirmed and holds the gate closed on it", async () => {
    fs.writeFileSync(gateFile(), JSON.stringify({ sessions: [{ id: "cc-claude-survivor" }] }));
    const restored = await seedLiveClaudeSessions();
    expect(restored).toEqual([{ id: "cc-claude-survivor" }]);
    expect(hasUnconfirmedClaudeSessions()).toBe(true);
    expect(hasLiveClaudeOnActiveCredential()).toBe(true);
  });

  it("releases a seeded session the live tmux list no longer carries", async () => {
    fs.writeFileSync(gateFile(), JSON.stringify({ sessions: [{ id: "cc-claude-dead" }] }));
    await seedLiveClaudeSessions();
    let drains = 0;
    onLiveClaudeDrained(() => drains++);
    reconcileLiveClaudeSessions([]);
    expect(hasLiveClaudeOnActiveCredential()).toBe(false);
    expect(hasUnconfirmedClaudeSessions()).toBe(false);
    expect(drains).toBe(1);
  });

  it("keeps a seeded session the live tmux list still carries", async () => {
    fs.writeFileSync(gateFile(), JSON.stringify({ sessions: [{ id: "cc-claude-alive" }] }));
    await seedLiveClaudeSessions();
    reconcileLiveClaudeSessions([{ id: "cc-claude-alive" }]);
    expect(hasLiveClaudeOnActiveCredential()).toBe(true);
    expect(hasUnconfirmedClaudeSessions()).toBe(false);
  });

  // A pane started by an older daemon build, or by hand in tmux, holds the
  // credential just as firmly as one this process launched.
  it("adopts a live pane the gate never knew about", () => {
    reconcileLiveClaudeSessions([{ id: "cc-claude-foreign" }]);
    expect(hasLiveClaudeOnActiveCredential()).toBe(true);
    expect(liveClaudeSessions()).toEqual([{ id: "cc-claude-foreign" }]);
  });

  it("takes the account attribution from the live list", () => {
    markClaudeSessionLive("cc-claude-abc");
    expect(hasLiveClaudeOnActiveCredential()).toBe(true);
    // The pane's own stamp says it runs on a profile's setup-token after all.
    reconcileLiveClaudeSessions([{ id: "cc-claude-abc", account: "work" }]);
    expect(hasLiveClaudeOnActiveCredential()).toBe(false);
    expect(liveClaudeSessions()).toEqual([{ id: "cc-claude-abc", account: "work" }]);
  });

  it("drops every id the live list omits", async () => {
    markClaudeSessionLive("cc-claude-1");
    markClaudeSessionLive("cc-claude-2");
    reconcileLiveClaudeSessions([{ id: "cc-claude-2" }]);
    expect(liveClaudeSessions()).toEqual([{ id: "cc-claude-2" }]);
    await flushLiveClaudeGate();
    expect(readGateFile()).toEqual([{ id: "cc-claude-2" }]);
  });

  it("ignores a malformed gate file rather than throwing at startup", async () => {
    fs.writeFileSync(gateFile(), "{not json");
    expect(await seedLiveClaudeSessions()).toEqual([]);
    fs.writeFileSync(gateFile(), JSON.stringify({ sessions: [{ nope: 1 }, { id: "" }, { id: "ok" }] }));
    expect(await seedLiveClaudeSessions()).toEqual([{ id: "ok" }]);
  });
});
