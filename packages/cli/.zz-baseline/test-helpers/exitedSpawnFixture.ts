import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "../proc.js";
import { resolveSpawnerConversation } from "../daemon.js";

// This process plays the spawning claude session: its pid registry names
// "parent-session". The child plays a `codex exec` that writes its transcript
// and exits before the daemon creates its conversation.
const dir = process.argv[2];
mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
writeFileSync(join(dir, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: "parent-session" }));
const transcript = join(dir, "rollout.jsonl");
const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); fs.openSync(process.argv[1], "w"); setInterval(() => {}, 1000);`, transcript], { stdio: "ignore" });
for (let i = 0; i < 100 && !existsSync(transcript); i++) await Bun.sleep(50);
assert.ok(existsSync(transcript));
await Bun.sleep(300);

// Early pass while the child runs: the parent has no conversation yet.
assert.equal(await resolveSpawnerConversation(transcript, "child-session", "codex", {}), null);

const exited = new Promise((resolve) => child.once("exit", resolve));
child.kill("SIGKILL");
await exited;

// Creation pass after the child exited: no process is left to walk.
const parent = await resolveSpawnerConversation(transcript, "child-session", "codex", { "parent-session": "parent-conversation" });
writeFileSync(join(dir, "result.json"), JSON.stringify({ parent }));
process.exit(0);
