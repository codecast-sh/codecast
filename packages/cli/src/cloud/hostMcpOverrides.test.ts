import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  describeHostMcpOverrides, emptyOverrides, hostMcpOverridesPath, maskPins, normalizeCommand, parseHostMcpOverrides, readHostMcpOverrides,
  reconcilePins, serializeHostMcpOverrides, writeHostMcpOverrides, type HostMcpOverrides, type McpClassified, type McpPin,
} from "./hostMcpOverrides";
import { joinTomlTables, splitTomlTables } from "./mirror/transform";

const homes: string[] = [];
const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-overrides-")); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("override ledger is atomic, private, and absent or malformed manifests mean no pins", () => {
  const root = home();
  expect(readHostMcpOverrides(root)).toEqual(emptyOverrides());
  const pins = reconcilePins(emptyOverrides(), "codex", [{ name: "computer", command: "/missing/app", args: ["--mcp"], status: "unsupported", reason: "macOS only" }], "now");
  writeHostMcpOverrides(root, pins);
  expect(readHostMcpOverrides(root)).toEqual(pins);
  expect(fs.statSync(hostMcpOverridesPath(root)).mode & 0o777).toBe(0o600);
  fs.writeFileSync(hostMcpOverridesPath(root), '{"version":1,"codex":{"bad":{"enabled":true}},"claude":{}}');
  expect(readHostMcpOverrides(root)).toEqual(emptyOverrides());
});

test("matching command pins survive; changed or absent commands drop only that harness's pins", () => {
  const codex = reconcilePins(emptyOverrides(), "codex", [{ name: "same", command: "tool", args: ["arg"], status: "unsupported" }, { name: "changed", command: "old", status: "unsupported" }, { name: "absent", command: "gone", status: "unsupported" }], "then");
  const both = reconcilePins(codex, "claude", [{ name: "claude", command: "claude-tool", status: "unsupported" }], "then");
  const masked = maskPins(both, "codex", { same: { command: "tool", args: ["arg"] }, changed: { command: "new" } });
  expect(masked.pinned).toEqual(["same"]);
  expect(masked.dropped).toEqual(["changed", "absent"]);
  expect(masked.next.claude).toEqual(both.claude);
  expect(Object.keys(both.codex)).toEqual(["same", "changed", "absent"]);
  expect(normalizeCommand({ command: "~/tool", args: ["$HOME/arg", "a   b"] })).toBe(`${process.env.HOME || os.homedir()}/tool ${process.env.HOME || os.homedir()}/arg a b`);
});

test("readiness removes recovered, missing-portable and absent pins without touching another harness", () => {
  const before = reconcilePins(emptyOverrides(), "codex", [{ name: "recovered", command: "ok", status: "unsupported" }, { name: "portable", command: "install", status: "unsupported" }, { name: "absent", command: "gone", status: "unsupported" }], "then");
  const after = reconcilePins(before, "codex", [{ name: "recovered", command: "ok", status: "ok" }, { name: "portable", command: "install", status: "missing_portable" }], "now");
  expect(after).toEqual(emptyOverrides());
});

const HOME = "/home/ubuntu";
const AT = "2026-09-07T12:00:00Z";
const MAC = "/home/ubuntu/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-mcp-overrides-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pinned(): HostMcpOverrides {
  return {
    version: 1,
    codex: { computer_use: { enabled: false, reason: "Mach-O", source_command: MAC, at: "2026-09-01T00:00:00Z" } },
    claude: {},
  };
}

describe("normalizeCommand — the one comparison key", () => {
  test("expands ~ and $HOME to the host home, joins args with single spaces, collapses whitespace", () => {
    expect(normalizeCommand({ command: "~/.local/bin/tool", args: ["--a", "  b  "] }, HOME)).toBe("/home/ubuntu/.local/bin/tool --a b");
    expect(normalizeCommand({ command: "$HOME/bin/x" }, HOME)).toBe("/home/ubuntu/bin/x");
    expect(normalizeCommand({ command: "${HOME}/bin/x", args: ["~"] }, HOME)).toBe("/home/ubuntu/bin/x /home/ubuntu");
    expect(normalizeCommand({ command: "npx", args: ["-y", "@x/y"] }, HOME)).toBe("npx -y @x/y");
    expect(normalizeCommand({ command: "  npx   -y  " }, HOME)).toBe("npx -y");
    // $HOMEBREW is not $HOME.
    expect(normalizeCommand({ command: "$HOMEBREW/bin/x" }, HOME)).toBe("$HOMEBREW/bin/x");
  });
  test("defaults the home to this process's", () => {
    expect(normalizeCommand({ command: "~/x" })).toBe(path.join(process.env.HOME || os.homedir(), "x"));
  });
  test("expands embedded and quoted home references too (the review's bash -lc fixture), so a pin survives a mixed-version rollout", () => {
    expect(normalizeCommand({ command: "bash", args: ["-lc", `'~/bin/tool' "$HOME/config"`] }, HOME)).toBe(`bash -lc '/home/ubuntu/bin/tool' "/home/ubuntu/config"`);
    expect(normalizeCommand({ command: "sh -c 'cd ~ && ./run ~/x'" }, HOME)).toBe("sh -c 'cd /home/ubuntu && ./run /home/ubuntu/x'");
    // A tilde inside a word (`a~b`, `--flag=~/x`) is not a home reference for either side.
    expect(normalizeCommand({ command: "x", args: ["a~b", "--flag=~/x"] }, HOME)).toBe("x a~b --flag=~/x");
  });
});

