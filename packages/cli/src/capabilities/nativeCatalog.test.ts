// Fixture driven: every input here was recorded from the real `claude` binary
// and the real marketplace file on 2026-08-13 (see `__fixtures__/`). No test in
// this file spawns a process or touches the network — the parsers are pure, and
// the one function that would shell out takes an injected runner.

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isUsablePluginName,
  loadNativeCatalog,
  parseMarketplaceJson,
  parsePluginDetails,
  parsePluginListJson,
  parseTokenEstimate,
  readMarketplaceCatalog,
  readMarketplaceCatalogs,
  readPluginDetails,
  resolveOffer,
  resolvePluginRename,
  splitPluginId,
  sumAlwaysOn,
  toInventoryItems,
  type NativeCatalog,
} from "./nativeCatalog.js";

const FIXTURES = path.join(import.meta.dir, "__fixtures__");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");

/* ------------------------------------------------------------------ listing */

describe("parsePluginListJson", () => {
  const list = parsePluginListJson(fixture("claude-plugin-list.json"));

  test("reads the recorded `--available --json` shape", () => {
    expect(list.installed.length).toBe(5);
    expect(list.available.length).toBe(5);
  });

  test("splits `name@marketplace` and keeps the enablement states apart", () => {
    const simplifier = list.installed.find((p) => p.name === "code-simplifier");
    expect(simplifier?.marketplace).toBe("claude-plugins-official");
    expect(simplifier?.enabled).toBe(true);
    expect(simplifier?.version).toBe("1.0.0");

    // Downloaded and switched off is a real state the library shows as an offer.
    const ralph = list.installed.find((p) => p.name === "ralph-loop");
    expect(ralph?.enabled).toBe(false);
    expect(ralph?.scope).toBe("user");
  });

  test("keeps the checkout a project scoped install belongs to", () => {
    const playground = list.installed.find((p) => p.name === "playground");
    expect(playground?.scope).toBe("project");
    expect(playground?.projectPath).toBe("/Users/ashot/src/union-mobile/outreach");
  });

  test("normalises available rows, including install counts", () => {
    const sdk = list.available.find((p) => p.name === "agent-sdk-dev");
    expect(sdk?.pluginId).toBe("agent-sdk-dev@claude-code-plugins");
    expect(sdk?.marketplace).toBe("claude-code-plugins");
    expect(sdk?.source).toEqual({ kind: "path", raw: "./plugins/agent-sdk-dev", path: "./plugins/agent-sdk-dev" });

    const withCount = list.available.find((p) => p.installCount !== undefined);
    expect(typeof withCount?.installCount).toBe("number");
  });

  test("accepts the bare array `claude plugin list --json` returns without --available", () => {
    const bare = parsePluginListJson(JSON.stringify([
      { id: "a@m", scope: "user", enabled: true },
      { id: "b@m", scope: "local", enabled: false },
    ]));
    expect(bare.installed.map((p) => p.pluginId)).toEqual(["a@m", "b@m"]);
    expect(bare.installed[1].scope).toBe("local");
    expect(bare.available).toEqual([]);
  });

  test("survives chatter printed around the payload", () => {
    const noisy = `Update available: 2.1.300\n${fixture("claude-plugin-list.json")}\n`;
    expect(parsePluginListJson(noisy).installed.length).toBe(5);
  });

  test("malformed input yields empty, never a throw", () => {
    for (const input of ["", "not json", "{", "null", "[1,2,3]", JSON.stringify({ installed: "nope" })]) {
      const parsed = parsePluginListJson(input);
      expect(parsed.installed).toEqual([]);
      expect(parsed.available).toEqual([]);
    }
    expect(parsePluginListJson(undefined).installed).toEqual([]);
  });

  test("drops rows with no id rather than inventing one", () => {
    const parsed = parsePluginListJson(JSON.stringify({
      installed: [{ version: "1" }, { id: "ok@m" }, null, "x"],
      available: [{ description: "no name" }, { pluginId: "good@m" }],
    }));
    expect(parsed.installed.map((p) => p.pluginId)).toEqual(["ok@m"]);
    expect(parsed.available.map((p) => p.pluginId)).toEqual(["good@m"]);
  });
});

