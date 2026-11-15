import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ParityLedger, parityKey } from "./parity";
import { applyEnvironment, missingBranches, whereSet, type ApplyDeps, type ProbeInput } from "./apply";
import type { EnvPlan, RepoPlan } from "./inventory";

const host = { address: "203.0.113.9", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

function plan(ledger: ParityLedger): EnvPlan {
  const repo = (name: string, tree: string, extra: Partial<RepoPlan> = {}): RepoPlan => ({
    key: ledger.plan("repo", name), root: `/Users/me/${name.slice(2)}`, name,
    snapshot: { tree, head: "h1", branch: "main", sha: "s1", skipped: [], skippedCount: 0, agentPaths: [".claude"] },
    branches: { main: "h1", feature: "f1" }, branchesKey: ledger.plan("repo", `${name}: branches`),
    agentKey: ledger.plan("files", `${name}: agent config`), ...extra,
  });
  ledger.plan("config", "~/.claude");
  ledger.plan("config", "~/.codex");
  ledger.plan("login", "claude");
  ledger.plan("login", "gh");
  ledger.plan("tool", "uv");
  ledger.plan("tool", "ffmpeg");
  ledger.plan("tool", "never-reported");
  ledger.plan("env", "OPENAI_API_KEY");
  ledger.plan("env", "STRIPE_KEY");
  return {
    repos: [repo("~/src/good", "T-good"), repo("~/src/moved", "T-moved"), repo("~/src/broken", "T-broken"), repo("~/src/gone", "T-gone")],
    folders: [{ key: ledger.plan("folder", "~/notes"), path: "/Users/me/notes" }],
    extraTools: [{ tool: "psql", install: { brew: "postgresql@16" } }, { tool: "createdb", install: { brew: "libpq" } }, { tool: "gt", install: { brew: "graphite" } }], required: { node: { minMajor: 22, install: "", source: "" }, clients: {}, tools: [], unsupported: [] },
    mirror: { entries: [
      { path: ".claude/CLAUDE.md", kind: "verbatim", mode: "0600", bytes: Buffer.from(""), root: ".claude" },
      { path: ".codex/AGENTS.md", kind: "verbatim", mode: "0600", bytes: Buffer.from(""), root: ".codex" },
    ], skipped: [], excludesApplied: [], warnings: [], gitIdentity: {} },
    loginPaths: { "~/.config/gh/hosts.yml": "gh" },
    envNames: ["OPENAI_API_KEY", "STRIPE_KEY"],
  };
}

describe("applyEnvironment", () => {
  test("each item ends with what the host shows, and anything unreported fails", async () => {
    const ledger = new ParityLedger();
    const p = plan(ledger);
    let probed: ProbeInput | undefined;
    let apt: string[] = [];
    let reconnects = 0;
    const deps: ApplyDeps = {
      host, cloudId: "i-test", home: "/Users/me", log: () => {}, exists: (p) => p !== "/Users/me/src/gone",
      readyHome: async () => ({
        mirror: "mirrored",
        logins: { pushed: true, skipped: [], envSkipped: [], kept: [], claude: { pushed: true }, shipped: "gh", receiver: { pushed: true, kept: [] } },
        tools: { ok: [{ tool: "uv", version: "0.5" }], installed: [], unsupported: [], missing: [
          { tool: "ffmpeg", error: "apt is locked" }, { tool: "psql", error: "no portable install known" }, { tool: "createdb", error: "no portable install known" },
          { tool: "gt", error: "no portable install known" }, { tool: "osascript", error: "no portable install known" },
        ] },
      }),
      carryRepo: async (r) => {
        if (r.name === "~/src/broken") throw new Error("ssh: connection reset");
        return { remote: `/home/ubuntu/${r.name.slice(2)}`, tree: r.name === "~/src/moved" ? "T-other" : r.snapshot.tree, branchesMissing: r.name === "~/src/good" ? [] : ["feature"] };
      },
      carryFolder: async () => ({ remote: "/home/ubuntu/notes" }),
      projectContext: async () => {},
      reconnect: async () => { reconnects++; },
      pushMirror: async () => { throw new Error("config mirror failed: src/moved/.agents/x.md: destination is a symlink; src/good/.agents/y.md: destination is a symlink; .codex/rules/z.md: unsafe path; src/old/.agents/a.md: bytes differ; src/old/.agents/b.md: bytes differ; src/old/.agents/c.md: bytes differ"); },
      sameBytes: (rels) => new Set(rels.filter((r) => r !== "src/old/.agents/c.md")),
      hostSetup: () => ({ ok: true, line: "" }),
      aptInstall: (pkgs) => { apt = pkgs; return { ok: true }; },
      hasCommands: (names) => new Set(names.filter((n) => n !== "createdb")),
      probe: (input) => {
        probed = input;
        return { missing: new Set([".codex/AGENTS.md", "/home/ubuntu/src/moved/.claude"]), env: new Set(["OPENAI_API_KEY"]) };
      },
    };
    await applyEnvironment(ledger, p, deps);
    const r = ledger.finish({ laptop: "mac", target: "i-test" });
    const get = (area: Parameters<typeof parityKey>[0], name: string) => r.items.find((i) => i.key === parityKey(area, name));

    expect(get("repo", "~/src/good")?.status).toBe("carried");
    expect(get("repo", "~/src/good: branches")?.status).toBe("carried");
    expect(get("repo", "~/src/moved")).toMatchObject({ status: "failed", reason: expect.stringContaining("differs") });
    expect(get("repo", "~/src/moved: branches")).toMatchObject({ status: "skipped", reason: expect.stringContaining("feature") });
    // A dropped connection is retried once after reconnecting, then reported as it failed.
    expect(get("repo", "~/src/broken")).toMatchObject({ status: "failed", reason: "ssh: connection reset" });
    expect(reconnects).toBe(1);
    expect(get("files", "~/src/broken: agent config")?.status).toBe("failed");
    // A refusal in one repository says nothing about another: good's files are on the host, so it carried.
    expect(get("files", "~/src/good: agent config")).toMatchObject({ status: "carried", detail: expect.stringContaining("1 file the mirror would not rewrite") });
    expect(get("files", "~/src/moved: agent config")).toMatchObject({ status: "failed", reason: expect.stringContaining(".agents/x.md (destination is a symlink)") });
    // Outside the carried repositories: grouped per project and reason, and judged by the bytes on both machines.
    expect(get("config", "~/src/old: agent config the mirror refused")).toMatchObject({ status: "present", paths: ["~/src/old/.agents/a.md", "~/src/old/.agents/b.md"] });
    expect(get("config", "~/src/old: agent config the mirror refused (bytes differ)")).toMatchObject({ status: "failed", paths: ["~/src/old/.agents/c.md"] });
    expect(get("config", "~/.codex/rules: agent config the mirror refused")?.status).toBe("present");
    expect(get("config", "~/.claude")?.status).toBe("carried");
    expect(get("config", "~/.codex")).toMatchObject({ status: "failed", reason: expect.stringContaining(".codex/AGENTS.md") });
    expect(get("login", "claude")?.status).toBe("carried");
    expect(get("login", "gh")?.status).toBe("carried");
    expect(get("tool", "uv")?.status).toBe("present");
    expect(get("tool", "ffmpeg")).toMatchObject({ status: "failed", reason: "install failed: apt is locked" });
    // Homebrew formulas with an Ubuntu package go through apt and are checked on the host after.
    expect(apt).toEqual(["postgresql-client"]);
    expect(get("tool", "psql")).toMatchObject({ status: "installed", detail: "apt postgresql-client" });
    expect(get("tool", "createdb")).toMatchObject({ status: "failed", reason: expect.stringContaining("still not on the host") });
    expect(get("tool", "gt")).toMatchObject({ status: "skipped", reason: "no Linux install is known for it" });
    expect(get("tool", "osascript")).toMatchObject({ status: "skipped", reason: expect.stringContaining("macOS command") });
    expect(get("tool", "never-reported")).toMatchObject({ status: "failed", reason: "no step reported what happened to it" });
    expect(get("env", "OPENAI_API_KEY")?.status).toBe("present");
    expect(get("env", "STRIPE_KEY")).toMatchObject({ status: "failed", reason: expect.stringContaining("not in the host's") });
    expect(get("folder", "~/notes")?.status).toBe("carried");
    expect(get("repo", "~/src/gone")).toMatchObject({ status: "failed", reason: expect.stringContaining("no longer exists here") });
    expect(r.items.filter((i) => i.status === "planned")).toEqual([]);
    // The probe was asked about every file it should verify.
    expect(probed?.files).toEqual(expect.arrayContaining([".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/gh/hosts.yml"]));
    expect(probed?.paths).toEqual(expect.arrayContaining(["/home/ubuntu/src/good/.claude", "/home/ubuntu/notes"]));
  });

  test("a host-home step that throws fails every item it owned, with the reason", async () => {
    const ledger = new ParityLedger();
    const p = { ...plan(ledger), repos: [], folders: [] };
    await applyEnvironment(ledger, p, {
      host, cloudId: "i-test", home: "/Users/me", log: () => {},
      readyHome: async () => { throw new Error("the host's disk is full"); },
      probe: () => ({ missing: new Set(), env: new Set() }),
    });
    expect(ledger.get("tool:uv")).toMatchObject({ status: "failed", reason: expect.stringContaining("disk is full") });
    expect(ledger.get("config:~/.claude")).toMatchObject({ status: "failed" });
  });
});

test("missingBranches compares names and commits", () => {
  expect(missingBranches({ main: "a", f: "b", g: "c" }, "main a\nf x\n")).toEqual(["f", "g"]);
});

test("whereSet finds the shell file that sets a variable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "where-"));
  fs.writeFileSync(path.join(home, ".zshrc"), "alias x=y\nexport STRIPE_KEY=sk\n");
  expect(whereSet(home, "STRIPE_KEY")).toBe("~/.zshrc");
  expect(whereSet(home, "NOPE")).toBeUndefined();
  fs.rmSync(home, { recursive: true });
});
