import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A detached headless run has no process path back to its spawner, so the
// declaration is the only way the daemon can nest it. CONFIG_DIR is read when
// daemon.ts loads, so point it at a scratch dir before the import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-spawn-decl-"));
process.env.CODECAST_DIR = dir;
const { resolveSpawnerConversation } = await import("./daemon.js");
const { declareSpawnParent } = await import("./spawnParents.js");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function declare(childSessionId: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "spawn-parents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "spawn-parents", `${childSessionId}.json`), JSON.stringify(body));
}

test("a declared parent conversation nests the run without a process walk", async () => {
  declare("child-conv", { parent_conversation_id: "jx7parent" });
  expect(await resolveSpawnerConversation("/nonexistent.jsonl", "child-conv", "claude", {})).toBe("jx7parent");
});

test("a declared parent session resolves through the conversation cache", async () => {
  declareSpawnParent(dir, "child-sess", "parent-sess");
  expect(await resolveSpawnerConversation("/nonexistent.jsonl", "child-sess", "claude", { "parent-sess": "jx7caller" })).toBe("jx7caller");
});