test("splitPluginId leaves a bare name alone", () => {
  expect(splitPluginId("foo@bar")).toEqual({ name: "foo", marketplace: "bar" });
  expect(splitPluginId("foo")).toEqual({ name: "foo" });
  expect(splitPluginId("@weird")).toEqual({ name: "@weird" });
});

describe("isUsablePluginName", () => {
  test("accepts the names real catalogs use, including non-ASCII", () => {
    for (const ok of ["code-simplifier", "42crunch-api-security-testing", "typescript_lsp", "日本語"]) {
      expect(isUsablePluginName(ok)).toBe(true);
    }
  });

  test("rejects anything that would land in argv as a flag or as another id", () => {
    for (const bad of [
      "--dangerously-skip-permissions",
      "-h",
      "",
      "two words",
      "../../etc/passwd",
      "a\\b",
      "evil@other-marketplace",
      "line\nbreak",
    ]) {
      expect(isUsablePluginName(bad)).toBe(false);
    }
  });
});

describe("a marketplace file cannot smuggle a flag into an argv position", () => {
  // `readPluginDetails` runs `claude plugin details <id>`, and `marketplace.json`
  // is written by whoever publishes the marketplace.
  const hostile = JSON.stringify({
    name: "evil-marketplace",
    plugins: [
      { name: "--dangerously-skip-permissions", description: "hi" },
      { name: "ok-plugin" },
      { name: "smuggled@claude-plugins-official" },
    ],
    renames: { legacy: "--print" },
  });

  test("the catalog parser drops the entry rather than composing an id from it", () => {
    const catalog = parseMarketplaceJson(hostile);
    expect(catalog?.plugins.map((p) => p.name)).toEqual(["ok-plugin"]);
    // A rename target is a name a caller would go on to ask the tool about.
    expect(catalog?.renames).toEqual({});
  });

  test("a marketplace that names itself a flag falls back to its directory", () => {
    const catalog = parseMarketplaceJson(JSON.stringify({ name: "--help", plugins: [{ name: "p" }] }), "cloned-dir");
    expect(catalog?.name).toBe("cloned-dir");
    expect(catalog?.plugins[0].pluginId).toBe("p@cloned-dir");
  });

  test("the listing parser recomposes the id from validated halves", () => {
    const parsed = parsePluginListJson(JSON.stringify({
      installed: [],
      available: [
        { pluginId: "a@m@extra", name: "a", marketplaceName: "m" },
        { pluginId: "-flag@m" },
        { name: "b", marketplaceName: "--flag" },
      ],
    }));
    expect(parsed.available.map((p) => p.pluginId)).toEqual(["a@m"]);
  });

  test("readPluginDetails refuses the id instead of running the tool", async () => {
    let ran = false;
    const result = await readPluginDetails("--dangerously-skip-permissions@evil", {
      run: async () => {
        ran = true;
        return { stdout: "" };
      },
    });
    expect(ran).toBe(false);
    expect(result.details).toBeNull();
    expect(result.error).toContain("refusing");
  });
});

/* -------------------------------------------------------------- marketplace */

