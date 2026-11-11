import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux, setSyncServiceForTests } from "./daemon.js";
import type { SyncService } from "./syncService.js";
import { prepareTmuxDelivery, TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
import { DeliveryEchoLedger } from "./deliveryEchoLedger.js";
import { tmuxRun } from "./tmux.js";
import { shellQuote, spawnHarness, waitFor } from "./test-helpers/messagingHarness.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";

// The delivery echo ledger these deliveries record into lives in CODECAST_DIR.
const codecastDir = isolateCodecastDir();

afterAll(() => codecastDir.restore());
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
  const delivery = { messageId: "same-pending-message", conversationId: "fixture-same-pending-message" };
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
  const delivery = { messageId: "pending-after-exit", conversationId: "fixture-pending-after-exit" };
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
  const delivery = { messageId: "lost-paste", conversationId: "fixture-lost-paste" };
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

// 2026-10-26: an agent at background priority on an overloaded Mac got no CPU
// for 80 minutes. Its stale frame never showed the write, so each settled
// receipt wrote "continue" again, and the agent woke to
// "continuecontinuecontinue". A fixture holding its input unread stands in.
test.skipIf(!Bun.which("tmux"))("a starved agent keeps the one write it was given and takes it when it wakes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-starved-pane-"));
  const statePath = join(cwd, "state.json");
  const release = join(cwd, "release");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude", release].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "starved-pane", conversationId: "fixture-starved-pane" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    // The earlier attempt's write, still unread in the agent's terminal.
    const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout });
    const prepared = await prepareTmuxDelivery(target, delivery, exec, async () => false, journal);
    journal.begin(delivery, prepared.generation, "continue");
    tmuxRun(["send-keys", "-t", target, "-l", "continue"]);
    await expect(injectViaTmux(target, "continue", "claude", {
      delivery, journal, gateBudgetMs: 500, receiptSettleMs: 0, agentStarved: async () => true,
    })).rejects.toThrow("getting no CPU");
    expect(journal.writesOf(delivery.messageId)).toBe(1);
    writeFileSync(release, "ready");
    await waitFor(() => pane.capturePane().includes("❯ continue"));
    await injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 5_000, receiptSettleMs: 0 });
    expect(state().queued).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
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
  const delivery = { messageId: "false-verify", conversationId: "fixture-false-verify" };
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
    await injectViaTmux(target, "continue", "claude", { delivery, journal, gateBudgetMs: 500, receiptSettleMs: 0, readTranscript: async () => "" });
    expect(state().delivered).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);


