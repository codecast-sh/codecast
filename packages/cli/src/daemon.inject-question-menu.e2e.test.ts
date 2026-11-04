import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux } from "./daemon.js";
import { shellQuote, spawnHarness, waitFor } from "./test-helpers/messagingHarness.js";

// Alex Green, 2026-10-25 and 2026-10-31: a session asked a multiple-choice
// question, he typed his answer instead of picking a card option, and every
// message after it ("?", "You still there", "Update", "Latest?") was held
// behind the open menu, once for 17 hours.

afterAll(killIsolatedTmuxServer);

function menuPane() {
  const cwd = mkdtempSync(join(tmpdir(), "codecast-question-menu-"));
  const statePath = join(cwd, "state.json");
  const fixture = fileURLToPath(new URL("./test-helpers/questionMenuTui.ts", import.meta.url));
  const pane = spawnHarness({ cwd, jsonlPath: statePath, command: `exec bun ${[fixture, statePath].map(shellQuote).join(" ")}` });
  const state = (): { menuOpen: boolean; declined: number; picked: string[]; delivered: string[] } => JSON.parse(readFileSync(statePath, "utf8"));
  return { pane, state, target: `${pane.tmuxSession}:0.0`, done: () => { pane.tearDown(); rmSync(cwd, { recursive: true, force: true }); } };
}

test.skipIf(!Bun.which("tmux"))("a person's typed message answers the open question as free text", async () => {
  const { pane, state, target, done } = menuPane();
  try {
    await waitFor(() => pane.capturePane().includes("Esc to cancel"));
    await injectViaTmux(target, "Sorry typo I meant do all your suggestions", "claude");
    await waitFor(() => state().delivered.length > 0);
    expect(state()).toEqual({ menuOpen: false, declined: 1, picked: [], delivered: ["Sorry typo I meant do all your suggestions"] });
  } finally {
    done();
  }
}, 60_000);

test.skipIf(!Bun.which("tmux"))("typed text that names an option picks it", async () => {
  const { pane, state, target, done } = menuPane();
  try {
    await waitFor(() => pane.capturePane().includes("Esc to cancel"));
    await injectViaTmux(target, "Both: cap 2 + slow tier", "claude");
    await waitFor(() => state().picked.length > 0);
    expect(state()).toMatchObject({ declined: 0, picked: ["3"], delivered: [] });
  } finally {
    done();
  }
}, 60_000);

test.skipIf(!Bun.which("tmux"))("a session's message still waits for the person's answer", async () => {
  const { pane, state, target, done } = menuPane();
  try {
    await waitFor(() => pane.capturePane().includes("Esc to cancel"));
    await expect(injectViaTmux(target, '<session-message from="jx76d3d">\nporter run 4 report\n</session-message>', "claude")).rejects.toThrow(/waiting for a human answer/);
    expect(state()).toEqual({ menuOpen: true, declined: 0, picked: [], delivered: [] });
  } finally {
    done();
  }
}, 60_000);
