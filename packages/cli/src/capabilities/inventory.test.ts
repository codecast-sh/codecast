import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  invocableSkills,
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

afterAll(() => {
  // Restore the permissions the EACCES fixtures dropped, or rmSync cannot
  // clear the tree.
  for (const p of restoreModes) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {}
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const restoreModes: string[] = [];

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

// ct-42815 — absent and unreadable are different answers. Every case here pins
// the invariant that a read failure can never masquerade as an empty machine.
describe("unreadable", () => {
  test("the clean fixture reports zero unreadable paths", () => {
    expect(readInventory(HOME, PROJ).unreadable).toEqual([]);
  });

  test("malformed JSON is reported with its path, not folded into empty", () => {
    const home = path.join(ROOT, "mangled");
    const settings = path.join(home, ".claude", "settings.json");
    write(settings, "{ trailing: comma, }");
    const inv = readInventory(home);
    expect(inv.items.filter((i) => i.kind === "plugin")).toEqual([]);
    expect(inv.unreadable.map((u) => u.path)).toContain(settings);
  });

  test("a chmod-000 file reports EACCES — unknown, not an empty machine", () => {
    const home = path.join(ROOT, "denied");
    const settings = path.join(home, ".claude", "settings.json");
    write(settings, JSON.stringify({ enabledPlugins: { "x@m": true } }));
    fs.chmodSync(settings, 0o000);
    restoreModes.push(settings);
    const inv = readInventory(home);
    expect(inv.unreadable).toContainEqual({ path: settings, error: "EACCES" });
    expect(inv.items.filter((i) => i.kind === "plugin")).toEqual([]);
  });

  test("an unreadable directory is distinguishable from an empty one", () => {
    const emptyHome = path.join(ROOT, "empty-skills");
    fs.mkdirSync(path.join(emptyHome, ".claude", "skills"), { recursive: true });
    expect(readInventory(emptyHome).unreadable).toEqual([]);

    const deniedHome = path.join(ROOT, "denied-skills");
    const skillsDir = path.join(deniedHome, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.chmodSync(skillsDir, 0o000);
    restoreModes.push(skillsDir);
    expect(readInventory(deniedHome).unreadable).toContainEqual({ path: skillsDir, error: "EACCES" });
  });

  // The client gate stats `~/.codex` / `~/.cursor`. With exec denied on HOME
  // that stat fails EACCES — which must surface as unknown, not fold into
  // "this machine has no codex", the exact conflation ct-42815 bans.
  test("a stat-denied client dot-dir is unknown, never client-absent", () => {
    const home = path.join(ROOT, "denied-home");
    fs.mkdirSync(home, { recursive: true });
    fs.chmodSync(home, 0o000);
    restoreModes.push(home);
    const paths = readInventory(home).unreadable.map((u) => u.path);
    expect(paths).toContain(path.join(home, ".codex"));
    expect(paths).toContain(path.join(home, ".cursor"));
  });

  test("a dangling symlink is unknown: readdir listed it, so ENOENT is recorded", () => {
    const home = path.join(ROOT, "dangling");
    const skillsDir = path.join(home, ".claude", "skills");
    write(path.join(skillsDir, "ok", "SKILL.md"), "---\nname: ok\ndescription: fine\n---\n");
    const link = path.join(skillsDir, "gone");
    fs.symlinkSync(path.join(home, "no-such-target"), link);
    const inv = readInventory(home);
    expect(inv.unreadable).toContainEqual({ path: link, error: "ENOENT" });
    // The healthy neighbour still reports — one bad entry poisons nothing.
    expect(find(inv, "skill", "ok")).toBeDefined();
  });
});

// ct-42818 — codex state files, read from the slots codex's `agentFileTargets`
// descriptor declares and tagged with their client.
describe("codex", () => {
  const home = path.join(ROOT, "codex-home");
  const proj = path.join(ROOT, "codex-proj");
  write(
    path.join(home, ".codex", "config.toml"),
    [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers]",
      "inline = { command = \"uvx\", args = [\"inline-mcp\"] }",
      "",
      "[mcp_servers.docs]",
      "command = \"npx\"",
      "args = [\"-y\", \"docs-mcp\"]",
      "",
      "[mcp_servers.\"dotted.name\"]",
      "url = \"https://mcp.example.dev/mcp\"",
      "",
      "[mcp_servers.docs.env] # a nested table must not bleed into the next server",
      "KEY = \"v\"",
      "",
      "[mcp_servers.longpkg]",
      "command = \"npx\"",
      "args = [",
      "  \"-y\",",
      "  \"@scope/very-long-package\",",
      "]",
      "",
      "[features]",
      "hooks = true",
    ].join("\n"),
  );
  // Project-scope codex config + the cross-client project skills dir — both
  // declared by codex's descriptor (mcpConfig.project, skillsDir.project).
  write(
    path.join(proj, ".codex", "config.toml"),
    ["[mcp_servers.projsrv]", "command = \"deno\"", "args = [\"run\", \"srv.ts\"]"].join("\n"),
  );
  write(
    path.join(proj, ".agents", "skills", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: project codex skill\n---\n",
  );
  write(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/x/.codecast/hooks/stable-feed-codex.sh", additionalContextLimit: 0 }] }],
      },
    }),
  );
  write(path.join(home, ".codex", "AGENTS.md"), "# global instructions\n");
  write(path.join(proj, "AGENTS.md"), "# project instructions\n");

  test("one mcp item per [mcp_servers.*] section, tagged client codex", () => {
    const inv = readInventory(home);
    const docs = find(inv, "mcp", "docs");
    expect(docs).toMatchObject({ client: "codex", scope: "user", enabled: true });
    expect(docs?.meta).toMatchObject({ transport: "stdio", command: "npx -y docs-mcp" });
    expect(find(inv, "mcp", "dotted.name")?.meta).toMatchObject({
      transport: "http",
      url: "https://mcp.example.dev/mcp",
    });
    // The nested [mcp_servers.docs.env] table is docs's config, not a server.
    // The real ~/.codex/config.toml has one, and the first parser cut minted a
    // phantom `node_repl.env` server from it.
    expect(inv.items.filter((i) => i.client === "codex" && i.kind === "mcp")).toHaveLength(4);
    expect(inv.unreadable).toEqual([]);
  });

  // A truncated command line is worse than an unknown one — the command is the
  // main thing the UI shows before enabling a server, so an array spanning
  // lines must accumulate to the last element, not stop at `[`'s line.
  test("an args array that spans lines is read whole", () => {
    expect(find(readInventory(home), "mcp", "longpkg")?.meta?.command).toBe(
      "npx -y @scope/very-long-package",
    );
  });

  test("an inline-table server under bare [mcp_servers] is a server too", () => {
    expect(find(readInventory(home), "mcp", "inline")?.meta).toMatchObject({
      transport: "stdio",
      command: "uvx inline-mcp",
    });
  });

  // Both read because codex's descriptor declares mcpConfig.project and
  // skillsDir.project — the seam the tasks demanded, so a slot verified into
  // the registry is scanned without this module learning a path.
  test("the project .codex/config.toml and .agents/skills report at project scope", () => {
    const inv = readInventory(home, proj);
    expect(find(inv, "mcp", "projsrv")).toMatchObject({ client: "codex", scope: "project" });
    expect(find(inv, "mcp", "projsrv")?.meta?.command).toBe("deno run srv.ts");
    expect(find(inv, "skill", "proj-skill")).toMatchObject({ client: "codex", scope: "project" });
  });

  test("hooks.json entries report as hook items", () => {
    const hook = readInventory(home).items.find((i) => i.kind === "hook");
    expect(hook).toMatchObject({ client: "codex", scope: "user" });
    expect(hook?.meta).toMatchObject({ event: "SessionStart", command: "/x/.codecast/hooks/stable-feed-codex.sh" });
  });

  test("AGENTS.md presence reports at user and project scope", () => {
    const inv = readInventory(home, proj);
    const files = inv.items.filter((i) => i.name === "AGENTS.md");
    expect(files.map((f) => f.scope).sort()).toEqual(["project", "user"]);
    expect(files.every((f) => f.client === "codex" && f.kind === "snippet")).toBe(true);
  });

  test("a HOME with no ~/.codex yields zero codex items and zero unreadable", () => {
    const inv = readInventory(HOME, PROJ);
    expect(inv.items.filter((i) => i.client === "codex")).toEqual([]);
    expect(inv.unreadable).toEqual([]);
  });
});

