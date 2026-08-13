import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readInstalledPluginPins,
  readInventory,
  readKnownMarketplaces,
  toInvocableList,
} from "./inventory.js";

// One fixture tree shaped like a real machine: a HOME with user-scope skills,
// commands, agents, plugins and MCP servers, plus a project carrying its own
// .claude dir, settings, and .mcp.json.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cc-inv-"));
const HOME = path.join(ROOT, "home");
const PROJ = path.join(ROOT, "proj");

function write(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// --- user scope -------------------------------------------------------------
write(
  path.join(HOME, ".claude", "skills", "domain-search", "SKILL.md"),
  "---\nname: domain-search\ndescription: Check domain availability\n---\n\nbody\n",
);
// A bare .md skill — this layout really exists alongside directories.
write(
  path.join(HOME, ".claude", "skills", "grill-me.md"),
  "---\nname: grill-me\ndescription: Interview the user\n---\n",
);
// Opted out of the / menu.
write(
  path.join(HOME, ".claude", "skills", "hidden", "SKILL.md"),
  "---\nname: hidden\ndescription: not shown\nuser-invocable: false\n---\n",
);
// Lowercase manifest — works on macOS, must still be found.
write(
  path.join(HOME, ".claude", "skills", "lowercase", "skill.md"),
  "---\nname: lowercase\ndescription: lower manifest\n---\n",
);
write(path.join(HOME, ".claude", "commands", "commit.md"), "---\ndescription: Commit changes\n---\n");
write(path.join(HOME, ".claude", "agents", "critic.md"), "---\ndescription: Finds bugs\n---\n");
write(
  path.join(HOME, ".claude", "settings.json"),
  JSON.stringify({ enabledPlugins: { "code-simplifier@claude-plugins-official": true } }),
);
write(
  path.join(HOME, ".claude", "plugins", "known_marketplaces.json"),
  JSON.stringify({
    "claude-plugins-official": {
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
      installLocation: "/somewhere",
    },
  }),
);
write(
  path.join(HOME, ".claude", "plugins", "installed_plugins.json"),
  JSON.stringify({
    version: 2,
    plugins: {
      "code-simplifier@claude-plugins-official": [
        { scope: "user", version: "1.0.0", gitCommitSha: "b36fd4b753018b0b340803579399992a32e43502" },
      ],
      // Downloaded, but no settings file declares it — the third state.
      "ralph-loop@claude-plugins-official": [
        { scope: "user", version: "1.0.0", gitCommitSha: "aaa1111111111111111111111111111111111111" },
      ],
      // Installed at project scope for a DIFFERENT checkout. On this disk, but
      // not a capability of the project we are asking about.
      "other-project@claude-plugins-official": [
        { scope: "project", projectPath: "/somewhere/else", version: "2.0.0", gitCommitSha: "bbb2222222222222222222222222222222222222" },
      ],
    },
  }),
);
write(
  path.join(HOME, ".claude.json"),
  JSON.stringify({ mcpServers: { electron: { command: "node", args: ["server.js", "--port", "1"] } } }),
);

// --- project + local scope --------------------------------------------------
write(
  path.join(PROJ, ".claude", "skills", "repo-only", "SKILL.md"),
  "---\nname: repo-only\ndescription: project skill\n---\n",
);
write(
  path.join(PROJ, ".claude", "settings.json"),
  JSON.stringify({
    extraKnownMarketplaces: {
      "acme-internal": { source: { source: "github", repo: "acme/plugins" } },
    },
    enabledPlugins: {
      "frontend-design@claude-plugins-official": true,
      "disabled-one@claude-plugins-official": false,
    },
  }),
);
write(
  path.join(PROJ, ".claude", "settings.local.json"),
  JSON.stringify({ enabledPlugins: { "local-only@claude-plugins-official": true } }),
);
write(
  path.join(PROJ, ".mcp.json"),
  JSON.stringify({
    mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } },
  }),
);

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const find = (inv: ReturnType<typeof readInventory>, kind: string, name: string) =>
  inv.items.find((i) => i.kind === kind && i.name === name);

describe("skills", () => {
  const inv = readInventory(HOME, PROJ);

  test("reads both the directory and bare-file layouts", () => {
    expect(find(inv, "skill", "domain-search")?.description).toBe("Check domain availability");
    expect(find(inv, "skill", "grill-me")?.description).toBe("Interview the user");
  });

  test("finds a lowercase skill.md manifest", () => {
    expect(find(inv, "skill", "lowercase")).toBeDefined();
  });

  test("omits a skill that opted out of the menu", () => {
    expect(find(inv, "skill", "hidden")).toBeUndefined();
  });

  test("attributes a project skill to project scope", () => {
    expect(find(inv, "skill", "repo-only")?.scope).toBe("project");
    expect(find(inv, "skill", "domain-search")?.scope).toBe("user");
  });

  test("reads commands and subagents", () => {
    expect(find(inv, "command", "commit")?.description).toBe("Commit changes");
    expect(find(inv, "subagent", "critic")?.description).toBe("Finds bugs");
  });
});

