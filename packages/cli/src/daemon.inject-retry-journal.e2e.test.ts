import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux } from "./daemon.js";
import { TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
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

test.skipIf(!Bun.which("tmux"))("an exited agent's failed delivery resumes in a replacement pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-exited-journal-"));
  const failedCwd = join(cwd, "failed");
  const replacementCwd = join(cwd, "replacement");
  mkdirSync(failedCwd);
  mkdirSync(replacementCwd);
  const statePath = join(cwd, "state.json");
  const failedFixture = fileURLToPath(new URL("./test-helpers/tmuxExitAfterSubmit.ts", import.meta.url));
  let pane = spawnHarness({ cwd: failedCwd, jsonlPath: statePath, command: `tmux set-option -p remain-on-exit on && exec bun ${shellQuote(failedFixture)}` });
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "pending-after-exit", conversationId: "fixture" };
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await expect(injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude", { delivery, journal })).rejects.toThrow("SESSION_EXITED");
    expect(journal.get(delivery.messageId)?.terminalExited).toBe(1);
    await expect(injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude", { delivery, journal })).rejects.toThrow("exited terminal");
    pane.tearDown();
    const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
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