describe("parseMarketplaceJson", () => {
  const catalog = parseMarketplaceJson(fixture("claude-marketplace.json"));

  test("reads the recorded official catalog", () => {
    expect(catalog?.name).toBe("claude-plugins-official");
    expect(catalog?.owner).toBe("Anthropic");
    expect(catalog?.plugins.length).toBe(8);
  });

  test("keeps the commit sha the catalog already records as the pin", () => {
    const crunch = catalog?.plugins.find((p) => p.name === "42crunch-api-security-testing");
    expect(crunch?.source).toEqual({
      kind: "git-subdir",
      raw: "git-subdir",
      url: "https://github.com/42Crunch-AI/claude-plugins.git",
      path: "plugins/api-security-testing",
      ref: "v1.5.5",
      sha: "30287f5e3f122a646d1ac5ca3ab96e130c52a3ad",
    });
    expect(crunch?.publisher).toBe("42Crunch");
    expect(crunch?.category).toBe("security");
  });

  test("carries the renames map the CLI listing omits", () => {
    expect(catalog?.renames["convex-backend"]).toBe("convex");
    expect(Object.keys(catalog?.renames ?? {}).length).toBe(4);
  });

  test("names the marketplace from its directory when the file does not", () => {
    const unnamed = parseMarketplaceJson(JSON.stringify({ plugins: [{ name: "x" }] }), "from-dir");
    expect(unnamed?.name).toBe("from-dir");
    expect(unnamed?.plugins[0].pluginId).toBe("x@from-dir");
    expect(parseMarketplaceJson(JSON.stringify({ plugins: [] }))).toBeNull();
  });

  test("drops rename values it cannot act on", () => {
    const odd = parseMarketplaceJson(JSON.stringify({
      name: "m",
      renames: { gone: null, moved: "here", broken: 7, blank: "  " },
      plugins: [],
    }));
    expect(odd?.renames).toEqual({ gone: null, moved: "here" });
  });

  test("malformed input yields null, never a throw", () => {
    for (const input of ["", "[]", "null", "not json", JSON.stringify({ name: 5 })]) {
      expect(parseMarketplaceJson(input)).toBeNull();
    }
  });
});

describe("resolvePluginRename", () => {
  const renames = { formatter: "code-formatter", "code-formatter": "formatter-pro", dropped: null };

  test("follows a chain to the current name", () => {
    const r = resolvePluginRename(renames, "formatter");
    expect(r.name).toBe("formatter-pro");
    expect(r.renamed).toBe(true);
    expect(r.chain).toEqual(["formatter", "code-formatter", "formatter-pro"]);
  });

  test("a null entry means the plugin was removed, which is not the same as unknown", () => {
    expect(resolvePluginRename(renames, "dropped")).toMatchObject({ name: null, renamed: true });
    expect(resolvePluginRename(renames, "never-heard-of")).toMatchObject({
      name: "never-heard-of",
      renamed: false,
    });
  });

  test("a cycle terminates instead of hanging", () => {
    const looped = resolvePluginRename({ a: "b", b: "a" }, "a");
    expect(looped.cycle).toBe(true);
    expect(looped.name).toBe("b");
  });

  test("no renames map at all is fine", () => {
    expect(resolvePluginRename(undefined, "x").name).toBe("x");
  });
});

test("resolveOffer follows renames and reports a removal", () => {
  const catalog: NativeCatalog = {
    installed: [],
    available: [
      { pluginId: "convex@claude-plugins-official", name: "convex", marketplace: "claude-plugins-official" },
    ],
    marketplaces: [
      {
        name: "claude-plugins-official",
        renames: { "convex-backend": "convex", retired: null },
        plugins: [],
      },
    ],
    origin: "disk",
  };

  expect(resolveOffer(catalog, "convex-backend@claude-plugins-official")).toMatchObject({
    removed: false,
    renamedFrom: "convex-backend",
  });
  expect(resolveOffer(catalog, "convex-backend@claude-plugins-official").offer?.name).toBe("convex");
  expect(resolveOffer(catalog, "retired@claude-plugins-official")).toMatchObject({
    offer: null,
    removed: true,
  });
  expect(resolveOffer(catalog, "unknown@claude-plugins-official").offer).toBeNull();
});

/* ------------------------------------------------------------------ details */

