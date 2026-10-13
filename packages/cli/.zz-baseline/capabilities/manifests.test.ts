// Fixture driven: the SKILL.md files, plugin directories, marketplace catalog
// and .mcp.json inputs under `__fixtures__/manifests/` were copied from a real
// machine on 2026-08-14 (a real skills tree, the cloned claude-plugins-official
// marketplace, Claude Code's own plugin cache and registry). The malformed
// variants — a mismatched name, an overlength description, a typeless MCP url —
// are synthetic, built to exercise exactly one reported issue each, as is the
// `nested` plugin (namespaced commands in subdirectories). Anything hostile —
// a `../` traversal, a symlink out of the plugin, a phantom declared path — is
// built inside the test in a temp directory, so no fixture carries a live
// escape. No test touches the network or a process; every reader takes a
// fixture path.

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { deriveExecutionSurfaces } from "@codecast/shared/contracts";
import {
  parseMarketplaceManifest,
  parseMcpJson,
  parsePluginJson,
  parseSkillMd,
  readInstalledPluginObservations,
  readPluginObservation,
  readSkillObservation,
  toManifestMcp,
} from "./manifests.js";

const FIXTURES = path.join(import.meta.dir, "__fixtures__", "manifests");
const fixture = (...parts: string[]) => path.join(FIXTURES, ...parts);
const read = (...parts: string[]) => fs.readFileSync(fixture(...parts), "utf-8");

/* ------------------------------------------------------------------ SKILL.md */

