import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RemoteHost } from "../remote/session-move";
import {
  commandWords, GH_DEFAULT_VERSION, HOST_TOOLS_REMOTE_COMMAND, hostToolsDetailLines, hostToolsScript, isMachO, minMajorOfRange, NODE_22_VERSION,
  NODE_FLOOR_MAJOR, NODE_INSTALL_MAJOR, nodeRequirement, parseHostToolsOutput, parseHostToolsStamp, requiredHostTools, runHostTools, safeVersion, scanMirroredHelpers,
  settingsHookCommands, shebangInterpreter, summarizeHostTools, type McpSources, type RequiredHostTools,
  classifyMcp, codecastFileWriteCommand, mcpChecks, parseCodexMcpServers, parseMcpLines, readMcpSources, reconcileMcp, staticMcpVerdict,
} from "./hostTools";
import { ghWrapperScript, REAL_GH_REL } from "./ghWrapper";

let dir: string, home: string, repo: string;
let savedEnv: NodeJS.ProcessEnv;
const host: RemoteHost = { address: "cloud-test.invalid", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-tools-test-")));
  home = path.join(dir, "home");
  repo = path.join(dir, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string | Buffer, mode = 0o644): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
}

describe("nodeRequirement — engines resolution order", () => {
  test("the installed convex package's engines first, then repo pins, then the laptop's node; never below the floor", () => {
    write(repo, "packages/convex/node_modules/convex/package.json", JSON.stringify({ version: "1.30.0", engines: { node: ">=22.0.0" } }));
    write(repo, ".nvmrc", "20\n");
    write(repo, "package.json", JSON.stringify({ engines: { node: ">=18" } }));
    expect(nodeRequirement(repo, 24)).toEqual({ minMajor: 22, install: NODE_22_VERSION, source: "convex 1.30.0 engines" });
    fs.rmSync(path.join(repo, "packages"), { recursive: true });
    expect(nodeRequirement(repo, 24)).toEqual({ minMajor: 20, install: NODE_22_VERSION, source: ".nvmrc" });
    fs.unlinkSync(path.join(repo, ".nvmrc"));
    expect(nodeRequirement(repo, 24).source).toBe("package.json engines (raised to 20)");
    expect(nodeRequirement(repo, 24).minMajor).toBe(NODE_FLOOR_MAJOR);
    fs.unlinkSync(path.join(repo, "package.json"));
    // The laptop's node is a hint capped at what the tarball provides: a laptop on 24 must not make a host on 22 "missing" forever.
    expect(nodeRequirement(repo, 24)).toEqual({ minMajor: NODE_INSTALL_MAJOR, install: NODE_22_VERSION, source: `laptop node (capped at ${NODE_INSTALL_MAJOR})` });
    expect(nodeRequirement(repo, 21)).toEqual({ minMajor: 21, install: NODE_22_VERSION, source: "laptop node" });
    expect(nodeRequirement(undefined, undefined)).toEqual({ minMajor: 20, install: NODE_22_VERSION, source: "floor 20" });
  });
  test("a convex engines of >=18 (today's) is raised to the floor and says so", () => {
    write(repo, "packages/convex/node_modules/convex/package.json", JSON.stringify({ version: "1.2.3", engines: { node: ">=18.0.0" } }));
    expect(nodeRequirement(repo, 18)).toEqual({ minMajor: 20, install: NODE_22_VERSION, source: "convex 1.2.3 engines (raised to 20)" });
  });
  test("minMajorOfRange", () => {
    expect(minMajorOfRange(">=18.0.0")).toBe(18);
    expect(minMajorOfRange("^20 || >=22")).toBe(20);
    expect(minMajorOfRange("22.x")).toBe(22);
    expect(minMajorOfRange("v22.12.0")).toBe(22);
    expect(minMajorOfRange("lts/*")).toBeUndefined();
    expect(minMajorOfRange(undefined)).toBeUndefined();
  });
});

