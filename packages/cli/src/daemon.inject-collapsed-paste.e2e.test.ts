import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux } from "./daemon.js";
import { TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
import { shellQuote, spawnHarness, waitFor } from "./test-helpers/messagingHarness.js";

afterAll(killIsolatedTmuxServer);

test.skipIf(!Bun.which("tmux")).each(["fresh", "retry"] as const)("%s single-line collapsed paste submits once and frees the next message", async mode => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-collapsed-paste-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude-collapsed"].map(shellQuote).join(" ")}` });
  const target = `${pane.tmuxSession}:0.0`;
  const path = join(cwd, "delivery.sqlite");
  const journal = new TmuxDeliveryJournal(path);
  const delivery = { messageId: "collapsed-report", conversationId: "fixture" };
  const payload = `<session-message from="worker">${"Verified the release and its regression tests. ".repeat(25)}</session-message>`;
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    if (mode === "retry") {
      const crashFixture = fileURLToPath(new URL("./test-helpers/crashAfterTmuxPaste.ts", import.meta.url));
      const crashed = Bun.spawn([process.execPath, crashFixture, target, path, delivery.messageId, delivery.conversationId, payload], {
        env: { ...process.env }, stdout: "pipe", stderr: "pipe",
      });
      const error = await new Response(crashed.stderr).text();
      expect({ code: await crashed.exited, error }).toEqual({ code: 86, error: "" });
      await waitFor(() => pane.capturePane().includes("[Pasted text #98]"));
      expect(journal.get(delivery.messageId)?.phase).toBe("paste");
    }
    await injectViaTmux(target, payload, "claude", { delivery, journal, gateBudgetMs: 1_500 });
    expect(state().queued).toEqual(["Existing worker report.", payload]);
    expect(journal.get(delivery.messageId)?.phase).toBe("verified");
    await injectViaTmux(target, payload, "claude", { delivery, journal });
    await injectViaTmux(target, "Next message", "claude", { delivery: { ...delivery, messageId: "next" }, journal });
    expect(state().queued).toEqual(["Existing worker report.", payload, "Next message"]);
    expect(state().interrupts).toBe(0);
  } finally {
    journal.close();
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