describe("parsePluginDetails", () => {
  test("a skill plugin: components, always-on cost, and the per component table", () => {
    const d = parsePluginDetails(fixture("claude-plugin-details-skill.txt"));
    expect(d?.name).toBe("frontend-design");
    expect(d?.description).toBe("Frontend design skill for UI/UX implementation");
    expect(d?.sourceId).toBe("frontend-design@claude-plugins-official");
    expect(d?.components.skills).toEqual(["frontend-design"]);
    expect(d?.components.agents).toEqual([]);
    expect(d?.alwaysOn).toEqual({ tokens: 86, underBound: false });
    expect(d?.perComponent).toEqual([
      {
        name: "frontend-design",
        alwaysOn: { tokens: 90, underBound: false },
        onInvoke: { tokens: 1400, underBound: false },
      },
    ]);
  });

  test("an agent plugin carries its version off the header line", () => {
    const d = parsePluginDetails(fixture("claude-plugin-details.txt"));
    expect(d?.name).toBe("code-simplifier");
    expect(d?.version).toBe("1.0.0");
    expect(d?.components.agents).toEqual(["code-simplifier"]);
    expect(d?.alwaysOn?.tokens).toBe(64);
  });

  test("a plugin with no cost table still reports its inventory", () => {
    const d = parsePluginDetails(fixture("claude-plugin-details-lsp.txt"));
    expect(d?.components.lspServers).toEqual(["typescript"]);
    expect(d?.alwaysOn).toEqual({ tokens: 0, underBound: false });
    expect(d?.perComponent).toEqual([]);
  });

  test("multiple components: comma separated names, trailing notes dropped, `< 20` kept as a ceiling", () => {
    const d = parsePluginDetails(fixture("claude-plugin-details-multi.txt"));
    expect(d?.components.skills).toEqual(["alpha", "beta-two", "gamma"]);
    expect(d?.components.agents).toEqual(["helper"]);
    // "(harness-only — no model context cost)" is commentary, not a component.
    expect(d?.components.hooks).toEqual(["PreToolUse", "Stop"]);
    expect(d?.components.mcpServers).toEqual(["srv-alpha", "srv-beta"]);
    expect(d?.components.lspServers).toEqual([]);
    expect(d?.alwaysOn).toEqual({ tokens: 63, underBound: false });

    const gamma = d?.perComponent.find((c) => c.name === "gamma");
    expect(gamma?.alwaysOn).toEqual({ tokens: 20, underBound: true });
    expect(gamma?.onInvoke).toEqual({ tokens: 220, underBound: false });
    // The prose under the table is not a row.
    expect(d?.perComponent.map((c) => c.name)).toEqual(["gamma", "alpha", "beta-two", "helper"]);
  });

  test("`not found` is an absent plugin, not a parse failure", () => {
    expect(parsePluginDetails(fixture("claude-plugin-details-notfound.txt"))).toBeNull();
  });

  test("junk yields null", () => {
    for (const input of ["", "   ", "some unrelated output\nwith no sections"]) {
      expect(parsePluginDetails(input)).toBeNull();
    }
  });

  test("carriage returns do not defeat the line parser", () => {
    const crlf = fixture("claude-plugin-details-skill.txt").replace(/\n/g, "\r\n");
    expect(parsePluginDetails(crlf)?.alwaysOn?.tokens).toBe(86);
  });
});

describe("readPluginDetails", () => {
  test("reads the cost when the tool answers", async () => {
    const result = await readPluginDetails("frontend-design@claude-plugins-official", {
      run: async (args) => {
        expect(args).toEqual(["plugin", "details", "frontend-design@claude-plugins-official"]);
        return { stdout: fixture("claude-plugin-details-skill.txt") };
      },
    });
    expect(result.details?.alwaysOn).toEqual({ tokens: 86, underBound: false });
    expect(result.error).toBeUndefined();
  });

  test("`not found` is a plugin without a cost badge, not a failure", async () => {
    // The tool prints this on stdout and exits non-zero, so the exit code alone
    // would report an ordinary absence as something being wrong.
    const result = await readPluginDetails("ralph-loop@claude-plugins-official", {
      run: async () => ({ stdout: fixture("claude-plugin-details-notfound.txt"), error: "Command failed: claude" }),
    });
    expect(result).toEqual({ details: null });
  });

  test("a timeout says so, instead of reading as a plugin with no cost data", async () => {
    const result = await readPluginDetails("code-simplifier@claude-plugins-official", {
      run: async () => ({ stdout: "", error: "claude timed out" }),
    });
    expect(result).toEqual({ details: null, error: "claude timed out" });
  });

  test("output that describes nothing, with no error, still names the problem", async () => {
    const result = await readPluginDetails("x@m", { run: async () => ({ stdout: "surprise!" }) });
    expect(result.details).toBeNull();
    expect(result.error).toBe("claude printed no plugin details");
  });
});