describe("read / write / parse", () => {
  test("hostMcpOverridesPath, emptyOverrides, a missing or invalid file reads as empty", () => {
    expect(hostMcpOverridesPath(HOME)).toBe("/home/ubuntu/.codecast/host-mcp-overrides.json");
    expect(emptyOverrides()).toEqual({ version: 1, codex: {}, claude: {} });
    expect(readHostMcpOverrides(dir)).toEqual(emptyOverrides());
    fs.mkdirSync(path.join(dir, ".codecast"));
    fs.writeFileSync(hostMcpOverridesPath(dir), "{broken");
    expect(readHostMcpOverrides(dir)).toEqual(emptyOverrides());
    expect(parseHostMcpOverrides(JSON.stringify({ version: 2, codex: { a: {} } }))).toEqual(emptyOverrides());
  });
  test("one strict policy: any malformed table or pin rejects the whole manifest (never salvaged), and the reason is reported", () => {
    const good: McpPin = { enabled: false, reason: "r", source_command: "s", at: "t" };
    const why = (value: unknown) => { let reason: string | undefined; parseHostMcpOverrides(JSON.stringify(value), (r) => { reason = r; }); return reason; };
    expect(why({ version: 1, codex: { a: good }, claude: {} })).toBeUndefined();
    expect(parseHostMcpOverrides(JSON.stringify({ version: 1, codex: { a: { ...good, extra: 1 } }, claude: {} }))).toEqual({ version: 1, codex: { a: good }, claude: {} });
    expect(why([])).toBe("not a JSON object");
    expect(why({ version: 2, codex: {}, claude: {} })).toBe("unknown version 2");
    expect(why({ version: 1, codex: {} })).toBe("claude is not a table of pins");
    expect(why({ version: 1, codex: {}, claude: "nope" })).toBe("claude is not a table of pins");
    expect(why({ version: 1, codex: { a: good, b: null }, claude: {} })).toBe("codex.b is not a pin");
    // The review's fixture: an explicitly enabled entry is not a disable pin, and its presence poisons the file.
    expect(why({ version: 1, codex: { explicitlyEnabled: { enabled: true, reason: "fixture", source_command: "portable-tool", at: "now" }, a: good }, claude: {} })).toBe("codex.explicitlyEnabled.enabled is not false");
    expect(parseHostMcpOverrides(JSON.stringify({ version: 1, codex: { explicitlyEnabled: { enabled: true, reason: "fixture", source_command: "portable-tool", at: "now" }, a: good }, claude: {} }))).toEqual(emptyOverrides());
    expect(why({ version: 1, codex: { a: { enabled: false, source_command: "x" } }, claude: {} })).toBe("codex.a.reason is not a string");
    expect(why({ version: 1, codex: { a: { enabled: false, reason: "r", at: "t" } }, claude: {} })).toBe("codex.a.source_command is not a string");
    expect(why({ version: 1, codex: {}, claude: { a: { enabled: false, reason: "r", source_command: "s" } } })).toBe("claude.a.at is not a string");
    let reason: string | undefined;
    parseHostMcpOverrides("{broken", (r) => { reason = r; });
    expect(reason).toMatch(/^not JSON/);
    // readHostMcpOverrides: a missing file is silent, an invalid one reports through the callback.
    const seen: string[] = [];
    expect(readHostMcpOverrides(dir, (r) => seen.push(r))).toEqual(emptyOverrides());
    expect(seen).toEqual([]);
    fs.mkdirSync(path.join(dir, ".codecast"));
    fs.writeFileSync(hostMcpOverridesPath(dir), JSON.stringify({ version: 1, codex: { bad: { enabled: true } }, claude: {} }));
    expect(readHostMcpOverrides(dir, (r) => seen.push(r))).toEqual(emptyOverrides());
    expect(seen).toEqual(["codex.bad.enabled is not false"]);
  });
  test("write refuses a symlinked ~/.codecast (nothing lands outside) and never adopts a planted temp", () => {
    const outside = path.join(dir, "outside");
    const linked = path.join(dir, "linked-home");
    fs.mkdirSync(outside); fs.mkdirSync(linked);
    fs.symlinkSync(outside, path.join(linked, ".codecast"));
    expect(() => writeHostMcpOverrides(linked, emptyOverrides())).toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
    const marker = path.join(dir, "marker");
    fs.writeFileSync(marker, "untouched");
    fs.mkdirSync(path.join(dir, ".codecast"), { mode: 0o700 });
    fs.symlinkSync(marker, path.join(dir, ".codecast", `.host-mcp-overrides.json.${process.pid}.tmp`));
    writeHostMcpOverrides(dir, pinned());
    expect(fs.readFileSync(marker, "utf-8")).toBe("untouched");
    expect(readHostMcpOverrides(dir)).toEqual(pinned());
  });
  test("write is 0600 in a 0700 ~/.codecast, atomic (no temp file left), and round-trips through read", () => {
    const o = pinned();
    writeHostMcpOverrides(dir, o);
    const file = hostMcpOverridesPath(dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["host-mcp-overrides.json"]);
    expect(readHostMcpOverrides(dir)).toEqual(o);
    expect(fs.readFileSync(file, "utf-8")).toBe(serializeHostMcpOverrides(o));
    expect(fs.readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
    // A rewrite replaces in place and keeps the mode.
    writeHostMcpOverrides(dir, emptyOverrides());
    expect(readHostMcpOverrides(dir)).toEqual(emptyOverrides());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  test("serialize is canonical: sorted names, stable key order", () => {
    const a = serializeHostMcpOverrides({ version: 1, codex: { b: { enabled: false, reason: "r", source_command: "s", at: "t" }, a: { enabled: false, reason: "r", source_command: "s", at: "t" } }, claude: {} });
    const b = serializeHostMcpOverrides({ version: 1, claude: {}, codex: { a: { at: "t", source_command: "s", reason: "r", enabled: false }, b: { enabled: false, reason: "r", source_command: "s", at: "t" } } });
    expect(a).toBe(b);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
  });
});

describe("reconcilePins — the readiness side", () => {
  test("adds pins for unsupported, drops pins for names now ok / missing_portable or absent, never touches the other harness", () => {
    const start: HostMcpOverrides = {
      version: 1,
      codex: { gone: { enabled: false, reason: "r", source_command: "x", at: "t" }, fixed: { enabled: false, reason: "r", source_command: "y", at: "t" } },
      claude: { keepme: { enabled: false, reason: "r", source_command: "z", at: "t" } },
    };
    const classified: McpClassified[] = [
      { name: "computer_use", command: "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient", status: "unsupported", reason: "Mach-O" },
      { name: "fixed", command: "npx", args: ["-y", "x"], status: "ok" },
      { name: "portable", command: "uvx", args: ["y"], status: "missing_portable" },
    ];
    const next = reconcilePins(start, "codex", classified, AT, HOME);
    expect(next).toEqual({
      version: 1,
      codex: { computer_use: { enabled: false, reason: "Mach-O", source_command: MAC, at: AT } },
      claude: start.claude,
    });
    // The input is not mutated.
    expect(Object.keys(start.codex).sort()).toEqual(["fixed", "gone"]);
  });
  test("re-confirming an unchanged pin keeps its original time; a changed command or reason re-stamps it", () => {
    const start = pinned();
    const same = reconcilePins(start, "codex", [{ name: "computer_use", command: MAC, status: "unsupported", reason: "Mach-O" }], AT, HOME);
    expect(same.codex.computer_use!.at).toBe("2026-09-01T00:00:00Z");
    const moved = reconcilePins(start, "codex", [{ name: "computer_use", command: "/Applications/Other.app/Contents/MacOS/x", status: "unsupported", reason: "Mach-O" }], AT, HOME);
    expect(moved.codex.computer_use!.at).toBe(AT);
    expect(moved.codex.computer_use!.source_command).toBe("/Applications/Other.app/Contents/MacOS/x");
    const rereasoned = reconcilePins(start, "codex", [{ name: "computer_use", command: MAC, status: "unsupported", reason: ".app bundle" }], AT, HOME);
    expect(rereasoned.codex.computer_use!.at).toBe(AT);
    expect(rereasoned.codex.computer_use!.reason).toBe(".app bundle");
  });
  test("an empty roster clears the harness; a missing reason falls back to the pin's or a default", () => {
    expect(reconcilePins(pinned(), "codex", [], AT, HOME).codex).toEqual({});
    expect(reconcilePins(pinned(), "codex", [{ name: "computer_use", command: MAC, status: "unsupported" }], AT, HOME).codex.computer_use!.reason).toBe("Mach-O");
    expect(reconcilePins(emptyOverrides(), "claude", [{ name: "n", command: "/Applications/x", status: "unsupported" }], AT, HOME).claude.n!.reason).toBe("unsupported on this host");
  });
});

describe("maskPins — the apply side", () => {
  test("pins whose source still matches are pinned; a changed command or a gone server is dropped, and `next` no longer carries it", () => {
    const o: HostMcpOverrides = {
      version: 1,
      codex: {
        computer_use: { enabled: false, reason: "Mach-O", source_command: MAC, at: "t" },
        changed: { enabled: false, reason: "r", source_command: "/opt/homebrew/bin/x --old", at: "t" },
        gone: { enabled: false, reason: "r", source_command: "/Applications/Y.app/Contents/MacOS/y", at: "t" },
      },
      claude: { other: { enabled: false, reason: "r", source_command: "q", at: "t" } },
    };
    const current = {
      computer_use: { command: "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient" },
      changed: { command: "npx", args: ["-y", "x"] },
      fresh: { command: "npx", args: ["z"] },
    };
    const r = maskPins(o, "codex", current, HOME);
    expect(r.pinned).toEqual(["computer_use"]);
    expect(r.dropped).toEqual(["changed", "gone"]);
    expect(r.next).toEqual({ version: 1, codex: { computer_use: o.codex.computer_use }, claude: o.claude });
    expect(Object.keys(o.codex).sort()).toEqual(["changed", "computer_use", "gone"]);
  });
  test("whitespace and ~ spelling differences do not drop a pin (both sides go through normalizeCommand)", () => {
    const o: HostMcpOverrides = { version: 1, codex: { a: { enabled: false, reason: "r", source_command: "/home/ubuntu/bin/x --flag", at: "t" } }, claude: {} };
    expect(maskPins(o, "codex", { a: { command: "$HOME/bin/x", args: ["  --flag "] } }, HOME).pinned).toEqual(["a"]);
    expect(maskPins(o, "codex", { a: { command: "~/bin/x --flag" } }, HOME).pinned).toEqual(["a"]);
  });
});

describe("a mergeCodexToml-style consumer", () => {
  test("applies enabled = false from the manifest to the pinned table only, leaving the canonical definition and the other tables untouched", () => {
    const canonical = `model = "gpt-5"

[mcp_servers.computer_use]
command = "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]

[projects."/home/ubuntu/work/codecast"]
trust_level = "trusted"
`;
    // What the mirror does: mask BEFORE reconciling, force enabled=false AFTER merging.
    const source = {
      computer_use: { command: "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient" },
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    };
    const { pinned: names, next } = maskPins(pinned(), "codex", source, HOME);
    expect(next).toEqual(pinned());
    const tables = splitTomlTables(canonical);
    for (const t of tables) {
      const m = /^mcp_servers\.(.+)$/.exec(t.name ?? "");
      if (!m || !names.includes(m[1]!.replace(/^"|"$/g, ""))) continue;
      t.lines = t.lines.filter((l) => !/^\s*enabled\s*=/.test(l));
      const trailing = t.lines.length && t.lines[t.lines.length - 1] === "" ? t.lines.pop() : undefined;
      t.lines.push("enabled = false");
      if (trailing !== undefined) t.lines.push(trailing);
    }
    const out = joinTomlTables(tables);
    expect(out).toContain('[mcp_servers.computer_use]\ncommand = "~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"\nenabled = false\n');
    expect(out).toContain('[mcp_servers.filesystem]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-filesystem"]\n\n[projects');
    expect(out.replace("\nenabled = false", "")).toBe(canonical);
  });
  test("describeHostMcpOverrides", () => {
    expect(describeHostMcpOverrides(emptyOverrides())).toBe("");
    expect(describeHostMcpOverrides({ ...pinned(), claude: { b: { enabled: false, reason: "", source_command: "", at: "" }, a: { enabled: false, reason: "", source_command: "", at: "" } } })).toBe("codex: computer_use; claude: a, b");
  });
});
