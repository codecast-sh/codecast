import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "../proc.js";
import { resolveSpawnerConversation } from "../daemon.js";

// This process plays the spawning claude session: its pid registry names
// "parent-session". The child plays a `claude -p` (the shape `cast exec`
// launches): no tty, it registers its own pid, and it appends to its
// transcript without holding it open, so lsof on the transcript finds nobody.
const dir = process.argv[2];
const sessions = join(dir, ".claude", "sessions");
mkdirSync(sessions, { recursive: true });
writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: "parent-session" }));
const transcript = join(dir, "child.jsonl");
const child = spawn(
  process.execPath,
  [
    "-e",
    `const fs = require("node:fs");
     fs.writeFileSync(process.argv[2] + "/" + process.pid + ".json", JSON.stringify({ sessionId: "child-session", entrypoint: "sdk-cli" }));
     fs.appendFileSync(process.argv[1], "{}\\n");
     setInterval(() => {}, 1000);`,
    transcript,
    sessions,
  ],
  { stdio: "ignore" },
);
for (let i = 0; i < 100 && !existsSync(transcript); i++) await Bun.sleep(50);
assert.ok(existsSync(transcript));
await Bun.sleep(300);

const parent = await resolveSpawnerConversation(transcript, "child-session", "claude", { "parent-session": "parent-conversation" });
child.kill("SIGKILL");
writeFileSync(join(dir, "result.json"), JSON.stringify({ parent }));
process.exit(0);
