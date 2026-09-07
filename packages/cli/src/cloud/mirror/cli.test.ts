import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import { buildMirrorBundle, type BundleInput } from "./bundle";

const processEntry = path.join(import.meta.dir, "..", "..", "main.ts");
const scratch: string[] = [];

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-cli-"));
  scratch.push(home);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "update-state.json"), JSON.stringify({ lastCheck: new Date().toISOString() }));
  return home;
}

async function runCli(home: string, args: string[], stdin: Buffer = Buffer.alloc(0)): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, processEntry, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", CODECAST_DIR: path.join(home, ".codecast") },
    stdin, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const h of scratch.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const memory = SNIPPET_CATALOG.find((d) => d.slug === "memory")!.section!;

function bundle(home: string, entries: BundleInput[], opts: { userId?: string; device?: string } = {}) {
  return buildMirrorBundle(entries, {
    source: { device_id: opts.device ?? "laptop-1", user_id: opts.userId ?? "u1", home: "/Users/a", platform: "darwin", cast_version: "1" },
    target_home: home, managed_roots: [".claude", ".codex"],
  }).bytes;
}

describe("cast cloud mirror-apply --stdin", () => {
  test("applies a bundle under HOME, prints the JSON result, stamps, and the enabled memory section is present exactly once after refresh", async () => {
    const home = scratchHome();
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ user_id: "u1", memory_enabled: true, memory_version: "14" }));
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), memory.body.replace(/^\n+/, ""));
    const r = await runCli(home, ["cloud", "mirror-apply", "--stdin"], bundle(home, [
      { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from("# Laptop rules\n\nBe brief.\n") },
      { path: ".claude/skills/mine/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("skill\n") },
    ]));
    expect(r.code, JSON.stringify(r)).toBe(0);
    const result = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(result.applied.sort()).toEqual([".claude/CLAUDE.md", ".claude/skills/mine/SKILL.md"]);
    expect(result.refused).toBeUndefined();
    const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf-8");
    expect(md.startsWith("# Laptop rules\n\nBe brief.\n")).toBe(true);
    expect(findOwnedSections(md, memory.spec)).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, ".claude/skills/mine/SKILL.md"), "utf-8")).toBe("skill\n");
    const stamp = JSON.parse(fs.readFileSync(path.join(home, ".codecast", "mirror.json"), "utf-8"));
    expect(stamp.source_device_id).toBe("laptop-1");
    expect(Object.keys(stamp.files).sort()).toEqual([".claude/CLAUDE.md", ".claude/skills/mine/SKILL.md"]);
    expect(fs.statSync(path.join(home, ".codecast", "mirror.json")).mode & 0o777).toBe(0o600);
    // The persistence pin lands even on a home that had no settings.json.
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8")).env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
    expect(fs.existsSync(path.join(home, ".codecast", "mirror.lock"))).toBe(false);

    const again = await runCli(home, ["cloud", "mirror-apply", "--stdin"], bundle(home, [
      { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from("# Laptop rules\n\nBe brief.\n") },
      { path: ".claude/skills/mine/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("skill\n") },
    ]));
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout.trim().split("\n").pop()!).applied).toEqual([]);
    expect(findOwnedSections(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf-8"), memory.spec)).toHaveLength(1);
    const verified = await runCli(home, ["cloud", "mirror-apply", "--verify"]);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout.trim()).complete).toBe(true);
    fs.writeFileSync(path.join(home, ".claude/skills/mine/SKILL.md"), "remote drift\n");
    const drifted = await runCli(home, ["cloud", "mirror-apply", "--verify"]);
    expect(drifted.code).toBe(0);
    expect(JSON.parse(drifted.stdout.trim()).complete).toBe(false);
    expect(JSON.parse(drifted.stdout.trim()).hash).toBe("");
  }, 60_000);

  test("exit 3 with refused on a user mismatch and on an unprovisioned host; exit 1 on a truncated bundle; nothing written", async () => {
    const home = scratchHome();
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ user_id: "u1" }));
    const other = await runCli(home, ["cloud", "mirror-apply", "--stdin"], bundle(home, [{ path: ".claude/x.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") }], { userId: "u2" }));
    expect(other.code, JSON.stringify(other)).toBe(3);
    expect(JSON.parse(other.stdout.trim().split("\n").pop()!).refused).toBe("other_user");
    expect(fs.existsSync(path.join(home, ".claude", "x.md"))).toBe(false);

    const full = bundle(home, [{ path: ".claude/x.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") }]);
    const truncated = await runCli(home, ["cloud", "mirror-apply", "--stdin"], full.subarray(0, full.length - 1));
    expect(truncated.code).toBe(1);
    expect(JSON.parse(truncated.stdout.trim().split("\n").pop()!).error).toMatch(/truncated/);
    expect(fs.existsSync(path.join(home, ".claude", "x.md"))).toBe(false);

    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({}));
    const unprov = await runCli(home, ["cloud", "mirror-apply", "--stdin"], full);
    expect(unprov.code).toBe(3);
    expect(JSON.parse(unprov.stdout.trim().split("\n").pop()!).refused).toBe("unprovisioned");
  }, 60_000);

  test("--into stages files verbatim under the directory and refuses a relative one", async () => {
    const home = scratchHome();
    const into = path.join(home, "repo", ".codecast", "workspaces", "cloud-1", "inputs");
    fs.mkdirSync(into, { recursive: true });
    const r = await runCli(home, ["cloud", "mirror-apply", "--stdin", "--into", into], bundle(home, [
      { path: ".env", kind: "verbatim", mode: "0600", bytes: Buffer.from("A=1\n") },
      { path: ".claude/skills/a/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("a\n") },
    ]));
    expect(r.code, JSON.stringify(r)).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ copied: [".claude/skills/a/SKILL.md", ".env"], errors: [] });
    expect(fs.readFileSync(path.join(into, ".env"), "utf-8")).toBe("A=1\n");
    expect(fs.existsSync(path.join(home, ".codecast", "mirror.json"))).toBe(false);
    const rel = await runCli(home, ["cloud", "mirror-apply", "--stdin", "--into", "relative/dir"], bundle(home, []));
    expect(rel.code).toBe(1);
  }, 60_000);
});