describe("readSkillObservation", () => {
  test("a plain portable skill parses clean, with its scripts walked", () => {
    const obs = readSkillObservation(fixture("skills", "domain-search"));
    expect(obs).not.toBeNull();
    expect(obs!.name).toBe("domain-search");
    expect(obs!.portable.name).toBe("domain-search");
    expect(obs!.portable.description).toContain("domain name availability");
    expect(obs!.issues).toEqual([]);
    // The walk is what gives deriveExecutionSurfaces real structure.
    expect(obs!.manifest.scripts).toEqual(["scripts/check-domains.sh"]);
    expect(deriveExecutionSurfaces(obs!.manifest)).toContain("ships_scripts");
  });

  test("license and a metadata map come through as portable fields", () => {
    const obs = readSkillObservation(fixture("skills", "improve"));
    expect(obs!.portable.license).toBe("MIT");
    expect(obs!.portable.metadata).toEqual({ author: "shadcn", version: "1.0.0" });
    expect(obs!.issues).toEqual([]);
  });

  test("argument-hint parses and is marked claude-only; allowed-tools stays portable", () => {
    const obs = readSkillObservation(fixture("skills", "example-command"));
    expect(obs!.claudeOnly["argument-hint"]).toBe("<required-arg> [optional-arg]");
    expect(obs!.portable.allowedTools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(obs!.manifest.allowedTools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(deriveExecutionSurfaces(obs!.manifest)).toContain("declares_allowed_tools");
    expect(obs!.issues).toEqual([]);
  });

  test("the directory name wins over a mismatched frontmatter name, and the mismatch is reported", () => {
    const obs = readSkillObservation(fixture("skills", "wrong-name"));
    expect(obs!.name).toBe("wrong-name");
    expect(obs!.portable.name).toBe("something-else-entirely");
    expect(obs!.issues.map((i) => i.code)).toContain("name_mismatch");
  });

  test("a description over 1024 chars is preserved raw and flagged over-length", () => {
    const obs = readSkillObservation(fixture("skills", "overlength"));
    expect(obs!.portable.description!.length).toBe(1100);
    expect(obs!.issues.map((i) => i.code)).toContain("description_overlength");
  });

  test("no frontmatter is an issue, not a throw", () => {
    const obs = readSkillObservation(fixture("skills", "no-frontmatter"));
    expect(obs!.issues.map((i) => i.code)).toContain("missing_frontmatter");
  });

  test("a field in neither list lands in the unknown bucket", () => {
    const obs = readSkillObservation(fixture("skills", "unknown-field"));
    expect(obs!.unknown["version"]).toBe("1.0.0");
    expect(obs!.claudeOnly).toEqual({});
  });

  test("a scalar-valued metadata entry stays a string", () => {
    const obs = readSkillObservation(fixture("skills", "remotion-best-practices"));
    expect(obs!.portable.metadata?.tags).toContain("remotion");
  });

  test("a bare .md file is read with the file stem as its identity", () => {
    const obs = readSkillObservation(fixture("plugins", "example-plugin", "commands", "example-command.md"));
    expect(obs!.name).toBe("example-command");
  });

  test("a path with nothing to observe yields null", () => {
    expect(readSkillObservation(fixture("skills", "does-not-exist"))).toBeNull();
  });
});

describe("parseSkillMd frontmatter forms", () => {
  test("hooks in frontmatter surface as manifest hook events", () => {
    const obs = parseSkillMd(
      "---\nname: hooky\ndescription: d\nhooks:\n  PreToolUse: ./check.sh\n---\n",
      "hooky",
    );
    expect(obs.manifest.hooks).toEqual(["PreToolUse"]);
    expect(deriveExecutionSurfaces(obs.manifest)).toContain("declares_hooks");
  });

  test("allowed-tools accepts comma and space separated strings", () => {
    expect(
      parseSkillMd("---\nname: a\ndescription: d\nallowed-tools: Read, Grep, Bash(git:*)\n---\n", "a")
        .portable.allowedTools,
    ).toEqual(["Read", "Grep", "Bash(git:*)"]);
    expect(
      parseSkillMd("---\nname: a\ndescription: d\nallowed-tools: Read Grep\n---\n", "a").portable
        .allowedTools,
    ).toEqual(["Read", "Grep"]);
  });

  test("a comma inside a tool grant's parens does not split the grant", () => {
    // Splitting "Bash(git add, git commit)" in half would put two mangled
    // grants on the consent screen.
    expect(
      parseSkillMd("---\nname: a\ndescription: d\nallowed-tools: Read, Bash(git add, git commit)\n---\n", "a")
        .portable.allowedTools,
    ).toEqual(["Read", "Bash(git add, git commit)"]);
    // Space separated, with the only comma inside parens: still space mode.
    expect(
      parseSkillMd("---\nname: a\ndescription: d\nallowed-tools: Read Bash(git add, git commit)\n---\n", "a")
        .portable.allowedTools,
    ).toEqual(["Read", "Bash(git add, git commit)"]);
  });

  test("a quoted inline-array entry keeps its inner comma and loses its quotes", () => {
    const obs = parseSkillMd(
      '---\nname: a\ndescription: d\nallowed-tools: ["Bash(a, b)", "Read"]\n---\n',
      "a",
    );
    expect(obs.portable.allowedTools).toEqual(["Bash(a, b)", "Read"]);
    // No literal quote characters survive into the manifest.
    expect(JSON.stringify(obs.manifest)).not.toContain('\\"');
  });

  test("underscore spellings classify the same as hyphenated ones", () => {
    const obs = parseSkillMd(
      "---\nname: a\ndescription: d\ndisable_model_invocation: true\n---\n",
      "a",
    );
    expect(obs.claudeOnly["disable_model_invocation"]).toBe("true");
    expect(obs.unknown).toEqual({});
  });
});

/* --------------------------------------------------------------- plugin.json */

describe("parsePluginJson", () => {
  test("the real ralph-loop manifest parses clean", () => {
    const obs = parsePluginJson(
      read("home", ".claude", "plugins", "cache", "claude-plugins-official", "ralph-loop", "1.0.0", ".claude-plugin", "plugin.json"),
    );
    expect(obs.name).toBe("ralph-loop");
    expect(obs.author?.name).toBe("Anthropic");
    expect(obs.issues).toEqual([]);
  });

  test("a missing name is an issue; garbage is unparseable", () => {
    expect(parsePluginJson("{}").issues.map((i) => i.code)).toContain("missing_name");
    expect(parsePluginJson("not json").issues.map((i) => i.code)).toContain("unparseable");
  });

  test("userConfig options keep their sensitive flag", () => {
    const obs = parsePluginJson(read("plugins", "declared", ".claude-plugin", "plugin.json"));
    expect(obs.userConfig?.apiKey?.sensitive).toBe(true);
    expect(obs.userConfig?.apiKey?.required).toBe(true);
    expect(obs.userConfig?.workdir?.sensitive).toBe(false);
  });
});

describe("readPluginObservation", () => {
  test("skills paths ADD to the default scan while commands paths REPLACE it", () => {
    const obs = readPluginObservation(fixture("plugins", "declared"));
    expect(obs!.manifest.components?.skill).toEqual(["added-skill", "default-skill"]);
    expect(obs!.manifest.components?.command).toEqual(["alt-cmd"]);
  });

  test("a plugin with bin/ reports a bin component", () => {
    const obs = readPluginObservation(fixture("plugins", "with-bin"));
    expect(obs!.manifest.bin).toEqual(["bin/tool.sh"]);
    expect(deriveExecutionSurfaces(obs!.manifest)).toContain("ships_bin");
  });

  test("the real example-plugin: skills, a command, and a bare-map .mcp.json", () => {
    const obs = readPluginObservation(fixture("plugins", "example-plugin"));
    expect(obs!.name).toBe("example-plugin");
    expect(obs!.manifest.components?.skill).toEqual(["example-command", "example-skill"]);
    expect(obs!.manifest.components?.command).toEqual(["example-command"]);
    // The plugin's .mcp.json has NO mcpServers wrapper — servers sit at the
    // top level. Verified real shape.
    expect(obs!.manifest.components?.mcp).toEqual(["example-server"]);
    expect(obs!.manifest.mcp).toEqual([{ name: "example-server", url: "https://mcp.example.com/api" }]);
  });

  test("the real ralph-loop install: hooks and scripts observed", () => {
    const obs = readPluginObservation(
      fixture("home", ".claude", "plugins", "cache", "claude-plugins-official", "ralph-loop", "1.0.0"),
    );
    expect(obs!.manifest.hooks).toEqual(["Stop"]);
    expect(obs!.manifest.components?.hook).toEqual(["Stop"]);
    expect(obs!.manifest.components?.command).toEqual(["cancel-ralph", "help", "ralph-loop"]);
    expect(obs!.manifest.scripts).toEqual(["scripts/setup-ralph-loop.sh"]);
    const surfaces = deriveExecutionSurfaces(obs!.manifest);
    expect(surfaces).toContain("declares_hooks");
    expect(surfaces).toContain("ships_scripts");
  });

  test("nested command directories observe as namespaced names", () => {
    const obs = readPluginObservation(fixture("plugins", "nested"));
    // commands/git/sync.md is the namespaced command "git/sync" — a flat scan
    // would drop it from both the components and the hash.
    expect(obs!.manifest.components?.command).toEqual(["git/sync", "top"]);
  });

  test("a component path escaping the plugin directory is refused and reported", () => {
    // Built on the fly so no fixture carries a live traversal.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(require("os").tmpdir()), "manifests-escape-"));
    try {
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "escapee", skills: ["../outside"] }),
      );
      const obs = readPluginObservation(dir);
      expect(obs!.issues.map((i) => i.code)).toContain("component_path_invalid");
      expect(obs!.manifest.components?.skill).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a symlink that leaves the plugin is an escape, not a component source", () => {
    // The lexical guard alone would pass "./link": the string resolves inside
    // the plugin while the link points outside it. Git carries symlinks, so a
    // cloned plugin cache can ship exactly this.
    const base = fs.mkdtempSync(path.join(fs.realpathSync(require("os").tmpdir()), "manifests-symlink-"));
    try {
      const outside = path.join(base, "outside", "sneaky");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: sneaky\ndescription: not yours\n---\n");
      const plugin = path.join(base, "plugin");
      fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "symlinker", skills: ["./link"] }),
      );
      fs.symlinkSync(path.join(base, "outside"), path.join(plugin, "link"));
      const obs = readPluginObservation(plugin);
      expect(obs!.manifest.components?.skill).toBeUndefined();
      expect(obs!.issues.map((i) => i.code)).toContain("component_path_invalid");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("a declared path with nothing on disk is an issue, never a component — and never a fallback", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(require("os").tmpdir()), "manifests-phantom-"));
    try {
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      // The default commands/ dir holds a real command, but plugin.json
      // REPLACES it with a path that does not exist.
      fs.mkdirSync(path.join(dir, "commands"));
      fs.writeFileSync(path.join(dir, "commands", "real.md"), "---\ndescription: d\n---\n");
      fs.writeFileSync(
        path.join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "phantom", commands: ["./commands/not-there.md"] }),
      );
      const obs = readPluginObservation(dir);
      // Not the phantom (it is not on disk), and not "real" either (the
      // declaration replaced the default directory).
      expect(obs!.manifest.components?.command).toBeUndefined();
      const issue = obs!.issues.find((i) => i.code === "component_path_invalid");
      expect(issue?.detail).toContain("not-there.md");
      expect(issue?.detail).toContain("does not exist");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that is not there yields null", () => {
    expect(readPluginObservation(fixture("plugins", "nope"))).toBeNull();
  });
});

