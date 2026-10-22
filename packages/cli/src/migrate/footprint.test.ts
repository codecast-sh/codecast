import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandNames, commandPaths, computeFootprint, folderOf, readToolCalls, withoutHeredocs } from "./footprint.js";

function home(): string {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fp-home-")));
  for (const d of ["src/video/.git", "src/dailies/.git", "src/dailies/app", ".dailies/data", ".claude/.git", "Library/LaunchAgents", "notes"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  return h;
}

const deps = (h: string, extra: object = {}) => ({ home: h, which: (names: string[]) => Object.fromEntries(names.map((n) => [n, `/opt/homebrew/bin/${n}`])), loaded: () => true, exactName: () => true, ...extra });

describe("reading commands", () => {
  test("names the program of each pipeline stage, past env and wrappers", () => {
    expect(commandNames("cd ~/src/x && FOO=1 pnpm build | tee log; sudo xcodegen generate")).toEqual(["pnpm", "tee", "xcodegen"]);
  });
  test("heredoc bodies and multi-line quoted scripts are data", () => {
    expect(withoutHeredocs("cat > f <<'EOF'\nimport os\nEOF\nuv run x")).toBe("cat > f <<'EOF'\nuv run x");
    expect(commandNames(`python3 -c "\nimport json\nprint(1)\n" && cf auth whoami`)).toEqual(["python3", "cf"]);
  });
  test("paths under the home in any spelling", () => {
    expect(commandPaths("ls ~/.dailies/data $HOME/src/a /Users/me/src/b /tmp/x", "/Users/me")).toEqual(["/Users/me/.dailies/data", "/Users/me/src/a", "/Users/me/src/b"]);
  });
  test("a folder outside a repo is reported two levels down, an app's dot folder at its top", () => {
    expect(folderOf("/Users/me/.dailies/data/db", "/Users/me")).toBe("/Users/me/.dailies");
    expect(folderOf("/Users/me/notes/a/b.md", "/Users/me")).toBe("/Users/me/notes/a");
    expect(folderOf("/Users/me/.claude/x", "/Users/me")).toBeNull();
  });
});

describe("computeFootprint", () => {
  test("finds the other repo, the data folder, the service and the tools; skips its own checkout and agent config", () => {
    const h = home();
    const root = path.join(h, "src/video");
    fs.writeFileSync(path.join(h, "Library/LaunchAgents/sh.dailies.host.plist"), `<string>${h}/src/dailies/host/run.sh</string>`);
    fs.writeFileSync(path.join(h, "Library/LaunchAgents/com.other.plist"), "<string>/usr/bin/true</string>");
    const fp = computeFootprint(root, {
      writes: [`${h}/src/dailies/app/a.ts`, `${root}/x.ts`, `${h}/.claude/settings.json`],
      reads: [],
      commands: [`cd ${h}/src/dailies && pnpm test`, "ls ~/.dailies/data", "du -sh ~/.dailies", "cat ~/.dailies/data/x", "pnpm build", "xcodegen", "xcodegen"],
    }, deps(h));
    expect(fp.areas.map((a) => [a.path.slice(h.length), a.kind])).toEqual([["/src/dailies", "repo"], ["/.dailies", "folder"]]);
    expect(fp.services.map((s) => s.label)).toEqual(["sh.dailies.host"]);
    expect(fp.tools.map((t) => t.tool)).toEqual(["pnpm", "xcodegen"]);
  });

  test("tools found only in system folders, or spelled differently on a case-insensitive disk, are not reported", () => {
    const h = home();
    const fp = computeFootprint(path.join(h, "src/video"), { writes: [], reads: [], commands: ["Tests pass", "Tests pass", "ls", "ls"] }, deps(h, {
      which: (n: string[]) => Object.fromEntries(n.map((x) => [x, x === "ls" ? "/bin/ls" : "/opt/homebrew/bin/tests"])),
      exactName: (_p: string, name: string) => name === name.toLowerCase(),
    }));
    expect(fp.tools).toEqual([]);
  });

  test("reads tool calls from transcript lines", () => {
    const h = home();
    const file = path.join(h, "t.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/b" } }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "user", message: { content: "no tools" } }),
    ].join("\n"));
    expect(readToolCalls([file])).toEqual({ writes: ["/a/b"], reads: [], commands: ["ls"] });
  });
});
