import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitTmuxComposerPayload, classifyTmuxLiveState, extractTmuxLiveRegion, injectViaTmux } from "./daemon.js";
import { shellQuote, spawnHarness, waitFor } from "./test-helpers/messagingHarness.js";
import { tmuxRun } from "./tmux.js";
import { pasteTextIntoPane } from "./tmuxPaste.js";

afterAll(killIsolatedTmuxServer);

test.skipIf(!Bun.which("tmux"))("Claude delivery preserves an active turn when the busy indicator is absent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-no-interrupt-"));
  const statePath = join(cwd, "state.json");
  const finishPath = join(cwd, "finish");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({
    cwd,
    jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, finishPath, "claude"].map(shellQuote).join(" ")}`,
  });
  const state = (): { active: boolean; interrupts: number; queued: string[]; delivered: string[] } => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane.capturePane()))).toBe("idle");
    expect(state().active).toBe(true);
    await injectViaTmux(`${pane.tmuxSession}:0.0`, "continue", "claude");
    expect(state()).toEqual({ active: true, interrupts: 0, queued: ["Existing worker report.", "continue"], delivered: [] });
    writeFileSync(finishPath, "ready");
    await waitFor(() => !state().active);
    expect(state().delivered).toEqual(["Existing worker report.", "continue"]);
    expect(state().interrupts).toBe(0);
  } finally {
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!Bun.which("tmux"))("a buffered continue survives footer repaints and reaches the active turn once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-buffered-paste-"));
  const statePath = join(cwd, "state.json");
  const releasePath = join(cwd, "release-input");
  const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedTui.ts", import.meta.url));
  const pane = spawnHarness({
    cwd,
    jsonlPath: statePath,
    command: `exec bun ${[fixture, statePath, join(cwd, "finish"), "claude", releasePath].map(shellQuote).join(" ")}`,
  });
  const target = `${pane.tmuxSession}:0.0`;
  const coldKeys: string[] = [];
  const exec = async (args: string[]) => {
    if (!existsSync(releasePath) && args[0] === "send-keys") coldKeys.push(args.at(-1)!);
    return { stdout: tmuxRun(args).stdout, stderr: "" };
  };
  let wake: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitFor(() => pane.capturePane().includes("shift+tab"));
    const prePaste = pane.capturePane();
    await pasteTextIntoPane(exec, target, "continue", true);
    let rePastes = 0;
    wake = setTimeout(() => writeFileSync(releasePath, "ready"), 2_500);
    expect(await awaitTmuxComposerPayload(target, "continue", {
      prePaste,
      exec,
      rePaste: async () => { rePastes++; await pasteTextIntoPane(exec, target, "continue", true); },
    })).toBe("matched");
    expect(rePastes).toBe(0);
    expect(coldKeys).toEqual([]);
    tmuxRun(["send-keys", "-t", target, "Enter"]);
    await waitFor(() => JSON.parse(readFileSync(statePath, "utf8")).queued.length === 2);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      active: true,
      interrupts: 0,
      queued: ["Existing worker report.", "continue"],
      delivered: [],
    });
  } finally {
    clearTimeout(wake);
    pane.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);