/* ----------------------------------------------------------------- .mcp.json */

describe("parseMcpJson", () => {
  test("the real project file: wrapper shape, typeless command defaults to stdio", () => {
    const doc = parseMcpJson(read("mcp-superset.json"));
    expect(doc.servers.length).toBe(8);
    const maestro = doc.servers.find((s) => s.name === "maestro");
    expect(maestro?.transport).toBe("stdio");
    expect(maestro?.command).toBe("maestro");
    const superset = doc.servers.find((s) => s.name === "superset");
    expect(superset?.transport).toBe("http");
    expect(doc.issues).toEqual([]);
  });

  test("a url with no type is reported, and the transport is not invented", () => {
    const doc = parseMcpJson(read("mcp-url-no-type.json"));
    const bad = doc.servers.find((s) => s.name === "typeless-remote");
    expect(bad?.transport).toBeUndefined();
    expect(doc.issues.map((i) => i.code)).toContain("mcp_url_missing_type");
  });

  test("env keys are names only — values never enter the observation", () => {
    const doc = parseMcpJson(read("mcp-url-no-type.json"));
    const stdio = doc.servers.find((s) => s.name === "good-stdio");
    expect(stdio?.envKeys).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(doc)).not.toContain("secret-value");
  });

  test("header names are kept, header values are not, ${VAR} refs count as env keys", () => {
    const doc = parseMcpJson({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://example.com/${REGION}/mcp",
          headers: { Authorization: "Bearer ${MY_TOKEN}" },
        },
        local: { command: "run", args: ["--root", "${CLAUDE_PLUGIN_ROOT}/bin"] },
      },
    });
    const remote = doc.servers.find((s) => s.name === "remote");
    expect(remote?.headerNames).toEqual(["Authorization"]);
    expect(remote?.envKeys).toEqual(["MY_TOKEN", "REGION"]);
    expect(JSON.stringify(doc)).not.toContain("Bearer ");
    // Variables Claude Code itself supplies are not wants.
    expect(doc.servers.find((s) => s.name === "local")?.envKeys).toBeUndefined();
  });

  test("toManifestMcp joins the command line the way the inventory does", () => {
    const doc = parseMcpJson({ srv: { command: "npx", args: ["-y", "pkg"] } });
    expect(toManifestMcp(doc.servers)).toEqual([{ name: "srv", command: "npx -y pkg" }]);
  });

  test("garbage is an issue, not a throw", () => {
    expect(parseMcpJson("nope").issues.map((i) => i.code)).toContain("unparseable");
  });

  test("a server with neither command nor url is reported by name, not dropped silently", () => {
    const doc = parseMcpJson({ mcpServers: { broken: { type: "http" }, ok: { command: "run" } } });
    expect(doc.servers.map((s) => s.name)).toEqual(["ok"]);
    const issue = doc.issues.find((i) => i.code === "mcp_server_invalid");
    expect(issue?.detail).toContain('"broken"');
    expect(issue?.detail).toContain("neither a command nor a url");
  });
});