describe("plugins", () => {
  const inv = readInventory(HOME, PROJ);

  test("reports each scope that enabled a plugin", () => {
    expect(find(inv, "plugin", "code-simplifier@claude-plugins-official")?.scope).toBe("user");
    expect(find(inv, "plugin", "frontend-design@claude-plugins-official")?.scope).toBe("project");
    expect(find(inv, "plugin", "local-only@claude-plugins-official")?.scope).toBe("local");
  });

  // Three states, and the UI has to tell them apart. `claude plugin list --json`
  // reports all three, so dropping any of them would make codecast's view
  // disagree with the tool the user actually runs.
  test("an explicit false is reported as switched off, not omitted", () => {
    const off = find(inv, "plugin", "disabled-one@claude-plugins-official");
    expect(off?.enabled).toBe(false);
    expect(off?.scope).toBe("project");
  });

  test("switched-on plugins are marked enabled", () => {
    expect(find(inv, "plugin", "frontend-design@claude-plugins-official")?.enabled).toBe(true);
  });

  test("a plugin installed but declared nowhere is reported as installed and off", () => {
    // ralph-loop is in installed_plugins.json only — no settings file mentions it.
    const orphan = find(inv, "plugin", "ralph-loop@claude-plugins-official");
    expect(orphan).toMatchObject({ enabled: false, installed: true, scope: "user" });
    expect(orphan?.meta?.sha).toBe("aaa1111111111111111111111111111111111111");
  });

  test("a declared plugin that was never downloaded is marked not installed", () => {
    expect(find(inv, "plugin", "frontend-design@claude-plugins-official")?.installed).toBe(false);
  });


  test("a plugin installed for another project is not reported here", () => {
    expect(find(inv, "plugin", "other-project@claude-plugins-official")).toBeUndefined();
  });

  test("…but is reported when that project is the one being asked about", () => {
    const other = readInventory(HOME, "/somewhere/else");
    const p = other.items.find((i) => i.kind === "plugin" && i.name === "other-project@claude-plugins-official");
    expect(p).toMatchObject({ scope: "project", installed: true, enabled: false });
    expect(p?.meta?.projectPath).toBe("/somewhere/else");
  });

  test("splits the id into plugin and marketplace", () => {
    expect(find(inv, "plugin", "frontend-design@claude-plugins-official")?.meta).toMatchObject({
      plugin: "frontend-design",
      marketplace: "claude-plugins-official",
    });
  });

  test("folds the recorded sha and version onto the row", () => {
    expect(find(inv, "plugin", "code-simplifier@claude-plugins-official")?.meta).toMatchObject({
      version: "1.0.0",
      sha: "b36fd4b753018b0b340803579399992a32e43502",
    });
  });

  test("collects marketplaces from both the registry and project settings", () => {
    const names = inv.marketplaces.map((m) => m.name).sort();
    expect(names).toContain("claude-plugins-official");
    expect(names).toContain("acme-internal");
    expect(inv.marketplaces.find((m) => m.name === "acme-internal")?.repo).toBe("acme/plugins");
  });

  test("readKnownMarketplaces and readInstalledPluginPins read standalone", () => {
    expect(readKnownMarketplaces(HOME)[0]?.repo).toBe("anthropics/claude-plugins-official");
    expect(readInstalledPluginPins(HOME)["code-simplifier@claude-plugins-official"]?.sha).toHaveLength(40);
  });
});

describe("mcp servers", () => {
  const inv = readInventory(HOME, PROJ);

  test("reads a stdio server from the user scope and shows its command line", () => {
    const s = find(inv, "mcp", "electron");
    expect(s?.scope).toBe("user");
    expect(s?.meta).toMatchObject({ transport: "stdio", command: "node server.js --port 1" });
  });

  test("reads a remote server from the project .mcp.json", () => {
    const s = find(inv, "mcp", "sentry");
    expect(s?.scope).toBe("project");
    expect(s?.meta).toMatchObject({ transport: "http", url: "https://mcp.sentry.dev/mcp" });
  });
});

describe("robustness", () => {
  test("a missing HOME yields an empty inventory, never a throw", () => {
    const inv = readInventory(path.join(ROOT, "nope"));
    expect(inv.items).toEqual([]);
    expect(inv.marketplaces).toEqual([]);
  });

  test("malformed JSON is skipped rather than fatal", () => {
    const broken = path.join(ROOT, "broken");
    write(path.join(broken, ".claude", "settings.json"), "{ not json");
    write(path.join(broken, ".claude.json"), "]]]");
    write(
      path.join(broken, ".claude", "skills", "ok", "SKILL.md"),
      "---\nname: ok\ndescription: fine\n---\n",
    );
    const inv = readInventory(broken);
    expect(find(inv, "skill", "ok")).toBeDefined();
    expect(inv.items.filter((i) => i.kind === "plugin")).toEqual([]);
  });

  test("omitting the project path reads user scope only", () => {
    const inv = readInventory(HOME);
    expect(find(inv, "skill", "repo-only")).toBeUndefined();
    expect(find(inv, "skill", "domain-search")).toBeDefined();
    expect(find(inv, "mcp", "sentry")).toBeUndefined();
  });

  test("a skill without frontmatter falls back to its file name", () => {
    const bare = path.join(ROOT, "bare");
    write(path.join(bare, ".claude", "skills", "no-meta", "SKILL.md"), "just a body\n");
    expect(find(readInventory(bare), "skill", "no-meta")).toBeDefined();
  });
});

describe("toInvocableList", () => {
  test("keeps the existing / menu contract and prefers the narrower scope", () => {
    const dup = path.join(ROOT, "dup");
    write(
      path.join(dup, "home", ".claude", "skills", "shared", "SKILL.md"),
      "---\nname: shared\ndescription: from user\n---\n",
    );
    write(
      path.join(dup, "proj", ".claude", "skills", "shared", "SKILL.md"),
      "---\nname: shared\ndescription: from project\n---\n",
    );
    const list = toInvocableList(readInventory(path.join(dup, "home"), path.join(dup, "proj")));
    const shared = list.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].description).toBe("from project");
  });

  test("lists skills and commands but not plugins or mcp servers", () => {
    const names = toInvocableList(readInventory(HOME, PROJ)).map((s) => s.name);
    expect(names).toContain("domain-search");
    expect(names).toContain("commit");
    expect(names).not.toContain("electron");
    expect(names.some((n) => n.includes("@"))).toBe(false);
  });
});