describe("helper extraction from hook commands, shebangs and skill text", () => {
  test("commandWords: env assignments, pipes, && and subshells; builtins and keywords dropped", () => {
    expect(commandWords("bash ~/.claude/hooks/x.sh")).toEqual(["bash"]);
    expect(commandWords("FOO=1 rg --json 'x' | jq .name && shellcheck f.sh; if [ -x y ]; then frob; fi")).toEqual(["rg", "jq", "shellcheck", "frob"]);
    expect(commandWords('echo "cat | rm" # cat')).toEqual(["echo"]);
    expect(commandWords("timeout 30 node script.js || exit 1")).toEqual(["node"]);
    expect(commandWords("~/.local/bin/mytool --flag")).toEqual(["mytool"]);
  });
  test("shebangInterpreter", () => {
    expect(shebangInterpreter("#!/usr/bin/env bash\necho")).toBe("bash");
    expect(shebangInterpreter("#!/bin/sh\n")).toBe("sh");
    expect(shebangInterpreter("#!/usr/bin/env -S deno run\n")).toBe("-S");
    expect(shebangInterpreter("echo no shebang")).toBeUndefined();
  });
  test("settingsHookCommands walks every hook group", () => {
    expect(settingsHookCommands({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }, { type: "prompt", command: "ignored" }] }], Stop: [{ hooks: [{ command: "b" }] }] } })).toEqual(["a", "b"]);
    expect(settingsHookCommands(undefined)).toEqual([]);
  });
  test("a hook `bash ~/.claude/hooks/x.sh` and a skill's `uvx foo` produce bash/uv requirements; unknown helpers carry their referencing file", () => {
    write(home, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/x.sh" }] }] } }));
    write(home, ".claude/hooks/x.sh", "#!/usr/bin/env bash\nset -e\nshellcheck \"$1\"\nrg foo | head -1\n");
    write(home, ".claude/skills/py/SKILL.md", "# skill\nRun `uvx ruff check` first.\n");
    write(home, ".claude/skills/py/run.sh", "#!/bin/sh\npython3 x.py\n");
    const scan = scanMirroredHelpers({ laptopHome: home });
    expect(scan.needsUv).toBe(true);
    expect(scan.tools.map((t) => t.tool).sort()).toEqual(["rg", "shellcheck"]);
    expect(scan.tools.find((t) => t.tool === "shellcheck")?.referenced_by).toBe("~/.claude/hooks/x.sh");
    expect(scan.unsupported).toEqual([]);
    const required = requiredHostTools({ laptopHome: home, repoRoot: repo, versions: { node: "22.1.0", bun: "1.4.0", clients: { codex: "0.153.4" } } });
    expect(required.tools.map((t) => t.tool)).toEqual(["gh", "uv", "shellcheck", "rg"]);
    expect(required.tools[0]).toEqual({ tool: "gh", version: GH_DEFAULT_VERSION, referenced_by: "the authorized GitHub workflow" });
    expect(required.bun).toBe("1.4.0");
    expect(required.clients).toEqual({ codex: "0.153.4" });
    expect(required.node.minMajor).toBe(22);
  });
  test("a Mach-O file under hooks is reported unsupported with its path and is not a helper requirement", () => {
    write(home, ".claude/hooks/notify", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]), 0o755);
    write(home, ".claude/skills/mac/bin/helper", Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]), 0o755);
    write(home, ".claude/hooks/ok.sh", "#!/bin/bash\necho hi\n", 0o755);
    expect(isMachO(path.join(home, ".claude/hooks/notify"))).toBe(true);
    expect(isMachO(path.join(home, ".claude/hooks/ok.sh"))).toBe(false);
    const scan = scanMirroredHelpers({ laptopHome: home });
    expect(scan.unsupported.map((u) => u.tool).sort()).toEqual(["~/.claude/hooks/notify", "~/.claude/skills/mac/bin/helper"]);
    expect(scan.unsupported[0].reason).toMatch(/Mach-O/);
    expect(scan.tools).toEqual([]);
    const script = hostToolsScript(requiredHostTools({ laptopHome: home, versions: { node: "22.0.0" } }));
    expect(script).toContain("~/.claude/hooks/notify");
    expect(script).not.toContain("hooks/notify\" >");
    expect(script).not.toContain("chmod +x");
  });
});

