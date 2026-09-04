import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSpawnerConversation } from "../daemon.js";
import { TmuxSpawnRegistry } from "../tmuxSpawns.js";
import { tmuxRunAsync } from "../tmux.js";

async function verify() {
  const dir = process.argv[2];
  const name = `cast-spawn-e2e-${randomUUID().slice(0, 8)}`;
  const transcript = join(dir, "rollout.jsonl");
  const script = join(dir, "writer.js");
  const registryFile = join(dir, "registry.json");
  const launchTime = Date.now();
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(script, `const fs = require("node:fs"); const fd = fs.openSync(process.argv[2], "w"); fs.writeSync(fd, JSON.stringify({timestamp: new Date().toISOString(), type: "session_meta", payload: {id: "child"}})+"\\n"); setInterval(() => fs.fsyncSync(fd), 1000);`);
  const registry = new TmuxSpawnRegistry(registryFile);
  registry.record([{ role: "assistant", content: "", timestamp: launchTime, toolCalls: [{ id: "launch", name: "exec_command", input: { cmd: `tmux new-session -d -s ${name} 'writer'` } }] }], "parent-conversation");
  try {
    assert.equal((await tmuxRunAsync(["new-session", "-d", "-s", name, `${quote(process.execPath)} ${quote(script)} ${quote(transcript)}`])).status, 0);
    for (let i = 0; i < 40 && !existsSync(transcript); i++) await Bun.sleep(50);
    assert.ok(existsSync(transcript));
    const restored = new TmuxSpawnRegistry(registryFile);
    assert.equal(await resolveSpawnerConversation(transcript, "child", "codex", {}, restored), "parent-conversation");
  } finally {
    await tmuxRunAsync(["kill-session", "-t", `=${name}`]);
  }
}
await verify();
console.log("parent recovered after restart");
process.exit(0);