// ct-42819 — cursor state, read from cursor's `agentFileTargets` slots, and
// the shared skills dir counted once.
describe("cursor", () => {
  const home = path.join(ROOT, "cursor-home");
  const proj = path.join(ROOT, "cursor-proj");
  write(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/sse" } } }),
  );
  write(
    path.join(proj, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { repodb: { command: "npx", args: ["repodb-mcp"] } } }),
  );
  write(path.join(home, ".cursor", "rules", "style.mdc"), "---\ndescription: Style rules\n---\nBe terse.\n");
  write(path.join(proj, ".cursor", "rules", "repo.mdc"), "---\ndescription: Repo rules\n---\nUse the store.\n");
  write(path.join(home, ".cursor", "skills", "uskill", "SKILL.md"), "---\nname: uskill\ndescription: cursor user skill\n---\n");
  write(path.join(proj, ".cursor", "skills", "pskill", "SKILL.md"), "---\nname: pskill\ndescription: cursor project skill\n---\n");

  test("mcp.json reports with client cursor at both scopes", () => {
    const inv = readInventory(home, proj);
    expect(find(inv, "mcp", "linear")).toMatchObject({ client: "cursor", scope: "user" });
    expect(find(inv, "mcp", "repodb")).toMatchObject({ client: "cursor", scope: "project" });
    expect(find(inv, "snippet", "repo")).toMatchObject({ client: "cursor", scope: "project", description: "Repo rules" });
    expect(inv.unreadable).toEqual([]);
  });

  // Cursor's descriptor deliberately has NO user instruction slot — user-level
  // rules live in the app's settings, not a file the client reads — so a
  // ~/.cursor/rules dir on disk must not be reported: that would claim a
  // capability cursor never loads.
  test("~/.cursor/rules is not reported: the client does not read it", () => {
    expect(find(readInventory(home, proj), "snippet", "style")).toBeUndefined();
  });

  test("the descriptor's skills dirs report at both scopes", () => {
    const inv = readInventory(home, proj);
    expect(find(inv, "skill", "uskill")).toMatchObject({ client: "cursor", scope: "user" });
    expect(find(inv, "skill", "pskill")).toMatchObject({ client: "cursor", scope: "project" });
  });

  test("a HOME with no ~/.cursor yields zero cursor items and zero unreadable", () => {
    const inv = readInventory(HOME, PROJ);
    expect(inv.items.filter((i) => i.client === "cursor")).toEqual([]);
    expect(inv.unreadable).toEqual([]);
  });
});