describe("parseTokenEstimate", () => {
  test("every printed form the tool uses", () => {
    expect(parseTokenEstimate("~86 tok")).toEqual({ tokens: 86, underBound: false });
    expect(parseTokenEstimate("~1.4k")).toEqual({ tokens: 1400, underBound: false });
    expect(parseTokenEstimate("< 20")).toEqual({ tokens: 20, underBound: true });
    expect(parseTokenEstimate("~0 tok   added to every session")).toEqual({ tokens: 0, underBound: false });
    expect(parseTokenEstimate("~1.2M")).toEqual({ tokens: 1_200_000, underBound: false });
    expect(parseTokenEstimate("1,250")).toEqual({ tokens: 1250, underBound: false });
  });

  test("anything unrecognised costs one number, not the whole reading", () => {
    expect(parseTokenEstimate("n/a")).toBeUndefined();
    expect(parseTokenEstimate("")).toBeUndefined();
  });
});

test("sumAlwaysOn keeps a total built from ceilings marked as a ceiling", () => {
  const exact = parsePluginDetails(fixture("claude-plugin-details-skill.txt"));
  const agent = parsePluginDetails(fixture("claude-plugin-details.txt"));
  expect(sumAlwaysOn([exact, agent, null])).toEqual({ tokens: 150, underBound: false });
  expect(sumAlwaysOn([{ name: "x", components: { skills: [], agents: [], hooks: [], mcpServers: [], lspServers: [] }, perComponent: [], alwaysOn: { tokens: 20, underBound: true } }]))
    .toEqual({ tokens: 20, underBound: true });
  expect(sumAlwaysOn([])).toEqual({ tokens: 0, underBound: false });
});

/* --------------------------------------------------------------------- disk */

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-"));
  const dir = path.join(home, ".claude", "plugins", "marketplaces", "claude-plugins-official", ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marketplace.json"), fixture("claude-marketplace.json"));
  return home;
}

describe("reading the cloned catalogs", () => {
  test("finds a marketplace by directory name", () => {
    const home = makeHome();
    expect(readMarketplaceCatalog(home, "claude-plugins-official")?.plugins.length).toBe(8);
    expect(readMarketplaceCatalog(home, "not-cloned")).toBeNull();
    expect(readMarketplaceCatalogs(home).map((m) => m.name)).toEqual(["claude-plugins-official"]);
  });

  test("a machine with nothing cloned yields nothing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-empty-"));
    expect(readMarketplaceCatalogs(empty)).toEqual([]);
  });

  test("a marketplace registered but not cloned is skipped, not guessed at", () => {
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({ "never-cloned": { source: { source: "github", repo: "a/b" } } }),
    );
    expect(readMarketplaceCatalogs(home).map((m) => m.name)).toEqual(["claude-plugins-official"]);
  });

  test("an unreadable catalog file drops that marketplace only", () => {
    const home = makeHome();
    const dir = path.join(home, ".claude", "plugins", "marketplaces", "broken", ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marketplace.json"), "{ truncated");
    expect(readMarketplaceCatalogs(home).map((m) => m.name)).toEqual(["claude-plugins-official"]);
  });
});

/* ------------------------------------------------------------------ loading */

