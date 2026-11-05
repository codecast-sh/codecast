// Run as its own process (daemon.liveness-terminal.e2e.test.ts), which hands it
// a scratch CODECAST_DIR: the daemon reads it once, at module load.
//
// The shape this pins: a session codecast once resumed into its own tmux is
// still a managed row on the server after the person resumed it by hand in
// another terminal (herdr) and the tmux copy is gone. The liveness pass fills
// the process cache for it off the row's agent_pid. The session's own
// SessionStart claim names that same pid and its terminal; the fill must carry
// that terminal, or delivery falls back to the AppleScript (iTerm2) route and
// every message to the session is held.
import "./isolatedTmuxServer.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../proc.js";
import { defaultConfigDir } from "../config/configDir.js";

const dir = defaultConfigDir();
// Never write a registry claim into the human's own config dir.
assert.ok(dir.startsWith(tmpdir()), `scratch CODECAST_DIR expected, got ${dir}`);
const { cacheSessionProcess, getCachedSessionProcess, reconcileSessionLiveness, setSyncServiceForTests } = await import("../daemon.js");

const sessionId = randomUUID();
// Agent-shaped by comm (bun), and declaring the session by argv the way a
// `claude --resume <id>` does.
const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--resume", sessionId], { detached: true, stdio: "ignore" });
const registered: Array<string | undefined> = [];
try {
  assert.ok(agent.pid);
  mkdirSync(join(dir, "session-registry"), { recursive: true });
  writeFileSync(
    join(dir, "session-registry", `${sessionId}.json`),
    JSON.stringify({ pid: agent.pid, tty: "ttys004", ts: Math.floor(Date.now() / 1000), term: "herdr", launch_token: "" }),
  );
  setSyncServiceForTests({
    listManagedSessions: async () => [{ session_id: sessionId, tmux_session: "cc-resume-gone-0a1b2c3d", agent_pid: agent.pid }],
    registerManagedSession: async (_id: string, _pid: number, tmux?: string) => { registered.push(tmux); return {}; },
  } as any);
  await reconcileSessionLiveness();
  setSyncServiceForTests(null);

  const cached = await getCachedSessionProcess(sessionId);
  assert.ok(cached, "the liveness pass filled the cache");
  assert.equal(cached.pid, agent.pid);
  assert.equal(cached.termProgram, "herdr", "the fill carries the terminal the session's own claim names");
  // The row's tmux name is where the session was PUT; nothing runs there now.
  // Registering it again would keep the server pointing at a dead pane.
  assert.deepEqual(registered, [], "a tmux name with no live pane is not re-registered");

  // A later fill for the same pid that knows no terminal (resume process
  // match, a second liveness pass) keeps the one already known.
  cacheSessionProcess(sessionId, { pid: agent.pid, tty: "/dev/ttys004", sessionId });
  assert.equal((await getCachedSessionProcess(sessionId))?.termProgram, "herdr");
  console.log("Verified the liveness fill keeps the session's terminal.");
} finally {
  setSyncServiceForTests(null);
  agent.kill();
}
process.exit(0);
