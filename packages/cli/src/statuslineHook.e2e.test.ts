// The whole chain, driven by a real Claude Code turn: Claude Code runs the
// installed statusLine command, the script filters and throttles, curl posts to
// the daemon's loopback route, and the account's live usage lands in
// ~/.codecast/cc-usage.json where the heartbeat and auto-switch read it.
//
// The unit tests feed the script a payload we wrote. This one proves the field
// names against whatever Claude Code is installed on the machine — the reason
// the feature can be believed at all, since `rate_limits` is not documented and
// has moved before.
//
// Skipped unless the machine can actually run a subscriber turn: tmux, the
// claude binary, and a `cast accounts token` env file to authenticate with (the
// windows only appear on a Claude.ai subscription, never on API billing).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { CODECAST_STATUSLINE_HOOK, STATUSLINE_HOOK_FILE } from "./statuslineHook.js";
import { handleStatusLinePost } from "./daemon.js";
import { readUsageCache } from "./ccAccounts.js";

const has = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
const tokenFile = (() => {
  try {
    const dir = path.join(os.homedir(), ".codecast");
    const f = fs.readdirSync(dir).find((n) => /^cc-account-.+\.env$/.test(n));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
})();
const CAN_RUN = process.platform !== "win32" && has("tmux") && has("claude") && !!tokenFile;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(500);
  }
  return fn();
}

describe.skipIf(!CAN_RUN)("live usage from a real Claude turn", () => {
  test("a turn's rate_limits reach the usage cache through the installed statusLine", async () => {
    // realpath: on macOS the temp root is a symlink, and Claude Code keys the
    // trust prompt on the resolved path — an unresolved one prompts forever.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-e2e-")));
    const home = path.join(root, "home");
    const configDir = path.join(root, "cc-config");
    const session = `cc-statusline-e2e-${process.pid}`;
    const savedHome = process.env.HOME;

    // The daemon's own route handler, on a throwaway port, with HOME pointed at
    // a sandbox so the cache write lands there and not in the real one.
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts.json"),
      JSON.stringify({ profiles: { probe: { uuid: "uuid-probe", email: "probe@example.com" } } }),
    );
    const server = http.createServer((req, res) => handleStatusLinePost(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(home, ".codecast", "hook-port"), String(port));

    const hook = path.join(home, ".claude", "hooks", STATUSLINE_HOOK_FILE);
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, CODECAST_STATUSLINE_HOOK, { mode: 0o755 });

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: hook, padding: 0 } }),
    );
    // Enough of a config to skip onboarding and the trust prompt; the login
    // itself comes from the sourced setup-token, not from this file.
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: "dark",
        projects: { [root]: { hasTrustDialogAccepted: true, allowedTools: [] } },
      }),
    );

    const tmux = (args: string[]) => spawnSync("tmux", args, { encoding: "utf8" });
    tmux(["kill-session", "-t", session]);
    try {
      tmux(["new-session", "-d", "-x", "200", "-y", "50", "-s", session, "-c", root]);
      // CODECAST_CC_ACCOUNT is what accountSourcePrefix exports beside the
      // token, and what the script forwards so the post is attributed.
      tmux([
        "send-keys",
        "-t",
        `${session}:0.0`,
        `. ${tokenFile}; export CODECAST_CC_ACCOUNT=probe; HOME=${home} CLAUDE_CONFIG_DIR=${configDir} claude`,
        "Enter",
      ]);
      const ready = await waitFor(
        () => tmux(["capture-pane", "-p", "-J", "-t", `${session}:0.0`, "-S", "-40"]).stdout.includes("Claude Code v"),
        60_000,
      );
      expect(ready).toBe(true);

      tmux(["send-keys", "-t", `${session}:0.0`, "reply with the single word ok"]);
      await sleep(1000);
      tmux(["send-keys", "-t", `${session}:0.0`, "Enter"]);

      const landed = await waitFor(() => !!readUsageCache().accounts["uuid-probe"], 120_000);
      const snap = readUsageCache().accounts["uuid-probe"];
      expect(landed, `pane:\n${tmux(["capture-pane", "-p", "-J", "-t", `${session}:0.0`, "-S", "-40"]).stdout}`).toBe(true);
      expect(snap?.source).toBe("live-session");
      // The windows Claude Code reported, not a shape we invented: a percentage
      // and, for a subscriber, a reset time in the future.
      expect(typeof snap?.session?.percent === "number" || typeof snap?.weekly?.percent === "number").toBe(true);
      for (const w of [snap?.session, snap?.weekly]) {
        if (w?.resets_at) expect(w.resets_at).toBeGreaterThan(Date.now());
      }
    } finally {
      tmux(["kill-session", "-t", session]);
      await new Promise<void>((r) => server.close(() => r()));
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