describe("shared ~/.agents/skills", () => {
  const home = path.join(ROOT, "shared-home");
  const proj = path.join(ROOT, "shared-proj");
  const sharedDir = path.join(home, ".agents", "skills", "review");
  write(path.join(sharedDir, "SKILL.md"), "---\nname: review\ndescription: shared review skill\n---\n");
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "skills"), { recursive: true });
  const userLink = path.join(home, ".claude", "skills", "review");
  const projLink = path.join(proj, ".claude", "skills", "review");
  fs.symlinkSync(sharedDir, userLink);
  fs.symlinkSync(sharedDir, projLink);

  test("a skill symlinked into two client dirs is one item with two links", () => {
    const inv = readInventory(home, proj);
    const rows = inv.items.filter((i) => i.kind === "skill" && i.name === "review");
    expect(rows).toHaveLength(1);
    expect(rows[0].client).toBe("shared");
    // The narrowest link scope wins: a project link is the most specific
    // answer to "which scope switched this on", even when a user link exists.
    expect(rows[0].scope).toBe("project");
    const links = (rows[0].meta?.links ?? "").split("\n").sort();
    expect(links).toEqual([userLink, projLink].sort());
    expect(inv.unreadable).toEqual([]);
  });

  test("a skill linked only at project scope reports project, not user", () => {
    const onlyHome = path.join(ROOT, "projlink-home");
    const onlyProj = path.join(ROOT, "projlink-proj");
    const target = path.join(onlyHome, ".agents", "skills", "solo");
    write(path.join(target, "SKILL.md"), "---\nname: solo\ndescription: shared\n---\n");
    fs.mkdirSync(path.join(onlyProj, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(target, path.join(onlyProj, ".claude", "skills", "solo"));
    const row = find(readInventory(onlyHome, onlyProj), "skill", "solo");
    expect(row).toMatchObject({ client: "shared", scope: "project" });
  });

  test("a real (non-link) client skill with the same name still reports separately", () => {
    const twinHome = path.join(ROOT, "twin-home");
    write(path.join(twinHome, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: shared\n---\n");
    write(path.join(twinHome, ".claude", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: local copy\n---\n");
    const rows = readInventory(twinHome).items.filter((i) => i.kind === "skill" && i.name === "dup");
    expect(rows.map((r) => r.client).sort()).toEqual(["claude", "shared"]);
  });

  // The / menu contract: Claude Code follows symlinks in its own skill dirs,
  // so a linked shared skill was ALWAYS in the menu — attributing the link to
  // one shared item must not silently remove it. An unlinked shared skill is
  // another client's and stays out.
  test("a linked shared skill stays in the / menu; an unlinked one stays out", () => {
    write(path.join(home, ".agents", "skills", "codex-only", "SKILL.md"), "---\nname: codex-only\ndescription: n\n---\n");
    const names = toInvocableList(readInventory(home, proj)).map((s) => s.name);
    expect(names).toContain("review");
    expect(names).not.toContain("codex-only");
  });

  // A link the daemon never sees must not put a skill in the menu: only links
  // inside Claude's OWN skill dirs count, because the / menu is the daemon's
  // surface and it scans nothing else.
  test("a shared skill linked only from a cursor dir stays out of the / menu", () => {
    const xHome = path.join(ROOT, "xlink-home");
    const target = path.join(xHome, ".agents", "skills", "curside");
    write(path.join(target, "SKILL.md"), "---\nname: curside\ndescription: n\n---\n");
    fs.mkdirSync(path.join(xHome, ".cursor", "skills"), { recursive: true });
    fs.symlinkSync(target, path.join(xHome, ".cursor", "skills", "curside"));
    const inv = readInventory(xHome);
    // The link still attaches to the one shared item…
    const row = find(inv, "skill", "curside");
    expect(row?.client).toBe("shared");
    expect(row?.meta?.links).toBe(path.join(xHome, ".cursor", "skills", "curside"));
    // …but does not make it claude-invocable.
    expect(toInvocableList(inv).map((s) => s.name)).not.toContain("curside");
  });

  // ct-42820's precondition: the linked item is emitted at the symlink's own
  // directory position, so the daemon's listing order survives the collapse.
  // The membership half alone would let the position mechanics regress silently.
  test("a linked shared skill keeps its symlink's position in the / menu", () => {
    const ordHome = path.join(ROOT, "order-home");
    write(path.join(ordHome, ".agents", "skills", "mid", "SKILL.md"), "---\nname: mid\ndescription: shared\n---\n");
    const skillsDir = path.join(ordHome, ".claude", "skills");
    write(path.join(skillsDir, "aaa", "SKILL.md"), "---\nname: aaa\ndescription: a\n---\n");
    write(path.join(skillsDir, "zzz", "SKILL.md"), "---\nname: zzz\ndescription: z\n---\n");
    fs.symlinkSync(path.join(ordHome, ".agents", "skills", "mid"), path.join(skillsDir, "mid"));
    // The truth to match is the directory listing order the daemon itself
    // iterates — not an assumed alphabetical order.
    const listed = fs.readdirSync(skillsDir);
    const names = toInvocableList(readInventory(ordHome)).map((s) => s.name);
    expect(names).toEqual(listed);
  });
});

// The contract is the daemon's `readAvailableSkills`, byte for byte, so the
// ct-42820 repoint changes no conversation's serialized `available_skills`
// payload. That contract is FIRST LISTING WINS in the daemon's read order —
// commands before skills, user before project — not "narrowest scope wins".
describe("toInvocableList", () => {
  test("invocableSkills is the same function, not a second body", () => {
    expect(invocableSkills).toBe(toInvocableList);
  });

  test("first listing wins a collision: the user copy, as the daemon answers", () => {
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
    expect(shared[0].description).toBe("from user");
  });

  test("commands list before skills, and a command beats a same-named skill", () => {
    const kinds = path.join(ROOT, "kinds");
    write(path.join(kinds, "home", ".claude", "commands", "deploy.md"), "---\ndescription: the command\n---\n");
    write(
      path.join(kinds, "home", ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: the skill\n---\n",
    );
    write(
      path.join(kinds, "home", ".claude", "skills", "other", "SKILL.md"),
      "---\nname: other\ndescription: a skill\n---\n",
    );
    const list = toInvocableList(readInventory(path.join(kinds, "home")));
    // The daemon reads all command dirs first, so the command's description
    // wins the cross-kind collision (the real machine has two such names).
    expect(list.filter((s) => s.name === "deploy")).toEqual([{ name: "deploy", description: "the command" }]);
    expect(list.findIndex((s) => s.name === "deploy")).toBeLessThan(list.findIndex((s) => s.name === "other"));
  });

  test("a shared skill linked at project scope loses to a real user skill, as the daemon answers", () => {
    const tie = path.join(ROOT, "tie");
    const home = path.join(tie, "home");
    const proj = path.join(tie, "proj");
    write(path.join(home, ".agents", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: shared linked\n---\n");
    write(path.join(home, ".claude", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: user real\n---\n");
    fs.mkdirSync(path.join(proj, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, ".agents", "skills", "foo"), path.join(proj, ".claude", "skills", "foo"));
    const list = toInvocableList(readInventory(home, proj));
    // The daemon lists the user dir first and first-wins, so the real user
    // skill's description is the payload — pinned here because the old
    // narrowest-scope rule answered "shared linked" and the two silently
    // diverged.
    expect(list.filter((s) => s.name === "foo")).toEqual([{ name: "foo", description: "user real" }]);
  });

  test("lists skills and commands but not plugins or mcp servers", () => {
    const names = toInvocableList(readInventory(HOME, PROJ)).map((s) => s.name);
    expect(names).toContain("domain-search");
    expect(names).toContain("commit");
    expect(names).not.toContain("electron");
    expect(names.some((n) => n.includes("@"))).toBe(false);
  });

  test("every command precedes every skill — the daemon's kind order", () => {
    const list = toInvocableList(readInventory(HOME, PROJ));
    const lastCommand = list.findIndex((s) => s.name === "commit");
    const firstSkill = list.findIndex((s) => s.name === "domain-search");
    expect(lastCommand).toBeGreaterThanOrEqual(0);
    expect(firstSkill).toBeGreaterThan(lastCommand);
  });
});
