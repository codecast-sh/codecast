import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { measureLoopHold } from "../test-helpers/loopHold.js";
import { readInventory, readInventoryAsync } from "./inventory.js";

// The heartbeat's scan yields between directory reads; the daemon's skills
// lookup cannot. Both drive the same step list, so they must agree byte for
// byte, and the async one must leave the loop free while it runs.

function skill(dir: string, name: string, description = `does ${name}`): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

function markdownDir(dir: string, count: number, key: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `${key}-${i}.md`), `---\ndescription: ${key} ${i}\n---\n`);
}

function fakeHome(skillCount: number): { home: string; project: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-inv-async-"));
  const project = path.join(home, "src", "proj");
  fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
  for (let i = 0; i < skillCount; i++) skill(path.join(home, ".claude", "skills"), `skill-${i}`);
  skill(path.join(project, ".claude", "skills"), "proj-skill");
  fs.writeFileSync(path.join(home, ".claude", "commands", "ship.md"), "---\ndescription: ship it\n---\nship\n");
  fs.writeFileSync(path.join(project, ".claude", "commands", "lint.md"), "---\ndescription: lint it\n---\nlint\n");
  fs.writeFileSync(path.join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\n");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "tools@acme": true, "off@acme": false } }));
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 1, plugins: { "tools@acme": [{ scope: "user", version: "1.0.0", gitCommitSha: "abc" }] } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "repo-mcp" } } }));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  return { home, project };
}

describe("readInventoryAsync", () => {
  test("produces the same inventory as the sync scan, items in the same order", async () => {
    const { home, project } = fakeHome(5);
    try {
      const sync = readInventory(home, project);
      const async = await readInventoryAsync(home, project);
      expect(async).toEqual(sync);
      expect(sync.items.length).toBeGreaterThan(5);
      expect(sync.items.some((i) => i.kind === "skill" && i.name === "proj-skill")).toBe(true);
      expect(sync.items.some((i) => i.kind === "command" && i.name === "lint")).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves the loop free between directory reads", async () => {
    // Several heavy steps, not one: the yield is between directory reads, so
    // the probe must see the loop between two of them.
    const { home, project } = fakeHome(300);
    markdownDir(path.join(home, ".claude", "commands"), 300, "cmd");
    markdownDir(path.join(home, ".claude", "agents"), 300, "agent");
    markdownDir(path.join(project, ".claude", "commands"), 300, "pcmd");
    try {
      const { result, ticks } = await measureLoopHold(() => readInventoryAsync(home, project), 1);
      expect(result.items.length).toBeGreaterThanOrEqual(1200);
      expect(ticks).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