describe("hostToolsScript shape", () => {
  const required: RequiredHostTools = {
    node: { minMajor: 20, install: NODE_22_VERSION, source: "floor 20" },
    bun: "1.4.0",
    clients: { codex: "0.153.4", gemini: "0.58.0", grok: "1.2.3", claude: "2.1.263", opencode: "1.18.3", pi: "0.73.1" },
    tools: [{ tool: "gh", version: "2.86.0" }, { tool: "uv" }, { tool: "shellcheck", referenced_by: "~/.claude/hooks/x.sh" }],
    unsupported: [{ tool: "~/.claude/hooks/notify", referenced_by: "~/.claude/hooks/notify", reason: "Mach-O binary" }],
  };
  test("pinned installers, user-local paths, no sudo for packages, the JSON line and the host stamp", () => {
    const s = hostToolsScript(required);
    expect(s).toContain("bun-v1.4.0");
    expect(s).toContain("https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_$ga.tar.gz");
    expect(s).toContain("https://astral.sh/uv/install.sh");
    expect(s).toContain("bun install -g @openai/codex@0.153.4");
    expect(s).toContain("bun install -g @google/gemini-cli@0.58.0");
    expect(s).toContain("x.ai/cli/install.sh | bash -s 1.2.3");
    expect(s).toContain("claude.ai/install.sh | bash -s 2.1.263");
    expect(s).toContain("opencode.ai/install | bash -s -- --no-modify-path --version 1.18.3");
    expect(s).toContain("bun install -g @mariozechner/pi-coding-agent@0.73.1");
    expect(s).toContain("$HOME/.opencode/bin");
    expect(s).toContain(`"$HOME/.local/node-${NODE_22_VERSION}"`);
    expect(s).toContain("$HOME/.codecast/host-tools.json");
    expect(s).toContain('[ "$(uname -s)" = Linux ] || INSTALL=0');
    expect(s).not.toMatch(/sudo (apt|npm|bun|curl)/);
    expect(s).not.toMatch(/\$\{[A-Za-z_]+\.[A-Za-z_]/);
    expect(s).not.toContain("undefined");
    expect(s).toContain("command -v shellcheck");
    // Every installer download is bounded, the stamp goes through an exclusive mktemp under a non-symlinked ~/.codecast, and the manifest is read back even without MCP checks.
    expect(s).not.toMatch(/curl (?!-fsSL --connect-timeout 10 --max-time 300)/);
    expect(s).toContain('mktemp "$HOME/.codecast/.host-tools.json.XXXXXX"');
    expect(s).toContain('[ -L "$HOME/.codecast" ]');
    expect(s).not.toMatch(/\$\$\.tmp/);
    expect(hostToolsScript({ ...required, mcp: [] })).toContain("__MCP_OVERRIDES__");
  });
  test("only the laptop's own CLIs are installed and checked; a repo pinned above the installable major is reported, not downloaded", () => {
    const s = hostToolsScript({ ...required, clients: { codex: "0.153.4" } });
    expect(s).toContain("command -v codex");
    expect(s).not.toContain("gemini-cli");
    expect(s).not.toContain("x.ai/cli");
    expect(s).not.toContain("command -v grok");
    const above = hostToolsScript({ ...required, node: { minMajor: NODE_INSTALL_MAJOR + 2, install: NODE_22_VERSION, source: ".nvmrc" } });
    expect(above).not.toContain("nodejs.org/dist");
    expect(above).toContain(`node ${NODE_INSTALL_MAJOR + 2} is above the ${NODE_22_VERSION} this step installs`);
  });
  test("check-only mode installs nothing", () => {
    const s = hostToolsScript(required, { install: false });
    expect(s).toContain("INSTALL=0");
    expect(s).not.toContain("nodejs.org/dist");
    expect(s).not.toContain("bun.sh/install");
    expect(s).not.toContain("curl");
    expect(s).toContain('miss bun "the workspace manifest" "not installed"');
  });
  test("a malformed version is never interpolated; an unsafe helper name is dropped", () => {
    const s = hostToolsScript({ ...required, bun: "1.4; rm -rf /", clients: { codex: "x" }, tools: [{ tool: "gh", version: "bad" }, { tool: "evil; rm", referenced_by: "x" }] });
    expect(s).not.toContain("rm -rf /");
    expect(s).toContain("bash -s)");
    expect(s).toContain(`gh_${GH_DEFAULT_VERSION}_linux`);
    expect(s).toContain("@openai/codex >/dev/null");
    expect(s).not.toContain("evil");
    expect(safeVersion("1.2.3")).toBe("1.2.3");
    expect(safeVersion("v1.2.3")).toBeUndefined();
  });
});

describe("parseHostToolsOutput / summary", () => {
  test("takes the last JSON line after install noise; validates shape", () => {
    const r = parseHostToolsOutput('bun install noise\n{"ok":[{"tool":"node","version":"v22.12.0"}],"installed":[{"tool":"gh","version":"gh version 2.86.0"}],"missing":[{"tool":"uv","referenced_by":"skills","error":"curl: (6) Could not resolve"}],"unsupported":[{"tool":"~/.claude/hooks/notify","referenced_by":"~/.claude/hooks/notify","reason":"Mach-O"}],"install":1,"at":"2026-09-07T12:00:00Z"}\n');
    expect(r.ok).toEqual([{ tool: "node", version: "v22.12.0" }]);
    expect(r.installed).toEqual([{ tool: "gh", version: "gh version 2.86.0" }]);
    expect(r.missing).toEqual([{ tool: "uv", referenced_by: "skills", error: "curl: (6) Could not resolve" }]);
    expect(r.unsupported).toEqual([{ tool: "~/.claude/hooks/notify", referenced_by: "~/.claude/hooks/notify", reason: "Mach-O" }]);
    expect(r.install).toBe(true);
    expect(summarizeHostTools(r)).toBe("1 ok, 1 installed, 1 missing, 1 unsupported");
    expect(hostToolsDetailLines(r)).toEqual(["installed gh gh version 2.86.0", "missing uv (for skills) — curl: (6) Could not resolve", "unsupported ~/.claude/hooks/notify — Mach-O"]);
    expect(() => parseHostToolsOutput("no json")).toThrow(/printed no JSON/);
    expect(() => parseHostToolsOutput("{broken")).toThrow(/invalid JSON/);
    expect(parseHostToolsStamp("")).toBeNull();
    expect(parseHostToolsStamp("garbage")).toBeNull();
    expect(parseHostToolsStamp('{"ok":[],"installed":[],"missing":[],"unsupported":[]}')?.ok).toEqual([]);
  });
});

/** The "host": run the script exactly as ssh would, locally, against $HOME with a stubbed PATH. */
function localRun(_host: RemoteHost, script: string) {
  const r = spawnSync("/bin/sh", ["-c", HOST_TOOLS_REMOTE_COMMAND], { input: script, encoding: "utf-8", env: process.env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
}

function stub(name: string, body: string): void {
  write(home, `.local/bin/${name}`, `#!/bin/sh\n${body}\n`, 0o755);
}

describe("the script run locally against a temp HOME (stubs on PATH, no network)", () => {
  beforeEach(() => {
    process.env.HOME = home;
    // Every real tool is shadowed by ~/.local/bin (first on the script's PATH after ~/.bun/bin).
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.mkdirSync(path.join(home, ".bun", "bin"), { recursive: true });
    stub("curl", 'echo "curl: (6) Could not resolve host" >&2; exit 6');
    stub("sudo", "exit 1");
    stub("bun", 'case "$1" in --version) echo 1.4.0;; *) exit 1;; esac');
    stub("gh", "echo gh version 2.86.0");
    stub("codex", "echo codex-cli 0.153.4");
    stub("gemini", "echo 0.58.0");
    stub("grok", "echo 1.2.3");
    stub("claude", 'echo "2.1.263 (Claude Code)"');
    stub("uv", "echo uv 0.9.0");
  });

  test("check-only: ok / missing are reported, the stamp is written 0600, nothing is installed", () => {
    stub("node", "echo v22.12.0");
    const required: RequiredHostTools = {
      node: { minMajor: 20, install: NODE_22_VERSION, source: "floor 20" }, bun: "1.4.0",
      clients: { codex: "0.153.4" }, tools: [{ tool: "gh", version: "2.86.0" }, { tool: "uv" }, { tool: "frobnicate", referenced_by: "~/.claude/hooks/x.sh" }],
      unsupported: [{ tool: "~/.claude/hooks/notify", referenced_by: "~/.claude/hooks/notify", reason: "Mach-O binary" }],
    };
    const r = runHostTools(host, required, { install: false, run: localRun });
    expect(r.ok.map((t) => t.tool).sort()).toEqual(["bun", "codex", "gh", "node", "uv"]);
    expect(r.ok.find((t) => t.tool === "node")?.version).toBe("v22.12.0");
    expect(r.installed).toEqual([]);
    expect(r.missing).toEqual([{ tool: "frobnicate", referenced_by: "~/.claude/hooks/x.sh", error: "no portable install known  install it by hand on the host" }]);
    expect(r.unsupported).toEqual([{ tool: "~/.claude/hooks/notify", referenced_by: "~/.claude/hooks/notify", reason: "Mach-O binary" }]);
    expect(r.install).toBe(false);
    const stamp = path.join(home, ".codecast", "host-tools.json");
    expect(fs.statSync(stamp).mode & 0o777).toBe(0o600);
    expect(parseHostToolsStamp(fs.readFileSync(stamp, "utf-8"))?.missing[0].tool).toBe("frobnicate");
  });

  test("gh counts only the real gh: the wrapper alone is missing, the real one behind it is ok with its version", () => {
    stub("node", "echo v22.12.0");
    stub("gh", ghWrapperScript().replace("#!/bin/sh\n", ""));
    // A gh elsewhere on the machine would count, so the check runs with a PATH that has none.
    process.env.PATH = "/usr/bin:/bin";
    const required: RequiredHostTools = { node: { minMajor: 20, install: NODE_22_VERSION, source: "floor 20" }, clients: {}, tools: [{ tool: "gh", version: "2.86.0" }], unsupported: [] };
    expect(runHostTools(host, required, { install: false, run: localRun }).missing.map((m) => m.tool)).toEqual(["gh"]);
    write(home, REAL_GH_REL, "#!/bin/sh\necho gh version 2.86.0\n", 0o755);
    const r = runHostTools(host, required, { install: false, run: localRun });
    expect(r.missing).toEqual([]);
    expect(r.ok.find((t) => t.tool === "gh")?.version).toBe("gh version 2.86.0");
  });

  test("a node below the floor is missing in check-only mode with the reason", () => {
    stub("node", "echo v18.19.1");
    const r = runHostTools(host, { node: { minMajor: 20, install: NODE_22_VERSION, source: "convex engines (raised to 20)" }, clients: {}, tools: [], unsupported: [] }, { install: false, run: localRun });
    expect(r.missing.find((m) => m.tool === "node")).toEqual({ tool: "node", referenced_by: "convex engines (raised to 20)", error: "node 18 is below 20" });
  });

  const linuxOnly = process.platform === "linux" ? test : test.skip;
  linuxOnly("install mode offline: the node download fails into `missing` with the curl error and leaves no half-extracted dir; a stubbed gh install fails likewise", () => {
    stub("node", "echo v18.19.1");
    fs.unlinkSync(path.join(home, ".local", "bin", "gh"));
    const r = runHostTools(host, { node: { minMajor: 20, install: NODE_22_VERSION, source: "floor 20" }, clients: {}, tools: [{ tool: "gh", version: "2.86.0" }], unsupported: [] }, { install: true, run: localRun });
    const node = r.missing.find((m) => m.tool === "node");
    expect(node?.error).toMatch(/Could not resolve host/);
    expect(fs.existsSync(path.join(home, ".local", `node-${NODE_22_VERSION}`))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".local")).filter((n) => n.startsWith(".node-download"))).toEqual([]);
    expect(r.missing.find((m) => m.tool === "gh")?.error).toMatch(/Could not resolve host|download failed/);
    expect(r.install).toBe(true);
  });

  test("a transport failure throws; a non-zero exit names the last stderr line", () => {
    expect(() => runHostTools(host, { node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [] }, { run: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) }) })).toThrow(/ENOENT/);
    expect(() => runHostTools(host, { node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [] }, { run: () => ({ status: 255, stdout: "", stderr: "ssh: connect to host: Connection refused\n" }) })).toThrow(/exit 255.*Connection refused/);
  });
});

