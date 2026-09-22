/**
 * The machine-wide limits behind launching Chrome and waking the extension:
 * every session's verbs walk the same ladder, and a dead worker must not
 * mean one wake tab per session per command.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import { chromeLaunchCommand, takeStamp, takeWake, WAKE_MIN_GAP_MS, WAKE_ONCE_MS } from "./realChrome.js";

let isolation: IsolatedCodecastDir;

test("macOS launches Chrome through Launch Services with a fresh default-profile process", () => {
  const args = ["--disable-renderer-backgrounding", "--restore-last-session", "file:///private/tmp/pair.html"];
  expect(chromeLaunchCommand("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args, "darwin")).toEqual({
    command: "/usr/bin/open",
    args: ["-n", "-g", "-a", "/Applications/Google Chrome.app", "--args", ...args],
  });
});

test("non-bundle and non-macOS Chrome launches retain their executable and arguments", () => {
  expect(chromeLaunchCommand("/usr/bin/chromium", ["--restore-last-session"], "linux")).toEqual({ command: "/usr/bin/chromium", args: ["--restore-last-session"] });
  expect(chromeLaunchCommand("/tmp/chromium", [], "darwin")).toEqual({ command: "/tmp/chromium", args: [] });
});

beforeEach(() => {
  isolation = isolateCodecastDir("real-chrome-test-");
});
afterEach(() => {
  isolation.restore();
});

test("one wake per outage: the same outage never gets a second, a reconnect opens the next", async () => {
  const t0 = 1_000_000;
  expect(await takeWake("seen:100", t0)).toBe(true);
  // Same outage, any time later: no.
  expect(await takeWake("seen:100", t0 + 1_000)).toBe(false);
  expect(await takeWake("seen:100", t0 + 3 * WAKE_ONCE_MS)).toBe(false);
  // A new outage (the extension reconnected in between, then dropped again),
  // but inside the minimum gap since the last wake: not yet. A worker that
  // dies every minute must not earn a wake tab every minute.
  expect(await takeWake("seen:200", t0 + WAKE_ONCE_MS)).toBe(false);
  expect(await takeWake("seen:200", t0 + WAKE_MIN_GAP_MS - 1)).toBe(false);
  expect(await takeWake("seen:200", t0 + WAKE_MIN_GAP_MS)).toBe(true);
  expect(await takeWake("seen:200", t0 + 2 * WAKE_MIN_GAP_MS)).toBe(false);
});

test("a wake stamp written ahead of now is a hold (the manual kill switch)", async () => {
  const t0 = 1_000_000;
  expect(await takeWake("seen:1", t0 + 10 * WAKE_MIN_GAP_MS)).toBe(true);
  expect(await takeWake("seen:2", t0)).toBe(false);
});

test("a launch is taken once per window", async () => {
  const t0 = 1_000_000;
  expect(await takeStamp("launchedAt", 60_000, t0)).toBe(true);
  expect(await takeStamp("launchedAt", 60_000, t0 + 59_999)).toBe(false);
  expect(await takeStamp("launchedAt", 60_000, t0 + 60_000)).toBe(true);
});

test("six processes claiming the same outage at once: exactly one wins", async () => {
  // The real shape of the race: separate CLI processes, one stamp file. Every
  // child sleeps until one wall-clock instant the parent chose (a common
  // barrier, whatever each bun's boot time is), and the claim's read-to-write
  // window is widened to 400 ms through the test seam, so without the lock
  // every child reads the empty stamp before any writes it and all six answer
  // true. Under the lock the claims serialize and exactly one wins.
  const at = Date.now() + 5_000;
  const script = `
    import { takeWake } from ${JSON.stringify(path.join(import.meta.dir, "realChrome.ts"))};
    await new Promise((r) => setTimeout(r, Math.max(0, ${at} - Date.now())));
    console.log(String(await takeWake("seen:race")));
  `;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, CODECAST_DIR: isolation.dir, CAST_REAL_CHROME_CLAIM_DELAY_MS: "400" },
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const answers = await Promise.all(children.map(async (c) => (await new Response(c.stdout).text()).trim()));
  expect(answers.filter((a) => a === "true")).toHaveLength(1);
  expect(answers.filter((a) => a === "false")).toHaveLength(5);
}, 90_000);
