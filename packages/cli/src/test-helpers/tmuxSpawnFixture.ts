import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolveSpawnerConversation } from "../daemon.js";
import { registerAppServerSpawnTracking, TmuxSpawnRegistry } from "../tmuxSpawns.js";
import { tmuxRunAsync } from "../tmux.js";

async function verify() {
  const dir = process.argv[2];
  const name = `cast-spawn-e2e-${randomUUID().slice(0, 8)}`;
  const transcript = join(dir, "rollout.jsonl");
  const script = join(dir, "writer.js");
  const registryFile = join(dir, "registry.json");
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(script, `const fs = require("node:fs"); const fd = fs.openSync(process.argv[2], "w"); fs.writeSync(fd, JSON.stringify({timestamp: new Date().toISOString(), type: "session_meta", payload: {id: "child"}})+"\\n"); setInterval(() => fs.fsyncSync(fd), 1000);`);
  const registry = new TmuxSpawnRegistry(registryFile);
  const server = new EventEmitter();
  registerAppServerSpawnTracking(server, threadId => threadId === "parent-thread" ? "parent-conversation" : undefined, async (messages, parent) => {
    registry.record(messages, parent);
  }, err => { throw err; });
  const command = `tmux new-session -d -s ${name} ${quote(`${quote(process.execPath)} ${quote(script)} ${quote(transcript)}`)}`;
  server.emit("itemStarted", "parent-thread", "turn", { type: "commandExecution", id: "launch", status: "inProgress", command: `/bin/bash -lc ${quote(command)}`, cwd: dir });
  try {
    assert.equal((await tmuxRunAsync(["new-session", "-d", "-s", name, `${quote(process.execPath)} ${quote(script)} ${quote(transcript)}`])).status, 0);
    for (let i = 0; i < 40 && !existsSync(transcript); i++) await Bun.sleep(50);
    assert.ok(existsSync(transcript));
    assert.equal(registry.parent(name, Date.now()), "parent-conversation");
    const restored = new TmuxSpawnRegistry(registryFile);
    const parent = await resolveSpawnerConversation(transcript, "child", "codex", {}, restored);
    assert.equal(parent, "parent-conversation");
    return parent;
  } finally {
    await tmuxRunAsync(["kill-session", "-t", `=${name}`]);
  }
}
const parent = await verify();
writeFileSync(join(process.argv[2], "result.json"), JSON.stringify({ parent }));
console.log("parent recovered after restart");
process.exit(0);
