import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FIND_CAST_SH } from "../cloud/ghWrapper.js";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf-8"));

const marketplace = read(".claude-plugin/marketplace.json");
const entry = marketplace.plugins[0];
const pluginDir = path.join(ROOT, entry.source);
const manifest = read(path.join(entry.source, ".claude-plugin/plugin.json"));
const hooks = read(path.join(entry.source, "hooks/hooks.json"));

const hookCommands = (): Array<{ event: string; command: string; hook: any }> =>
  Object.entries(hooks.hooks as Record<string, any[]>).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((hook: any) => ({ event, command: String(hook.command), hook }))),
  );

const scriptOf = (command: string) => path.join(pluginDir, command.replace(/^"?\$\{CLAUDE_PLUGIN_ROOT\}\//, "").replace(/"$/, ""));

describe("the plugin marketplace", () => {
  test("lists exactly the plugin in this repo, by a source path that exists", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry.source.startsWith("./")).toBe(true);
    expect(fs.statSync(pluginDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, ".claude-plugin/plugin.json"))).toBe(true);
  });

  test("the entry and plugin.json agree on the name", () => {
    expect(manifest.name).toBe(entry.name);
    expect(path.basename(pluginDir)).toBe(entry.name);
  });

  test("neither pins a version, so an update follows the marketplace's commits", () => {
    expect(manifest.version).toBeUndefined();
    expect(entry.version).toBeUndefined();
  });

  test("the skill the plugin ships exists", () => {
    expect(fs.existsSync(path.join(pluginDir, "skills", entry.name, "SKILL.md"))).toBe(true);
  });
});

describe("the plugin hooks", () => {
  test("SessionStart and SessionEnd each run one command from the plugin's scripts", () => {
    expect(hookCommands().map((h) => h.event).sort()).toEqual(["SessionEnd", "SessionStart"]);
    for (const { command } of hookCommands()) expect(command).toContain("${CLAUDE_PLUGIN_ROOT}/scripts/");
  });

  test("every hook's script exists and is executable", () => {
    for (const { command } of hookCommands()) {
      const script = scriptOf(command);
      expect(fs.existsSync(script)).toBe(true);
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    }
  });

  test("SessionStart runs in the background so a relay replacement never delays the session; SessionEnd is synchronous", () => {
    const byEvent = Object.fromEntries(hookCommands().map((h) => [h.event, h.hook]));
    expect(byEvent.SessionStart.async).toBe(true);
    expect(byEvent.SessionEnd.async).toBeUndefined();
    expect(byEvent.SessionEnd.timeout).toBeGreaterThanOrEqual(8);
  });
});

describe("the hook scripts", () => {
  const scripts = () => hookCommands().map(({ command }) => fs.readFileSync(scriptOf(command), "utf-8"));

  test("find cast the way the repo's own wrappers do, and call it by that path", () => {
    for (const body of scripts()) {
      expect(body).toContain(FIND_CAST_SH);
      expect(body).not.toMatch(/^cast /m);
      expect(body).toContain('[ -n "$CAST" ] || exit 0');
    }
  });

  test("call only register, relay --background and unregister as cast verbs", () => {
    const verbs = scripts().flatMap((body) => [...body.matchAll(/(?:^|[|(]\s*)"\$CAST"\s+(\S+)(?:\s+(--\S+))?/gm)].map((m) => (m[1] === "relay" ? `relay ${m[2]}` : m[1])));
    expect(verbs.sort()).toEqual(["register", "relay --background", "unregister"]);
  });

  test("do nothing outside herdr and paseo, and always exit 0", () => {
    for (const body of scripts()) {
      expect(body).toContain('[ -n "${PASEO_AGENT_ID}${HERDR_PANE_ID}" ] || exit 0');
      expect(body.trimEnd().endsWith("exit 0")).toBe(true);
    }
  });

  test("the SessionEnd script hands the payload to a background unregister, because plugin hooks get a 1.5s budget", () => {
    const end = fs.readFileSync(scriptOf(hookCommands().find((h) => h.event === "SessionEnd")!.command), "utf-8");
    expect(end).toContain("INPUT=$(cat)");
    expect(end).toMatch(/\(printf '%s' "\$INPUT" \| "\$CAST" unregister >\/dev\/null 2>&1\) &/);
  });
});