describe("loadNativeCatalog", () => {
  test("uses the tool when it answers, and enriches from the catalog file", async () => {
    const home = makeHome();
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({ stdout: fixture("claude-plugin-list.json") }),
    });
    expect(catalog.origin).toBe("cli");
    expect(catalog.installed.length).toBe(5);
    expect(catalog.degraded).toBeUndefined();

    // The listing knows nothing about authors or categories; the cloned file does.
    const crunch = catalog.available.find((p) => p.name === "42crunch-api-security-testing");
    expect(crunch?.publisher).toBe("42Crunch");
    expect(crunch?.source?.sha).toBe("30287f5e3f122a646d1ac5ca3ab96e130c52a3ad");
  });

  test("the catalog keeps the plugins the tool withholds because they are installed", async () => {
    // Claude Code drops an installed, loadable plugin from `--available`. The
    // recorded listing offers 5 and installs 5; `code-simplifier` is installed,
    // sits in the cloned marketplace file, and appears in neither `available`
    // list — which is exactly the plugin a library must not lose.
    const home = makeHome();
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({ stdout: fixture("claude-plugin-list.json") }),
    });
    const names = catalog.available.map((p) => p.pluginId);
    expect(names).toContain("code-simplifier@claude-plugins-official");
    expect(names).toContain("agent-sdk-dev@claude-code-plugins");
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(11);
    expect(catalog.degraded).toBeUndefined();

    // And the same plugin resolves, which is what a settings file naming it asks.
    expect(resolveOffer(catalog, "code-simplifier@claude-plugins-official").offer?.name).toBe(
      "code-simplifier",
    );
  });

  test("an old binary that ignores --available still yields a catalog, and says why counts are gone", async () => {
    // `claude plugin list --json` without `--available` answers with a bare array
    // of installed rows. The union covers the catalog; the phrase covers the UI.
    const home = makeHome();
    const listed = JSON.parse(fixture("claude-plugin-list.json")) as { installed: unknown[] };
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({ stdout: JSON.stringify(listed.installed) }),
    });
    expect(catalog.origin).toBe("cli");
    expect(catalog.installed.length).toBe(5);
    expect(catalog.available.length).toBe(8);
    expect(catalog.degraded).toContain("listed no installable plugins");
    expect(catalog.degraded).toContain("upgrade claude");
  });

  test("nothing installed is not a degraded machine", async () => {
    const home = makeHome();
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({
        stdout: JSON.stringify({
          installed: [],
          available: [{ pluginId: "semgrep@claude-plugins-official", name: "semgrep", marketplaceName: "claude-plugins-official" }],
        }),
      }),
    });
    expect(catalog.degraded).toBeUndefined();
    expect(catalog.available.length).toBe(8);
  });

  test("a missing binary degrades to the cloned catalogs instead of failing", async () => {
    const home = makeHome();
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({ stdout: "", error: "claude is not on PATH" }),
    });
    expect(catalog.origin).toBe("disk");
    expect(catalog.degraded).toBe("claude is not on PATH");
    expect(catalog.available.length).toBe(8);
    expect(catalog.installed).toEqual([]);
  });

  test("a timeout degrades the same way", async () => {
    const home = makeHome();
    const catalog = await loadNativeCatalog({
      home,
      run: async () => ({ stdout: "", error: "claude timed out" }),
    });
    expect(catalog.origin).toBe("disk");
    expect(catalog.degraded).toBe("claude timed out");
  });

  test("output that parses to nothing degrades rather than reporting an empty machine", async () => {
    const home = makeHome();
    const catalog = await loadNativeCatalog({ home, run: async () => ({ stdout: "surprise!" }) });
    expect(catalog.origin).toBe("disk");
    expect(catalog.degraded).toBe("claude returned no plugins");
    expect(catalog.available.length).toBe(8);
  });

  test("preferDisk never spawns anything", async () => {
    const home = makeHome();
    let called = false;
    const catalog = await loadNativeCatalog({
      home,
      preferDisk: true,
      run: async () => {
        called = true;
        return { stdout: "" };
      },
    });
    expect(called).toBe(false);
    expect(catalog.origin).toBe("disk");
  });

  test("a machine with no claude and no catalogs is empty, not broken", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-none-"));
    const catalog = await loadNativeCatalog({
      home: empty,
      run: async () => ({ stdout: "", error: "claude is not on PATH" }),
    });
    expect(catalog).toMatchObject({ origin: "none", installed: [], available: [], marketplaces: [] });
  });
});

test("toInventoryItems produces rows the fleet diff already understands", () => {
  const list = parsePluginListJson(fixture("claude-plugin-list.json"));
  const items = toInventoryItems(list.installed, "claude plugin list");
  const playground = items.find((i) => i.name === "playground@claude-plugins-official");
  expect(playground).toMatchObject({
    kind: "plugin",
    scope: "project",
    enabled: false,
    installed: true,
  });
  expect(playground?.meta).toMatchObject({
    plugin: "playground",
    marketplace: "claude-plugins-official",
    projectPath: "/Users/ashot/src/union-mobile/outreach",
  });
});
