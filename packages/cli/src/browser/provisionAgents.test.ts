import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentCliInstallScript, codexCompatibilityScript, NODE_22_VERSION, parseAgentCliReport } from "./provisionAgents";

describe("agentCliInstallScript", () => {
  const script = agentCliInstallScript({ claude: "2.1.263", codex: "0.153.4", gemini: "0.58.0", grok: "1.2.3", opencode: "1.18.3", pi: "0.73.1" });

  test("pins each client to the laptop's version through its own installer", () => {
    expect(script).toContain("bun install -g @openai/codex@0.153.4");
    expect(script).toContain("bun install -g @google/gemini-cli@0.58.0");
    expect(script).toContain("https://claude.ai/install.sh | bash -s 2.1.263");
    expect(script).toContain("https://x.ai/cli/install.sh | bash -s 1.2.3");
    expect(script).toContain("https://opencode.ai/install | bash -s -- --no-modify-path --version 1.18.3");
    expect(script).toContain('ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"');
    expect(script).toContain("bun install -g @mariozechner/pi-coding-agent@0.73.1");
  });

  test("the node guard: below major 20, the nodejs.org tarball, a temp-dir extract, ~/.local/bin and /usr/local/bin symlinks", () => {
    expect(script).toContain('[ "$node_major" -lt 20 ]');
    expect(script).toContain(`https://nodejs.org/dist/v${NODE_22_VERSION}/node-v${NODE_22_VERSION}-$node_os-$a.$node_archive`);
    expect(script).toContain("Darwin) node_os=darwin; node_archive=tar.gz; node_tar=-xz");
    expect(script).toContain("Linux) node_os=linux; node_archive=tar.xz; node_tar=-xJ");
    expect(script).toContain('mktemp -d "$HOME/.local/.node-download.XXXXXX"');
    expect(script).toContain(`mv "$tmp/node-v${NODE_22_VERSION}-$node_os-$a" "$HOME/.local/node-${NODE_22_VERSION}"`);
    expect(script).toContain('ln -sf "$HOME/.local/node-' + NODE_22_VERSION + '/bin/$b" "$HOME/.local/bin/$b"');
    expect(script).toContain('sudo -n ln -sf "$HOME/.local/node-' + NODE_22_VERSION + '/bin/$b" "/usr/local/bin/$b"');
    // apt's node is never touched.
    expect(script).not.toContain("apt-get");
    expect(script).not.toContain("nodesource");
  });

  test("command -v guards before every install; ends with AGENT-CLIS-OK; no template placeholder survives", () => {
    for (const bin of ["claude", "codex", "gemini", "grok", "opencode", "pi"]) expect(script).toContain(`command -v ${bin} >/dev/null 2>&1 ||`);
    expect(script.trim().endsWith("echo AGENT-CLIS-OK")).toBe(true);
    // A JS member expression left in the text means a constant failed to interpolate.
    expect(script).not.toMatch(/\$\{[A-Za-z_]+\.[A-Za-z_]/);
    expect(script).not.toContain("undefined");
    expect(script).toContain('echo "$b=$v"');
  });

  test("a malformed version is not interpolated: no @ suffix, no -s argument", () => {
    const s = agentCliInstallScript({ codex: "latest; rm -rf /", claude: "2.1", gemini: undefined, grok: "v1.2.3", opencode: "1.18; id", pi: "x" });
    expect(s).toContain("bun install -g @openai/codex >/dev/null");
    expect(s).not.toContain("rm -rf /");
    expect(s).toContain("https://claude.ai/install.sh | bash -s) >/dev/null");
    expect(s).toContain("bun install -g @google/gemini-cli >/dev/null");
    expect(s).toContain("https://x.ai/cli/install.sh | bash -s) >/dev/null");
    expect(s).toContain("https://opencode.ai/install | bash -s -- --no-modify-path) >/dev/null 2>&1; [ -x");
    expect(s).toContain("bun install -g @mariozechner/pi-coding-agent >/dev/null");
    expect(s).not.toContain("; id");
  });

  test("runs to AGENT-CLIS-OK in a fresh HOME with no ~/.local, node 18, no network, and a CLI whose --version fails", () => {
    // The spec's scratch-HOME dry run, offline: every network call and sudo is a stub on PATH.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-clis-"));
    // ~/.bun/bin is first on the script's PATH, ahead of /usr/local/bin where this box has real CLIs; ~/.local must not exist.
    const stubs = path.join(home, ".bun", "bin");
    fs.mkdirSync(stubs, { recursive: true });
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("node", "echo v18.19.1");
    stub("curl", 'echo "curl: (6) Could not resolve host" >&2; exit 6');
    stub("sudo", "exit 1");
    stub("bun", "exit 1");
    stub("claude", 'echo "2.1.263 (Claude Code)"');
    stub("codex", "echo codex-cli 0.153.4");
    stub("gemini", 'echo "SyntaxError: Invalid regular expression flags" >&2; exit 1');
    stub("grok", "echo 1.2.3");
    try {
      const r = spawnSync("bash", ["-s"], {
        input: agentCliInstallScript({ codex: "0.153.4", gemini: "0.58.0" }), encoding: "utf-8", timeout: 60_000,
        env: { HOME: home, PATH: "/usr/bin:/bin", BUN_INSTALL: path.join(home, ".bun") },
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("AGENT-CLIS-OK");
      expect(parseAgentCliReport(r.stdout)).toMatch(/^claude=2\.1\.263 \(Claude Code\)  codex=codex-cli 0\.153\.4  gemini=  grok=1\.2\.3  opencode=missing  pi=missing  node=v18\.19\.1 \(curl: \(6\) Could not resolve host/);
      expect(fs.existsSync(path.join(home, ".local", "bin"))).toBe(true);
      // A failed opencode download leaves no dangling link behind.
      expect(fs.existsSync(path.join(home, ".local", "bin", "opencode"))).toBe(false);
      expect(fs.readdirSync(path.join(home, ".local")).filter((n) => n.startsWith(".node-download"))).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("parseAgentCliReport keeps the per-client version lines", () => {
    expect(parseAgentCliReport("noise\nclaude=2.1.263 (Claude Code)\ncodex=codex-cli 0.153.4\ngemini=missing\ngrok=missing\nnode=v22.12.0\nAGENT-CLIS-OK\n"))
      .toBe("claude=2.1.263 (Claude Code)  codex=codex-cli 0.153.4  gemini=missing  grok=missing  node=v22.12.0");
  });

  test.each(["0.142.5", "0.155.1", "0.156.0"])("explicit provisioning upgrades older Codex without downgrading %s", (current) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compatible-"));
    const bin = path.join(home, ".bun/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, "version"), current);
    fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nprintf "codex-cli %s\\n" "$(cat "$HOME/version")"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "bun"), '#!/bin/sh\nprintf "%s" "$*" > "$HOME/install"\nprintf 0.155.1 > "$HOME/version"\n', { mode: 0o755 });
    try {
      const result = spawnSync("bash", ["-e", "-s"], { input: codexCompatibilityScript("0.155.1"), env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(home, "version"), "utf8")).toBe(current === "0.142.5" ? "0.155.1" : current);
      expect(fs.existsSync(path.join(home, "install"))).toBe(current === "0.142.5");
      if (current === "0.142.5") expect(fs.readFileSync(path.join(home, "install"), "utf8")).toBe("install -g @openai/codex@0.155.1");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
