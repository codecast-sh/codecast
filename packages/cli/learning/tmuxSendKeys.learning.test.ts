// tmux's argument parser ends a command at an argument whose last character is
// an unescaped `;` and drops that character, so `send-keys -l 'abc;'` types
// `abc`. Typed delivery lost every `;` at a 128-char chunk boundary and re-typed
// one trigger message five times (jx7b88a, 2026-10-05). The fix is
// tmuxLiteralArg in src/tmuxPaste.ts; if this test fails, tmux changed and that
// escape may now type a stray backslash.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmuxLiteralArg } from "../src/tmuxPaste.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const socket = `cc-learning-${process.pid}`;
const tmux = (...args: string[]) => spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });

async function typed(text: string): Promise<string> {
  tmux("send-keys", "-t", "learn", "C-u");
  tmux("send-keys", "-t", "learn", "-l", text);
  await Bun.sleep(150);
  return tmux("capture-pane", "-p", "-t", "learn").stdout.split("\n")[0].trimEnd();
}

describe.skipIf(!hasTmux)("tmux send-keys -l", () => {
  beforeAll(() => {
    // A pane whose line discipline echoes what is typed; C-u erases the line.
    tmux("new-session", "-d", "-s", "learn", "-x", "120", "-y", "5", "cat >/dev/null");
  });
  afterAll(() => { tmux("kill-server"); });

  test("drops a trailing unescaped ;", async () => {
    expect(await typed("abc;")).toBe("abc");
  });

  test("keeps a ; that is not last", async () => {
    expect(await typed("a;bc")).toBe("a;bc");
  });

  test("tmuxLiteralArg's escaped form types the ;", async () => {
    expect(await typed(tmuxLiteralArg("abc;"))).toBe("abc;");
  });
});