describe("MCP servers — classification, the host probe and the override manifest", () => {
  const MAC = "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient";

  test("parseCodexMcpServers reads command/args/enabled per [mcp_servers.*] table, skips sub-tables and url servers", () => {
    const toml = `model = "gpt-5"

[mcp_servers.computer_use]
command = "${MAC}"

[mcp_servers."file system"]
command = 'npx'
args = [
  "-y", # the package
  "@modelcontextprotocol/server-filesystem",
]
env = { A = "1" }

[mcp_servers.fs.env]
A = "1"

[mcp_servers.remote]
url = "https://x/mcp"

[mcp_servers.off]
command = "brew-thing"
enabled = false

[projects."/x"]
trust_level = "trusted"
`;
    expect(parseCodexMcpServers(toml)).toEqual({
      computer_use: { command: MAC },
      "file system": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      off: { command: "brew-thing", enabled: false },
    });
    expect(parseCodexMcpServers('[mcp_servers.esc]\ncommand = "a\\"b\\\\c"\n')).toEqual({ esc: { command: 'a"b\\c' } });
  });

  test("readMcpSources: codex from $CODEX_HOME/config.toml (laptop-disabled servers skipped), claude from ~/.claude.json stdio servers", () => {
    write(home, ".codex/config.toml", `[mcp_servers.computer_use]\ncommand = "${MAC}"\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n`);
    write(home, ".claude.json", JSON.stringify({
      mcpServers: {
        playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
        http: { type: "http", url: "https://x" },
        bad: { args: [] },
        tool: { command: `${home}/bin/tool` },
      },
      projects: { "/x": { mcpServers: { projectScoped: { command: "ignored" } } } },
    }));
    const src = readMcpSources(home, {});
    expect(Object.keys(src.codex)).toEqual(["computer_use"]);
    expect(src.claude).toEqual({ playwright: { command: "npx", args: ["-y", "@playwright/mcp"] }, tool: { command: `${home}/bin/tool` } });
    // Project scopes ride beside the global roster, keyed by the laptop root; no registration means no root remap.
    expect(src.claudeProjects).toEqual({ "/x": { projectScoped: { command: "ignored" } } });
    expect(src.mappings).toEqual([]);
    const elsewhere = path.join(dir, "codex-home");
    write(elsewhere, "config.toml", '[mcp_servers.other]\ncommand = "y"\n');
    expect(Object.keys(readMcpSources(home, { CODEX_HOME: elsewhere }).codex)).toEqual(["other"]);
    expect(readMcpSources(path.join(dir, "nowhere"), {})).toEqual({ codex: {}, claude: {}, claudeProjects: {}, mappings: [] });
  });

  test("readMcpSources with registrations: the repo's and its worktrees' claude.json scopes, the repo's .mcp.json, and the root remap; retired registrations are ignored", () => {
    const worktree = path.join(repo, ".codecast/worktrees/fix");
    write(home, ".claude.json", JSON.stringify({
      mcpServers: { global: { command: "npx", args: ["g"] } },
      projects: {
        [repo]: { mcpServers: { native: { command: `${repo}/bin/native` }, http: { type: "http", url: "https://x" } } },
        [worktree]: { mcpServers: { native: { command: `${worktree}/bin/native` } } },
        "/elsewhere/other": { mcpServers: { other: { command: "/Applications/O.app/Contents/MacOS/o" } } },
        relative: { mcpServers: { skipped: { command: "x" } } },
      },
    }));
    write(repo, ".mcp.json", JSON.stringify({ mcpServers: { fromFile: { command: "uvx", args: ["file-server"] }, native: { command: `${repo}/bin/native`, args: ["--dup"] } } }));
    write(path.join(dir, "retired"), ".mcp.json", JSON.stringify({ mcpServers: { gone: { command: "x" } } }));
    const projects = [
      { host: "ubuntu@h", sourceRoot: repo, targetRoot: "/home/ubuntu/work/repo" },
      { host: "ubuntu@h", sourceRoot: path.join(dir, "retired"), targetRoot: "/home/ubuntu/work/retired", retired: true },
    ];
    const src = readMcpSources(home, {}, projects);
    expect(src.claude).toEqual({ global: { command: "npx", args: ["g"] } });
    expect(src.mappings).toEqual([{ from: repo, to: "/home/ubuntu/work/repo" }]);
    expect(Object.keys(src.claudeProjects).sort()).toEqual(["/elsewhere/other", repo, worktree].sort());
    // The .mcp.json of the registered root merges into that root's scope (the file's entry for a name wins).
    expect(src.claudeProjects[repo]).toEqual({ native: { command: `${repo}/bin/native`, args: ["--dup"] }, fromFile: { command: "uvx", args: ["file-server"] } });
    expect(src.claudeProjects[worktree]).toEqual({ native: { command: `${worktree}/bin/native` } });
  });

  test("readMcpSources: a home level ~/.mcp.json is a source scoped to the home, and mcpChecks classifies it with the home remapped", () => {
    write(home, ".mcp.json", JSON.stringify({ mcpServers: { homeTool: { command: `${home}/bin/home-tool`, args: ["--x"] }, mac: { command: "/Applications/M.app/Contents/MacOS/m" }, web: { type: "http", url: "https://x" } } }));
    const src = readMcpSources(home, {});
    expect(src.claudeProjects).toEqual({ [home]: { homeTool: { command: `${home}/bin/home-tool`, args: ["--x"] }, mac: { command: "/Applications/M.app/Contents/MacOS/m" } } });
    const checks = mcpChecks(src, home, "/home/ubuntu");
    expect(checks.map((c) => `${c.name}@${c.scope}`)).toEqual(["homeTool@/home/ubuntu", "mac@/home/ubuntu"]);
    expect(checks[0]).toMatchObject({ command: "/home/ubuntu/bin/home-tool", probe: { kind: "path", path: "/home/ubuntu/bin/home-tool" }, underHome: true });
    expect(checks[1]!.verdict?.status).toBe("unsupported");
  });

  test("mcpChecks spells project definitions the way the mirror writes them on the host (roots remapped, home absolute), collapses identical worktree repeats, and keeps laptop_command laptop-side", () => {
    const proj = path.join(home, "src/repo");
    const worktree = path.join(proj, ".codecast/worktrees/fix");
    const sources: McpSources = {
      codex: {}, claude: { global: { command: `${home}/bin/g` } },
      claudeProjects: {
        [proj]: { native: { command: `${proj}/bin/native`, args: [`--data=${home}/data`] }, global: { command: `${home}/bin/g` } },
        [worktree]: { native: { command: `${worktree}/bin/native` }, other: { command: "npx", args: ["o"] } },
        "/elsewhere/other": { other: { command: "npx", args: ["o"] } },
      },
      mappings: [{ from: proj, to: "/home/ubuntu/work/repo" }],
    };
    const checks = mcpChecks(sources, home, "/home/ubuntu");
    expect(checks.map((c) => `${c.name}@${c.scope ?? "global"}`)).toEqual([
      "global@global", "other@/elsewhere/other", "native@/home/ubuntu/work/repo", "native@/home/ubuntu/work/repo/.codecast/worktrees/fix",
    ]);
    expect(checks[0]).toMatchObject({ command: "/home/ubuntu/bin/g", laptop_command: "~/bin/g", probe: { kind: "path", path: "/home/ubuntu/bin/g" }, underHome: true });
    expect(checks[2]).toMatchObject({ command: "/home/ubuntu/work/repo/bin/native", args: ["--data=/home/ubuntu/data"], laptop_command: "~/src/repo/bin/native --data=~/data" });
    expect(checks[3]).toMatchObject({ command: "/home/ubuntu/work/repo/.codecast/worktrees/fix/bin/native" });
    expect(JSON.stringify(checks)).not.toContain(home);
    // Without a host home the spelling falls back to `~`, and the same definitions collapse the same way.
    expect(mcpChecks(sources, home).map((c) => c.command)).toEqual(["~/bin/g", "npx", "/home/ubuntu/work/repo/bin/native", "/home/ubuntu/work/repo/.codecast/worktrees/fix/bin/native"]);
  });

  test("reconcileMcp never clears a project-only pin, and pins a name whose only unsupported definition is project-scoped", () => {
    const sources: McpSources = {
      codex: {}, claude: { shared: { command: "npx", args: ["s"] } },
      claudeProjects: { [repo]: { onlyHere: { command: "/Applications/X.app/Contents/MacOS/x" }, shared: { command: "/Applications/Y.app/Contents/MacOS/y" } } },
      mappings: [{ from: repo, to: "/home/ubuntu/work/repo" }],
    };
    const checks = mcpChecks(sources, home, "/home/ubuntu");
    const first = reconcileMcp(checks, { resolved: new Map([[0, true]]) }, { hostHome: "/home/ubuntu", at: "t1", install: true });
    expect(Object.keys(first.next.claude).sort()).toEqual(["onlyHere", "shared"]);
    expect(first.next.claude.shared!.source_command).toBe("/Applications/Y.app/Contents/MacOS/y");
    expect(first.mcp.map((m) => [m.name, m.scope ?? "", m.status])).toEqual([["shared", "", "ok"], ["onlyHere", "/home/ubuntu/work/repo", "unsupported"], ["shared", "/home/ubuntu/work/repo", "unsupported"]]);
    // The next run over the same roster keeps both pins with their original time.
    const again = reconcileMcp(checks, { resolved: new Map([[0, true]]), overridesText: JSON.stringify(first.next) }, { hostHome: "/home/ubuntu", at: "t2", install: true });
    expect(again.changed).toBe(false);
    expect(again.next.claude.onlyHere!.at).toBe("t1");
    // A roster built without project scopes is what used to clear them.
    const globalOnly = reconcileMcp(mcpChecks({ ...sources, claudeProjects: {} }, home, "/home/ubuntu"), { resolved: new Map([[0, true]]), overridesText: JSON.stringify(first.next) }, { hostHome: "/home/ubuntu", at: "t2", install: true });
    expect(globalOnly.next.claude).toEqual({});
  });

  test("reconcileMcp treats a host manifest that does not parse as empty, says why, and rewrites it whole", () => {
    const checks = mcpChecks({ codex: { computer_use: { command: MAC } }, claude: {}, claudeProjects: {}, mappings: [] }, "/Users/a", "/home/ubuntu");
    const r = reconcileMcp(checks, { resolved: new Map(), overridesText: JSON.stringify({ version: 1, codex: { computer_use: { enabled: true, reason: "r", source_command: "s", at: "t" } }, claude: {} }) }, { hostHome: "/home/ubuntu", at: "t", install: true });
    expect(r.invalid).toBe("codex.computer_use.enabled is not false");
    expect(r.current).toEqual({ version: 1, codex: {}, claude: {} });
    expect(r.changed).toBe(true);
    expect(Object.keys(r.next.codex)).toEqual(["computer_use"]);
    const run = () => ({ status: 0, stdout: `__MCP_OVERRIDES__ ${Buffer.from("{broken").toString("base64")}\n{"ok":[],"installed":[],"missing":[],"unsupported":[]}\n`, stderr: "" });
    const report = runHostTools(host, { node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [], mcp: checks }, { run, writeOverrides: () => {} });
    expect(report.mcpOverridesInvalid).toMatch(/^not JSON/);
    expect(report.mcpOverridesWritten).toBe(true);
    expect(hostToolsDetailLines(report).at(-1)).toMatch(/host-mcp-overrides\.json did not parse \(not JSON/);
  });

  test("the host-side writer: 0600 under a 0700 ~/.codecast, exclusive temp, nothing left behind, a symlinked ~/.codecast refused, a planted temp never followed", () => {
    process.env.HOME = home;
    const sh = (input: string) => spawnSync("/bin/sh", ["-c", codecastFileWriteCommand("host-mcp-overrides.json")], { input, encoding: "utf-8", env: process.env });
    const file = path.join(home, ".codecast/host-mcp-overrides.json");
    expect(sh("first\n").status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe("first\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // A temp planted under the old predictable name (a symlink to an outside marker) stays untouched: mktemp never hands out an existing name.
    const marker = path.join(dir, "marker");
    fs.writeFileSync(marker, "untouched");
    fs.symlinkSync(marker, path.join(home, ".codecast/.host-mcp-overrides.json.tmp"));
    expect(sh("second\n").status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe("second\n");
    expect(fs.readFileSync(marker, "utf-8")).toBe("untouched");
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([".host-mcp-overrides.json.tmp", "host-mcp-overrides.json"]);
    // A symlinked ~/.codecast is refused and the directory it points at gets nothing.
    const linked = path.join(dir, "linked-home");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(linked); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(linked, ".codecast"));
    const r = spawnSync("/bin/sh", ["-c", codecastFileWriteCommand("host-mcp-overrides.json")], { input: "x", encoding: "utf-8", env: { ...process.env, HOME: linked } });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("symlinked ~/.codecast");
    expect(fs.readdirSync(outside)).toEqual([]);
    // The tools script's own stamp goes through the same writer: with a symlinked ~/.codecast it still answers, and writes nothing outside.
    const script = hostToolsScript({ node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [] }, { install: false });
    const s = spawnSync("/bin/sh", ["-c", HOST_TOOLS_REMOTE_COMMAND], { input: script, encoding: "utf-8", env: { ...process.env, HOME: linked }, timeout: 60_000 });
    expect(s.status).toBe(0);
    expect(parseHostToolsOutput(s.stdout).ok).toBeDefined();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("staticMcpVerdict: .app bundles, macOS-only prefixes and Mach-O files are unsupported; bare names and other paths are the host's call", () => {
    expect(staticMcpVerdict(MAC, home)?.reason).toMatch(/\.app bundle/);
    expect(staticMcpVerdict("/Applications/Foo.app/Contents/MacOS/foo", home)?.status).toBe("unsupported");
    expect(staticMcpVerdict("/opt/homebrew/bin/thing", home)?.reason).toMatch(/homebrew.*macOS-only/);
    write(home, "bin/native", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]), 0o755);
    expect(staticMcpVerdict("~/bin/native", home)?.reason).toMatch(/Mach-O/);
    expect(staticMcpVerdict(`${home}/bin/native`, home)?.reason).toMatch(/Mach-O/);
    // A Mach-O outside the laptop home (/usr/local/bin/node on a Mac) is the host's probe to decide: the same path may well exist there.
    write(dir, "usr-local-bin/node", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]), 0o755);
    expect(staticMcpVerdict(path.join(dir, "usr-local-bin/node"), home)).toBeUndefined();
    write(home, "bin/script", "#!/bin/sh\necho hi\n", 0o755);
    expect(staticMcpVerdict("~/bin/script", home)).toBeUndefined();
    expect(staticMcpVerdict("npx", home)).toBeUndefined();
    expect(staticMcpVerdict("/Users/a/My Tools/Codex Computer Use.app/Contents/MacOS/x", home)?.reason).toMatch(/\.app bundle/);
    expect(staticMcpVerdict("/usr/local/bin/thing", home)).toBeUndefined();
    expect(staticMcpVerdict("", home)?.reason).toBe("empty command");
  });

  test("mcpChecks: laptop-home paths are spelled ~/ for the host, launchers are flagged, probes are which/path, verdicts need no probe", () => {
    write(home, "bin/script", "#!/bin/sh\n", 0o755);
    const checks = mcpChecks({
      codex: { computer_use: { command: MAC }, fs: { command: "npx", args: ["-y", "@x/fs", `${home}/data`] } },
      claude: { tool: { command: `${home}/bin/script`, args: ["--serve"] }, sys: { command: "/usr/local/bin/thing" } },
    }, home);
    expect(checks.map((c) => `${c.harness}/${c.name}`)).toEqual(["codex/computer_use", "codex/fs", "claude/sys", "claude/tool"]);
    expect(checks[0]).toMatchObject({ verdict: { status: "unsupported" }, command: MAC, laptop_command: MAC });
    expect(checks[0]!.probe).toBeUndefined();
    expect(checks[1]).toMatchObject({ probe: { kind: "which", word: "npx" }, launcher: true, args: ["-y", "@x/fs", "~/data"] });
    expect(checks[2]).toMatchObject({ probe: { kind: "path", path: "/usr/local/bin/thing" } });
    expect(checks[3]).toMatchObject({ command: "~/bin/script", args: ["--serve"], probe: { kind: "path", path: "~/bin/script" }, laptop_command: "~/bin/script --serve" });
    expect(JSON.stringify(checks)).not.toContain(home);
  });

  test("the script probes each check and hands back the manifest; parseMcpLines reads both", () => {
    const required: RequiredHostTools = {
      node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [],
      mcp: mcpChecks({ codex: { computer_use: { command: MAC }, fs: { command: "npx" } }, claude: { tool: { command: "~/bin/tool" } } }, "/Users/a"),
    };
    const s = hostToolsScript(required, { install: false });
    expect(s).toContain(`if command -v 'npx' >/dev/null 2>&1; then echo "__MCP__ 1 1"; else echo "__MCP__ 1 0"; fi`);
    expect(s).toContain(`if [ -x "$HOME"/'bin/tool' ]; then echo "__MCP__ 2 1"; else echo "__MCP__ 2 0"; fi`);
    expect(s).not.toContain("__MCP__ 0");
    expect(s).toContain("host-mcp-overrides.json");
    const manifest = JSON.stringify({ version: 1, codex: { computer_use: { enabled: false, reason: "r", source_command: "x", at: "t" } }, claude: {} });
    const parsed = parseMcpLines(`noise\n__MCP__ 1 1\n__MCP__ 2 0\n__MCP_OVERRIDES__ ${Buffer.from(manifest).toString("base64")}\n{"ok":[]}\n`);
    expect([...parsed.resolved.entries()]).toEqual([[1, true], [2, false]]);
    expect(parsed.overridesText).toBe(manifest);
    expect(parseMcpLines("nothing")).toEqual({ resolved: new Map() });
  });

  test("classifyMcp: an .app command is unsupported (with the cast browser hint for a computer-use server), an unresolved npx is missing_portable, a resolved command is ok", () => {
    const checks = mcpChecks({ codex: { computer_use: { command: MAC }, fs: { command: "npx", args: ["-y", "x"] }, own: { command: "~/bin/tool" }, sys: { command: "/usr/bin/thing" } }, claude: {} }, "/Users/a");
    const c = classifyMcp(checks, new Map([[3, true]]));
    expect(c.map((x) => [x.name, x.status])).toEqual([["computer_use", "unsupported"], ["fs", "missing_portable"], ["own", "missing_portable"], ["sys", "ok"]]);
    expect(c[0]!.reason).toMatch(/\.app bundle.*cast browser/);
    expect(c[1]!.reason).toMatch(/launcher `npx` is not on the host yet/);
    expect(c[2]!.reason).toMatch(/~\/bin\/tool is not on the host/);
    expect(c[3]!.reason).toBeUndefined();
  });

  test("reconcileMcp: pins the unsupported server, drops a pin whose command now resolves, reports actions, and only changes the manifest when it must", () => {
    const checks = mcpChecks({ codex: { computer_use: { command: MAC }, fixed: { command: "npx" } }, claude: { native: { command: "/Applications/X.app/Contents/MacOS/x" } } }, "/Users/a");
    const current = JSON.stringify({ version: 1, codex: { fixed: { enabled: false, reason: "old", source_command: "npx", at: "t0" } }, claude: {} });
    const r = reconcileMcp(checks, { resolved: new Map([[1, true]]), overridesText: current }, { hostHome: "/home/ubuntu", at: "2026-09-07T12:00:00Z", install: true });
    expect(r.changed).toBe(true);
    expect(r.next).toEqual({
      version: 1,
      codex: { computer_use: { enabled: false, reason: expect.stringMatching(/\.app bundle/), source_command: "/home/ubuntu/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient", at: "2026-09-07T12:00:00Z" } },
      claude: { native: { enabled: false, reason: expect.stringMatching(/\.app bundle/), source_command: "/Applications/X.app/Contents/MacOS/x", at: "2026-09-07T12:00:00Z" } },
    });
    expect(r.mcp.map((m) => [m.harness, m.name, m.status])).toEqual([["codex", "computer_use", "unsupported"], ["codex", "fixed", "ok"], ["claude", "native", "unsupported"]]);
    expect(r.mcp[0]!.action).toMatch(/disabled on the host now.*enabled = false/);
    expect(r.mcp[1]!.action).toBe("pin dropped — it resolves on the host again");
    expect(r.mcp[2]!.action).toMatch(/leaves it out of the host's ~\/.claude\.json/);
    // Same roster, same host answers, manifest already reconciled → unchanged, and the pin keeps its time.
    const again = reconcileMcp(checks, { resolved: new Map([[1, true]]), overridesText: JSON.stringify(r.next) }, { hostHome: "/home/ubuntu", at: "2026-09-08T00:00:00Z", install: true });
    expect(again.changed).toBe(false);
    expect(again.next.codex.computer_use!.at).toBe("2026-09-07T12:00:00Z");
    expect(again.mcp[0]!.action).toMatch(/^disabled on the host \(pinned/);
    // Check-only: the report says what would happen.
    const check = reconcileMcp(checks, { resolved: new Map([[1, true]]), overridesText: current }, { hostHome: "/home/ubuntu", at: "t", install: false });
    expect(check.mcp[0]!.action).toMatch(/would be disabled/);
    expect(check.mcp[1]!.action).toMatch(/would drop its pin/);
  });

  test("runHostTools writes the manifest through the injected writer only when it changed and only on an installing run", () => {
    const required: RequiredHostTools = {
      node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [],
      mcp: mcpChecks({ codex: { computer_use: { command: MAC }, fs: { command: "npx" } }, claude: {} }, "/Users/a"),
    };
    const writes: unknown[] = [];
    const stdout = (manifest?: string) => `__MCP__ 1 1\n${manifest ? `__MCP_OVERRIDES__ ${Buffer.from(manifest).toString("base64")}\n` : ""}{"ok":[{"tool":"node","version":"v22"}],"installed":[],"missing":[],"unsupported":[],"install":1}\n`;
    const run = (out: string) => () => ({ status: 0, stdout: out, stderr: "" });
    const r1 = runHostTools(host, required, { run: run(stdout()), writeOverrides: (_h, o) => writes.push(o), now: () => new Date("2026-09-07T12:00:00Z") });
    expect(r1.mcpOverridesWritten).toBe(true);
    expect(writes).toHaveLength(1);
    expect(Object.keys((writes[0] as any).codex)).toEqual(["computer_use"]);
    expect(summarizeHostTools(r1)).toBe("1 ok, 0 installed, 0 missing, 0 unsupported, 1 MCP server disabled (codex: computer_use)");
    expect(hostToolsDetailLines(r1)).toEqual([expect.stringMatching(/^mcp codex\/computer_use \(~\/\.codex.*unsupported — .*; disabled on the host now/)]);
    // The host already holds that manifest → nothing written.
    const r2 = runHostTools(host, required, { run: run(stdout(JSON.stringify(writes[0]))), writeOverrides: (_h, o) => writes.push(o), now: () => new Date("2026-09-08T00:00:00Z") });
    expect(r2.mcpOverridesWritten).toBeUndefined();
    expect(writes).toHaveLength(1);
    // Check-only never writes.
    const r3 = runHostTools(host, required, { install: false, run: run(stdout()), writeOverrides: (_h, o) => writes.push(o) });
    expect(r3.mcpOverridesWritten).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(r3.mcp![0]!.action).toMatch(/would be disabled/);
    // A writer failure surfaces (the report is the host's; the manifest is not).
    expect(() => runHostTools(host, required, { run: run(stdout()), writeOverrides: () => { throw new Error("ssh: Connection closed"); } })).toThrow(/Connection closed/);
  });

  test("the script run locally answers the probes from the temp HOME's PATH and files", () => {
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    write(home, ".local/bin/node", "#!/bin/sh\necho v22.12.0\n", 0o755);
    write(home, "bin/tool", "#!/bin/sh\n", 0o755);
    write(home, "bin/notexec", "x", 0o644);
    write(home, ".codecast/host-mcp-overrides.json", JSON.stringify({ version: 1, codex: { gone: { enabled: false, reason: "r", source_command: "s", at: "t" } }, claude: {} }));
    const required: RequiredHostTools = {
      node: { minMajor: 20, install: NODE_22_VERSION, source: "x" }, clients: {}, tools: [], unsupported: [],
      mcp: mcpChecks({ codex: { a: { command: "node" }, b: { command: "definitely-not-a-command-xyz" }, c: { command: "~/bin/tool" }, d: { command: "~/bin/notexec" } }, claude: {} }, "/Users/a"),
    };
    const writes: unknown[] = [];
    const r = runHostTools(host, required, { install: false, run: (_h, script) => localRun(_h, script), writeOverrides: (_h, o) => writes.push(o) });
    expect(r.mcp!.map((m) => [m.name, m.status])).toEqual([["a", "ok"], ["b", "missing_portable"], ["c", "ok"], ["d", "missing_portable"]]);
    // The host's manifest came back and the stale pin would be dropped (check-only: not written).
    expect(r.mcpOverrides).toEqual({ version: 1, codex: {}, claude: {} });
    expect(writes).toEqual([]);
  });
});
