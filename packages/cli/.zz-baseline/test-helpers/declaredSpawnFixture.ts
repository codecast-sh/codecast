import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startLaunch } from "../execCommand.js";
import { resolveSpawnerConversation } from "../daemon.js";

// `cast exec` starts a child it has named "child-session" from inside
// "parent-session". The child leaves no process for the daemon to walk (here
// it never existed), so only the declaration can name its parent.
const dir = process.argv[2];
let started: string[] = [];
await startLaunch(
  { binary: "claude", binaryArgs: ["-p", "hi", "--session-id", "child-session"], childSessionId: "child-session" },
  { cwd: dir, inheritStdin: false, capture: true },
  async (_binary, args) => { started = args; return { code: 0, output: "" }; },
  "parent-session",
);
const parent = await resolveSpawnerConversation(join(dir, "child.jsonl"), "child-session", "claude", { "parent-session": "parent-conversation" });
writeFileSync(join(dir, "result.json"), JSON.stringify({ parent, started }));
process.exit(0);
