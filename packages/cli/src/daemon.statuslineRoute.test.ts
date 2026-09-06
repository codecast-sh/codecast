// /hook/statusline takes the rate-limit windows a running Claude session
// reports every turn (statuslineHook.ts) and folds them into the usage cache
// the heartbeat and auto-switch read. The route answers a hook that fires and
// forgets, so the properties that matter are: it always answers, a junk body
// changes nothing, an oversized body is refused before it is buffered, and a
// good one lands under the right account.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { handleStatusLinePost } from "./daemon.js";
import { readUsageCache } from "./ccAccounts.js";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"), "utf8");

const PAYLOAD = JSON.stringify({
  session_id: "f03e4098-8b2b-44e0-9370-de3b4fc2edd0",
  cost: { total_duration_ms: 17462 },
  rate_limits: {
    five_hour: { used_percentage: 41, resets_at: 1_788_759_000 },
    seven_day: { used_percentage: 62, resets_at: 1_789_016_400 },
  },
});

let home: string;
let savedHome: string | undefined;
let server: http.Server;
let base: string;

async function post(query: string, body: string): Promise<number> {
  const res = await fetch(`${base}/hook/statusline${query}`, { method: "POST", body });
  await res.text();
  return res.status;
}

// The route answers before it writes, so Claude Code's status line is never
// waiting on a disk. Reads of the cache therefore have to wait for the write.
async function cacheSettles(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (Object.keys(readUsageCache().accounts).length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-route-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codecast", "cc-accounts.json"),
    JSON.stringify({ profiles: { union: { uuid: "uuid-union", email: "u@x.com" } } }),
  );
  fs.writeFileSync(path.join(home, ".codecast", "cc-active.json"), JSON.stringify({ key: "uuid-active", since: 1 }));
  server = http.createServer((req, res) => handleStatusLinePost(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("/hook/statusline", () => {
  test("files a post under the session's pinned account", async () => {
    expect(await post("?account=union", PAYLOAD)).toBe(200);
    await cacheSettles();
    const snap = readUsageCache().accounts["uuid-union"];
    expect(snap?.session?.percent).toBe(41);
    expect(snap?.weekly?.percent).toBe(62);
    expect(snap?.source).toBe("live-session");
  });

  test("an unpinned session's post goes to the machine's active account", async () => {
    expect(await post("", PAYLOAD)).toBe(200);
    await cacheSettles();
    expect(readUsageCache().accounts["uuid-active"]?.session?.percent).toBe(41);
  });

  // The hook cannot retry and does not read the answer, so nothing here may
  // throw out of the request — a payload it cannot use is simply dropped.
  test("answers and changes nothing for a body it cannot use", async () => {
    for (const body of ["", "not json", "{}", JSON.stringify({ rate_limits: null })]) {
      expect(await post("?account=union", body), body).toBe(200);
    }
    // Nothing to wait for, and nothing may appear: settle a real post's worth
    // of event-loop turns first so a late write would be caught.
    await new Promise((r) => setTimeout(r, 200));
    expect(readUsageCache().accounts).toEqual({});
  });

  test("an account name that is not a profile name is dropped", async () => {
    expect(await post("?account=" + encodeURIComponent("../../etc"), PAYLOAD)).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(readUsageCache().accounts).toEqual({});
  });

  test("refuses an oversized body instead of buffering it", async () => {
    const fat = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } }, pad: "x".repeat(200_000) });
    const res = await fetch(`${base}/hook/statusline?account=union`, { method: "POST", body: fat }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(readUsageCache().accounts).toEqual({});
  });

  // /hook/status and /hook/statusline share a prefix. The method is what keeps
  // them apart, so the statusline branch has to be the specific one and it has
  // to come first.
  test("the statusline route is matched before /hook/status and only on POST", () => {
    const lineAt = src.indexOf('req.url?.startsWith(STATUSLINE_HOOK_PATH)');
    const statusAt = src.indexOf('req.url?.startsWith("/hook/status")');
    expect(lineAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(lineAt);
    expect(src.slice(lineAt - 60, lineAt)).toContain('req.method === "POST"');
    expect(src.slice(statusAt - 60, statusAt)).toContain('req.method === "GET"');
  });
});