test.skipIf(!Bun.which("tmux")).each(["submit", "verified"] as const)("an idle pane with a %s receipt and an unsynced transcript never repeats the send", async phase => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-unsynced-delivery-"));
  const statePath = join(cwd, "state.json");
  const finish = join(cwd, "finish");
  const transcriptPath = join(cwd, "transcript.jsonl");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, finish, "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journalPath = join(cwd, "delivery.sqlite");
  let journal = new TmuxDeliveryJournal(journalPath);
  const delivery = { messageId: `unsynced-message-${phase}`, conversationId: `fixture-unsynced-${phase}` };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const readTranscript = async () => readFileSync(transcriptPath, "utf8");
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await injectViaTmux(target, "continue", "claude", { delivery, journal });
    expect(state().queued).toEqual(["Existing worker report.", "continue"]);
    const original = journal.get(delivery.messageId)!;
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", uuid: "echo", timestamp: new Date().toISOString(), message: { role: "user", content: "continue" } }) + "\n");
    if (phase === "submit") {
      journal.release(delivery.messageId);
      journal.begin(delivery, original.generation, "continue");
      journal.advance(delivery.messageId, "submit");
      writeFileSync(transcriptPath, JSON.stringify({ type: "user", uuid: "echo", timestamp: new Date().toISOString(), message: { role: "user", content: "continue" } }) + "\n");
    }
    writeFileSync(finish, "done");
    await waitFor(() => !state().active);
    journal.close();
    journal = new TmuxDeliveryJournal(journalPath);
    // The daemon that reconciles has no ledger record of the send (it was
    // upgraded, or another one typed it): the receipt alone must stop a repeat.
    const echoes = new DeliveryEchoLedger(join(cwd, "fresh-echoes.sqlite"));
    await expect(injectViaTmux(target, "continue", "claude", { delivery, journal, echoes, receiptSettleMs: 0,
      readTranscript: async () => { throw new Error("transcript unavailable"); } })).rejects.toThrow("cannot reconcile");
    for (let attempt = 0; attempt < 3; attempt++) {
      await injectViaTmux(target, "continue", "claude", { delivery, journal, echoes, receiptSettleMs: 0, readTranscript });
    }
    expect(state().delivered).toEqual(["Existing worker report.", "continue"]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await injectViaTmux(target, "continue", "claude", { delivery: { ...delivery, messageId: `intentional-repeat-${phase}` }, journal });
    expect(state().delivered).toEqual(["Existing worker report.", "continue", "continue"]);
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// 2026-11-06, jx751p3: on a starved client the message rendered in the
// composer and every Enter was lost. The submit window closed, the delivery
// reported success with the text still at the prompt, nothing retried it, and
// its receipt refused the pane to every later message for 12 hours.
test.skipIf(!Bun.which("tmux"))("a payload left in the composer after the submit window stays pending, and its retry submits it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-deaf-enter-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude-deaf"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const payload = "deaf-enter check: carry on with the plan";
  const delivery = { messageId: "unsubmitted", conversationId: "fixture-unsubmitted" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await expect(injectViaTmux(target, payload, "claude", { delivery, journal })).rejects.toThrow("still in the composer");
    expect(state().queued).toEqual(["Existing worker report."]);
    await expect(injectViaTmux(target, "next message", "claude", { delivery: { ...delivery, messageId: "next" }, journal, gateBudgetMs: 500 })).rejects.toThrow("earlier message");
    writeFileSync(`${statePath}.hear`, "");
    await injectViaTmux(target, payload, "claude", { delivery, journal });
    expect(state().queued).toEqual(["Existing worker report.", payload]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// jx78ys8, 2026-10-30: "/mcp" sent from a phone opened Claude Code's MCP panel.
// The panel read as a dialog waiting for a human, so the message was held as
// undelivered although it had run, and every later message queued behind it
// for 53 minutes. Once the panel was closed, the receipt had settled with no
// transcript echo (a local command writes none), so "/mcp" was typed again and
// the panel came back.
test.skipIf(!Bun.which("tmux"))("a slash command that opens a panel is delivered once and never typed again", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-slash-panel-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "slash-mcp", conversationId: "fixture" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await injectViaTmux(target, "/mcp", "claude", { delivery, journal });
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await waitFor(() => pane.capturePane().includes("⏺ Done."));
    tmuxRun(["send-keys", "-t", target, "Escape"]);
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await injectViaTmux(target, "/mcp", "claude", { delivery, journal, receiptSettleMs: 0, readTranscript: async () => "" });
    await injectViaTmux(target, "next message", "claude", { delivery: { ...delivery, messageId: "next" }, journal });
    expect(state()).toMatchObject({ commands: ["/mcp"], panelKeys: 0, queued: ["Existing worker report.", "next message"] });
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// #81 review: a verified panel command the server never acknowledged returned
// without telling the server, so the row stayed injected and every retry
// returned the same way. It is final, so the server hears it was delivered.
test.skipIf(!Bun.which("tmux"))("a verified panel command the server never acknowledged is marked delivered", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-slash-unacked-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "unacked-mcp", conversationId: "fixture" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const writes: { messageId: string; status: string }[] = [];
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    await injectViaTmux(target, "/mcp", "claude", { delivery, journal });
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await waitFor(() => pane.capturePane().includes("⏺ Done."));
    tmuxRun(["send-keys", "-t", target, "Escape"]);
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    setSyncServiceForTests({
      getPendingMessageStatus: async () => writes.length ? "delivered" : "injected",
      updateMessageStatus: async ({ messageId, status }: { messageId: string; status: string }) => { writes.push({ messageId, status }); },
    } as unknown as SyncService);
    await injectViaTmux(target, "/mcp", "claude", { delivery, journal, receiptSettleMs: 0, readTranscript: async () => "" });
    expect(writes).toEqual([{ messageId: delivery.messageId, status: "delivered" }]);
    expect(state()).toMatchObject({ commands: ["/mcp"], panelKeys: 0 });
  } finally {
    setSyncServiceForTests(null);
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

// The same incident from a receipt an earlier attempt left at "submit": the
// panel is still open and its command is gone from the composer, so the
// command ran. Holding for the panel would block the queue behind it.
test.skipIf(!Bun.which("tmux"))("a submitted slash command whose panel is still open counts as delivered", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-slash-held-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const journal = new TmuxDeliveryJournal(join(cwd, "delivery.sqlite"));
  const delivery = { messageId: "held-mcp", conversationId: "fixture" };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout });
    const prepared = await prepareTmuxDelivery(target, delivery, exec, async () => false, journal);
    journal.begin(delivery, prepared.generation, "/mcp");
    journal.advance(delivery.messageId, "submit");
    tmuxRun(["send-keys", "-t", target, "-l", "/mcp"]);
    tmuxRun(["send-keys", "-t", target, "Enter"]);
    await waitFor(() => pane.capturePane().includes("⏺ Done."));
    await injectViaTmux(target, "/mcp", "claude", { delivery, journal, receiptSettleMs: 0, readTranscript: async () => "" });
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    expect(state()).toMatchObject({ commands: ["/mcp"], panelKeys: 0 });
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);
