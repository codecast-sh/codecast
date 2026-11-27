// The CLI release's finish (ct-102483): force the team's machines only when
// the daemon build id changed between the release and the one before it,
// then record the decision and the fleet on the deploy.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "./proc.js";
import { daemonBuildIdAt, decideForce, finishCliRelease, fleetNote, waitForFleet, type Fleet } from "./releaseFinish";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cast-release-finish-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const commit = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  return { root, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("the daemon build id at a commit", () => {
  test("moves with daemon code, not with code the daemon never imports", () => {
    const r = repo();
    try {
      const base = r.commit({
        "packages/cli/src/daemon.ts": `import { a } from "./a.js";\nexport const d = a;\n`,
        "packages/cli/src/a.ts": "export const a = 1;\n",
        "packages/cli/src/cliOnly.ts": "export const c = 1;\n",
        "packages/cli/package.json": JSON.stringify({ version: "1.0.0", dependencies: {} }),
      });
      const cliOnly = r.commit({ "packages/cli/src/cliOnly.ts": "export const c = 2;\n", "packages/cli/package.json": JSON.stringify({ version: "1.0.1", dependencies: {} }) });
      const daemon = r.commit({ "packages/cli/src/a.ts": "export const a = 2;\n" });
      const at = (sha: string) => daemonBuildIdAt(r.root, sha);
      expect(at(cliOnly)).toBe(at(base));
      expect(at(daemon)).not.toBe(at(base));
      expect(decideForce(cliOnly, base, at)).toMatchObject({ force: false, reason: expect.stringMatching(/^no force: daemon unchanged/) });
      expect(decideForce(daemon, cliOnly, at)).toMatchObject({ force: true, reason: expect.stringMatching(/^daemon changed/) });
    } finally {
      r.cleanup();
    }
    // Real git and tar, five archives: slow on a loaded machine.
  }, 60_000);

  test("forces when the deploy records no release before it", () => {
    expect(decideForce("a".repeat(40), null, () => { throw new Error("not read"); }).force).toBe(true);
  });
});

const device = (label: string, cli_version: string, online = true) => ({ device_id: label, label, owner: "Bo", cli_version, online, error: null });
const fleet = (lagging: ReturnType<typeof device>[], took = [device("ana-mac", "1.1.306")]): Fleet => ({ team: "Acme", version: "1.1.306", floor: "1.1.306", took, lagging, offline: [], cannot_update: [] });

describe("waiting for the fleet", () => {
  test("stops once no online machine lags", async () => {
    const reads = [fleet([device("bo-mac", "1.1.305")]), fleet([], [device("ana-mac", "1.1.306"), device("bo-mac", "1.1.306")])];
    let clock = 0;
    const out = await waitForFleet(async () => reads.shift()!, { waitMs: 20 * 60_000, sleep: async (ms) => { clock += ms; }, now: () => clock });
    expect(out.lagging).toEqual([]);
    expect(out.took).toHaveLength(2);
    expect(clock).toBe(60_000);
  });

  test("gives up at the deadline with the laggards named", async () => {
    let clock = 0;
    let reads = 0;
    const out = await waitForFleet(async () => (reads++, fleet([device("bo-mac", "1.1.305")])), { waitMs: 5 * 60_000, sleep: async (ms) => { clock += ms; }, now: () => clock });
    expect(reads).toBe(6);
    expect(fleetNote(out)).toBe("Fleet on 1.1.306 (Acme): 1 took it, 1 lagging, 0 offline, 0 cannot update themselves.\nLagging: bo-mac (Bo, 1.1.305)");
  });
});

describe("the finish", () => {
  function server(deploy: Record<string, unknown>) {
    const calls: Array<{ path: string; body: any }> = [];
    const post = async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body: structuredClone(body) });
      if (path === "/cli/deploys/get") return { short_id: "dp-9", sha: "b".repeat(40), previous_sha: "a".repeat(40), team_id: "team_1", note: null, ...deploy };
      if (path === "/cli/team-cli-floor/set") return { team: "Acme", version: body.version, changed: true };
      if (path === "/cli/team-cli-floor/fleet") return fleet([]);
      return { short_id: "dp-9", status: "live" };
    };
    return { calls, post };
  }
  const ids = (changed: boolean) => (sha: string) => (changed && sha.startsWith("b") ? "new-build" : "old-build");

  test("a daemon change raises the deploy's team floor, waits for the fleet and records both", async () => {
    const s = server({});
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {} });
    expect(s.calls.map((c) => c.path)).toEqual(["/cli/deploys/get", "/cli/team-cli-floor/set", "/cli/team-cli-floor/fleet", "/cli/line/deploy/report"]);
    expect(s.calls[1]!.body).toEqual({ team_id: "team_1", version: "1.1.306" });
    expect(note).toContain("daemon changed since aaaaaaaaaa (build old-build -> new-build)");
    expect(note).toContain("Forced: Acme's floor is now 1.1.306.");
    expect(note).toContain("Fleet on 1.1.306 (Acme): 1 took it, 0 lagging");
    expect(s.calls[3]!.body).toEqual({ deploy: "dp-9", status: "live", note });
  });

  test("staff running it raise the global floor too, so other teams' machines take a daemon change", async () => {
    const s = server({});
    const global: string[] = [];
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {}, setGlobal: async (v) => { global.push(v); return true; } });
    expect(global).toEqual(["1.1.306"]);
    expect(note).toContain("Forced everywhere: the global floor is now 1.1.306.");
    expect(note).toContain("Forced: Acme's floor is now 1.1.306.");
  });

  test("a non-staff finish forces only its own team, and an unchanged daemon never asks for the global floor", async () => {
    const asked: string[] = [];
    const setGlobal = async (v: string) => { asked.push(v); return false; };
    const forced = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: server({}).post, buildIdAt: ids(true), log: () => {}, setGlobal });
    expect(forced).not.toContain("Forced everywhere");
    expect(forced).toContain("Forced: Acme's floor is now 1.1.306.");
    await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.307", waitMs: 0, post: server({}).post, buildIdAt: ids(false), log: () => {}, setGlobal });
    expect(asked).toEqual(["1.1.306"]);
  });

  test("an unchanged daemon forces nothing and says so on the deploy, after the note it had", async () => {
    const s = server({ note: "Sent by Ana" });
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(false), log: () => {} });
    expect(s.calls.map((c) => c.path)).toEqual(["/cli/deploys/get", "/cli/line/deploy/report"]);
    expect(note).toBe("Sent by Ana\n\nRelease 1.1.306: no force: daemon unchanged since aaaaaaaaaa (build old-build)");
  });
});
