import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSpawnerConversation } from "./daemon.js";
import { declareSpawnParent } from "./spawnParents.js";
import { TmuxSpawnRegistry } from "./tmuxSpawns.js";
import { pollUntil } from "./test-helpers/pollUntil.js";

// A detached headless run has no process path back to its spawner (the walk
// finds nothing for a transcript no live process holds), so the inherited
// conversation declared by the session-register hook is what nests it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-spawn-decl-"));
const noSpawns = new TmuxSpawnRegistry(path.join(dir, "no-spawns.json"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function declareConversation(childSessionId: string, conversationId: string): void {
  fs.mkdirSync(path.join(dir, "spawn-parents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "spawn-parents", `${childSessionId}.json`), JSON.stringify({ parent_conversation_id: conversationId }));
}

const resolve = (sessionId: string, cache: Record<string, string>) =>
  resolveSpawnerConversation(path.join(dir, `${sessionId}.jsonl`), sessionId, "claude", cache, noSpawns, dir);

test("an inherited conversation nests a run the process walk cannot see", async () => {
  declareConversation("child-a", "jx7parent");
  expect(await resolve("child-a", { "parent-sess": "jx7parent" })).toBe("jx7parent");
});

test("a conversation this machine does not know is ignored", async () => {
  declareConversation("child-b", "jx7foreign");
  expect(await resolve("child-b", { "parent-sess": "jx7parent" })).toBeNull();
});

test("a run never nests under its own conversation", async () => {
  declareConversation("child-c", "jx7self");
  expect(await resolve("child-c", { "child-c": "jx7self" })).toBeNull();
});

test("a cast exec declaration names the caller's conversation", async () => {
  declareSpawnParent(dir, "child-d", "caller-sess");
  expect(await resolve("child-d", { "caller-sess": "jx7caller" })).toBe("jx7caller");
});

// A detached `codex exec` (`nohup … &`) has init for a parent and no session
// hook, so the conversation its own process inherited is the only thing that
// names its spawner. The stand-in is a script named `codex` run with `exec`,
// holding the transcript open the way the real run does.
// lsof and ps over a real process: seconds on a loaded machine.
const DETACHED_RUN_TIMEOUT_MS = 30_000;
async function detachedHeadlessRun(name: string, inheritedConversation: string): Promise<{ transcript: string; stop: () => void }> {
  const bin = path.join(dir, `${name}-bin`);
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "codex");
  // Run by bun, not /bin/sh: macOS hides the environment of a system binary from ps.
  fs.writeFileSync(script, 'const fs = require("node:fs");\nconst fd = fs.openSync(process.argv[3], "a");\nfs.writeSync(fd, "ready\\n");\nsetTimeout(() => {}, 60000);\n');
  const transcript = path.join(dir, `${name}.jsonl`);
  const child = Bun.spawn([process.execPath, script, "exec", transcript], {
    env: { PATH: process.env.PATH ?? "", CODECAST_CONVERSATION_ID: inheritedConversation },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await pollUntil(() => fs.existsSync(transcript) && fs.statSync(transcript).size > 0, "the stand-in run to open its transcript");
  return { transcript, stop: () => child.kill() };
}

test("a detached headless run nests under the conversation its process inherited", async () => {
  const run = await detachedHeadlessRun("child-e", "jx7spawner");
  try {
    expect(await resolveSpawnerConversation(run.transcript, "child-e", "codex", { "spawner-sess": "jx7spawner" }, noSpawns, dir)).toBe("jx7spawner");
  } finally {
    run.stop();
  }
}, DETACHED_RUN_TIMEOUT_MS);

test("an inherited conversation this machine does not know nests nothing", async () => {
  const run = await detachedHeadlessRun("child-f", "jx7elsewhere");
  try {
    expect(await resolveSpawnerConversation(run.transcript, "child-f", "codex", { "spawner-sess": "jx7spawner" }, noSpawns, dir)).toBeNull();
  } finally {
    run.stop();
  }
}, DETACHED_RUN_TIMEOUT_MS);
