import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux } from "./daemon.js";
import { prepareTmuxDelivery, TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
import { tmuxRun } from "./tmux.js";
import { shellQuote, spawnHarness, waitFor } from "./test-helpers/messagingHarness.js";

afterAll(killIsolatedTmuxServer);

test.skipIf(!Bun.which("tmux"))("a process exit and repeated delivery timeouts resume one buffered paste", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-retry-journal-"));
  const statePath = join(cwd, "state.json");
  const release = join(cwd, "release");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude", release].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const path = join(cwd, "delivery.sqlite");
  let journal = new TmuxDeliveryJournal(path);
  const delivery = { messageId: "same-pending-message", conversationId: "fixture" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    const crashFixture = fileURLToPath(new URL("./test-helpers/crashAfterTmuxPaste.ts", import.meta.url));
    const crashed = Bun.spawn([process.execPath, crashFixture, target, path, delivery.messageId, delivery.conversationId, "continue"], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const error = await new Response(crashed.stderr).text();
    expect({ code: await crashed.exited, error }).toEqual({ code: 86, error: "" });
    await expect(injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500 })).rejects.toThrow("AGENT_STDIN_NOT_READY");
    expect(journal.get(delivery.messageId)?.phase).toBe("paste");
    journal.close();
    journal = new TmuxDeliveryJournal(path);
    await expect(injectViaTmux(target, "next message", "claude", {
      delivery: { ...delivery, messageId: "next" }, journal, gateBudgetMs: 500,
    })).rejects.toThrow("earlier message");
    await expect(injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500 })).rejects.toThrow("AGENT_STDIN_NOT_READY");
    writeFileSync(release, "ready");
    await waitFor(() => pane.capturePane().includes("❯ continue"));
    await injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 5_000 });
    expect(state()).toEqual({ active: true, interrupts: 0, queued: ["Existing worker report.", "continue"], delivered: [] });
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await injectViaTmux(target, "continue", "claude", { delivery, journal });
    expect(state().queued).toEqual(["Existing worker report.", "continue"]);
    await injectViaTmux(target, "continue", "claude", { delivery: { ...delivery, messageId: "next" }, journal });
    expect(state().queued).toEqual(["Existing worker report.", "continue", "continue"]);
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!Bun.which("tmux")).each(["exited", "buffered"] as const)("a %s delivery resumes in a replacement pane", async mode => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-exited-journal-"));
  const failedCwd = join(cwd, "failed");
  const replacementCwd = join(cwd, "replacement");
  mkdirSync(failedCwd);
  mkdirSync(replacementCwd);
  const statePath = join(cwd, "state.json");
  const failedFixture = fileURLToPath(new URL("./test-helpers/tmuxExitAfterSubmit.ts", import.meta.url));
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  let pane = spawnHarness({ cwd: failedCwd, jsonlPath: statePath, command: mode === "exited"
    ? `tmux set-option -p remain-on-exit on && exec bun ${shellQuote(failedFixture)}`
    : `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude", join(cwd, "release")].map(shellQuote).join(" ")}` });
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "pending-after-exit", conversationId: "fixture" };
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await expect(injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude", { delivery, journal, gateBudgetMs: 500 })).rejects.toThrow(mode === "exited" ? "SESSION_EXITED" : "AGENT_STDIN_NOT_READY");
    if (mode === "exited") {
      expect(journal.get(delivery.messageId)?.terminalExited).toBe(1);
      await expect(injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude", { delivery, journal })).rejects.toThrow("exited terminal");
    }
    pane.tearDown();
    pane = spawnHarness({ cwd: replacementCwd, jsonlPath: statePath,
      command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude"].map(shellQuote).join(" ")}` });
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude", { delivery, journal });
    expect(JSON.parse(readFileSync(statePath, "utf8")).queued).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// 2026-09-14: a paste written under load never reached the composer. Every
// retry refused to paste again and every later message was refused the pane,
// so the session took nothing for hours while the card kept cycling.
test.skipIf(!Bun.which("tmux"))("a paste that never reached the prompt is pasted again once its receipt settles, and frees the pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-lost-paste-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "lost-paste", conversationId: "fixture" };
  const next = { ...delivery, messageId: "next" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout });
    const prepared = await prepareTmuxDelivery(target, delivery, exec, async () => false, journal);
    journal.begin(delivery, prepared.generation, "continue");
    // Something else sits at the prompt, as a suggestion or a draft did in the incident.
    tmuxRun(["send-keys", "-t", target, "-l", "draft"]);
    await waitFor(() => pane.capturePane().includes("❯ draft"));
    await expect(injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500 })).rejects.toThrow(/INJECT_UNVERIFIED|AGENT_STDIN_NOT_READY/);
    await expect(injectViaTmux(target, "next message", "claude", { delivery: next, journal, gateBudgetMs: 500 })).rejects.toThrow("earlier message");
    expect(journal.get(delivery.messageId)?.phase).toBe("paste");
    await injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500, receiptSettleMs: 0 });
    expect(state().queued).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await injectViaTmux(target, "next message", "claude", { delivery: next, journal });
    expect(state().queued).toEqual(["Existing worker report.", "continue", "next message"]);
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// The same incident's other half: the verifier recorded a message as taken
// while the pane never ran a turn, so every retry skipped the paste and
// reported success. An idle agent and no echo after the settle window prove
// the message is not there.
test.skipIf(!Bun.which("tmux"))("a verification the server never acknowledged is pasted again once the agent is idle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-false-verify-"));
  const statePath = join(cwd, "state.json");
  const finish = join(cwd, "finish");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, finish, "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "false-verify", conversationId: "fixture" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout });
    const prepared = await prepareTmuxDelivery(target, delivery, exec, async () => false, journal);
    journal.begin(delivery, prepared.generation, "continue");
    journal.advance(delivery.messageId, "verified");
    // Inside the window a verified receipt is trusted: nothing is written.
    await injectViaTmux(target, "continue", "claude", { delivery, journal });
    expect(state().queued).toEqual(["Existing worker report."]);
    writeFileSync(finish, "done");
    await waitFor(() => !state().active);
    await injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500, receiptSettleMs: 0 });
    expect(state().delivered).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);