/* ----------------------------------------------------------- marketplace.json */

describe("parseMarketplaceManifest", () => {
  const manifest = parseMarketplaceManifest(read("marketplace.json"))!;

  test("the catalog itself comes from parseMarketplaceJson, unrepeated", () => {
    expect(manifest.catalog.name).toBe("claude-plugins-official");
    expect(manifest.catalog.plugins.map((p) => p.name).sort()).toEqual([
      "amd-skills",
      "box",
      "clangd-lsp",
      "ralph-loop",
    ]);
    // The sha pin survives through the reused parser.
    expect(manifest.catalog.plugins.find((p) => p.name === "amd-skills")?.source?.sha).toBe(
      "11c8edb0aee051b87640146bae38c82b22dff86f",
    );
  });

  test("strict:false lets the marketplace entry own the component definitions", () => {
    const amd = manifest.extras["amd-skills"];
    expect(amd?.strict).toBe(false);
    expect(amd?.components?.skills).toEqual([
      "./local-ai-use",
      "./local-ai-app-integration",
      "./serving-llms-on-instinct",
      "./tracelens-analysis-orchestrator",
    ]);
    // Inline lspServers on a strict:false entry report their declared names.
    const clangd = manifest.extras["clangd-lsp"];
    expect(clangd?.strict).toBe(false);
    expect(clangd?.components?.lspServers).toEqual(["clangd"]);
  });

  test("an entry with overrides but no strict flag stays strict", () => {
    const box = manifest.extras["box"];
    expect(box?.strict).toBe(true);
    expect(box?.components?.skills?.length).toBe(5);
  });

  test("a plain entry contributes no extras, and garbage input is null", () => {
    expect(manifest.extras["ralph-loop"]).toBeUndefined();
    expect(parseMarketplaceManifest("not json")).toBeNull();
  });
});

/* ------------------------------------------------------------ installed pins */

describe("readInstalledPluginObservations", () => {
  test("gitCommitSha is carried through per install, next to the observed manifest", () => {
    const installs = readInstalledPluginObservations(fixture("home"));
    expect(installs.length).toBe(1);
    const ralph = installs[0];
    expect(ralph.pluginId).toBe("ralph-loop@claude-plugins-official");
    // The pin exactly as Claude Code's registry recorded it.
    expect(ralph.sha).toBe("b36fd4b753018b0b340803579399992a32e43502");
    expect(ralph.version).toBe("1.0.0");
    expect(ralph.scope).toBe("user");
    // And the cached bytes were found and observed through the same layout.
    expect(ralph.observation?.name).toBe("ralph-loop");
    expect(ralph.observation?.manifest.hooks).toEqual(["Stop"]);
  });

  test("a home with no registry yields an empty list", () => {
    expect(readInstalledPluginObservations(fixture("skills"))).toEqual([]);
  });
});
