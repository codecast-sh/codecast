import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSpawnerConversation } from "./daemon.js";
import { declareSpawnParent } from "./spawnParents.js";
import { TmuxSpawnRegistry } from "./tmuxSpawns.js";

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
