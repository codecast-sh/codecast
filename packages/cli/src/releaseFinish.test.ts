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
      expect(decideForce(cliOnly, { sha: base, floor: "1.0.0" }, at)).toMatchObject({ force: false, reason: expect.stringMatching(/^no force: daemon unchanged/) });
      expect(decideForce(daemon, { sha: cliOnly, floor: "1.0.1" }, at)).toMatchObject({ force: true, reason: expect.stringMatching(/^daemon changed/) });
    } finally {
      r.cleanup();
    }
    // Real git and tar, five archives: slow on a loaded machine.
  }, 60_000);

  test("forces when no deploy of the release the floor names is recorded", () => {
    const unread = () => { throw new Error("not read"); };
    expect(decideForce("a".repeat(40), null, unread).force).toBe(true);
    expect(decideForce("a".repeat(40), { sha: null, floor: "1.1.300" }, unread)).toEqual({ force: true, reason: expect.stringContaining("the floor names (1.1.300)") });
    expect(decideForce("a".repeat(40), { sha: "a".repeat(40), floor: "1.1.300" }, unread).force).toBe(false);
  });

  test("forces, and says so, when the new release's own commit cannot be read", () => {
    const unread = (sha: string) => { if (sha.startsWith("b")) throw new Error("git archive failed"); return "old-build"; };
    expect(decideForce("b".repeat(40), { sha: "a".repeat(40), floor: "1.1.300" }, unread)).toEqual({ force: true, reason: "could not read bbbbbbbbbb: forced" });
  });

  test("forces, and says so, when the commit of the release the floor names cannot be read", () => {
    const r = repo();
    try {
      const now = r.commit({ "packages/cli/src/daemon.ts": "export const d = 1;\n", "packages/cli/package.json": JSON.stringify({ version: "1.0.1", dependencies: {} }) });
      // A sha this clone never had, and no origin to fetch it from: real git fails.
      const gone = "f".repeat(40);
      expect(decideForce(now, { sha: gone, floor: "1.0.0" }, (sha) => daemonBuildIdAt(r.root, sha))).toEqual({ force: true, reason: "could not read ffffffffff: forced" });
    } finally {
      r.cleanup();
    }
  }, 30_000);
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
  function server(deploy: Record<string, unknown>, o: { forced?: unknown; set?: () => unknown; fleet?: Fleet; laterNote?: string; otherTeams?: number } = {}) {
    const calls: Array<{ path: string; body: any }> = [];
    let gets = 0;
    const post = async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body: structuredClone(body) });
      if (path === "/cli/deploys/get") return { short_id: "dp-9", sha: "b".repeat(40), previous_sha: "a".repeat(40), team_id: "team_1", note: null, ...deploy, ...(gets++ && o.laterNote !== undefined ? { note: o.laterNote } : {}) };
      if (path === "/cli/team-cli-floor/forced") return o.forced !== undefined ? o.forced : { floor: "1.1.305", sha: "a".repeat(40), deploy: "dp-8" };
      if (path === "/cli/team-cli-floor/set") return o.set ? o.set() : { team: "Acme", version: body.version, changed: true };
      if (path === "/cli/team-cli-floor/fleet") return o.fleet ?? fleet([]);
      if (path === "/cli/team-cli-floor/tell-release") return { told: "release" };
      if (path === "/cli/team-cli-floor/tell-other-teams") return { asked: o.otherTeams ?? 0 };
      return { short_id: "dp-9", status: "live" };
    };
    return { calls, post };
  }
  const ids = (changed: boolean) => (sha: string) => (changed && sha.startsWith("b") ? "new-build" : "old-build");

  test("a daemon change raises the deploy's team floor, waits for the fleet and records both", async () => {
    const s = server({});
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {} });
    expect(s.calls.map((c) => c.path)).toEqual(["/cli/deploys/get", "/cli/team-cli-floor/forced", "/cli/team-cli-floor/tell-other-teams", "/cli/team-cli-floor/set", "/cli/team-cli-floor/fleet", "/cli/deploys/get", "/cli/line/deploy/report"]);
    expect(s.calls[3]!.body).toEqual({ team_id: "team_1", version: "1.1.306" });
    expect(note).toContain("daemon changed since 1.1.305 (aaaaaaaaaa) (build old-build -> new-build)");
    expect(note).toContain("Forced: Acme's floor is now 1.1.306.");
    expect(note).toContain("Fleet on 1.1.306 (Acme): 1 took it, 0 lagging");
    expect(s.calls[6]!.body).toEqual({ deploy: "dp-9", status: "live", note });
  });

  test("staff running it raise the global floor too, so other teams' machines take a daemon change", async () => {
    const s = server({});
    const global: string[] = [];
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {}, setGlobal: async (v) => { global.push(v); return true; } });
    expect(global).toEqual(["1.1.306"]);
    expect(note).toContain("Forced everywhere: the global floor is now 1.1.306.");
    expect(note).toContain("Forced: Acme's floor is now 1.1.306.");
    // Every team is held to the global floor: no other team's Captain needs telling.
    expect(s.calls.some((c) => c.path === "/cli/team-cli-floor/tell-other-teams")).toBe(false);
  });

  test("staff running an older release's finish never lower the global floor a newer release set", async () => {
    const s = server({});
    const global: string[] = [];
    const setGlobal = async (v: string) => { global.push(v); return true; };
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {}, setGlobal, globalFloor: async () => "1.1.310" });
    expect(global).toEqual([]);
    expect(note).toContain("Global floor already at 1.1.310.");
    expect(note).not.toContain("Forced everywhere");
    expect(s.calls.some((c) => c.path === "/cli/team-cli-floor/tell-other-teams")).toBe(false);
    // Below the release, it is raised; unreadable, it is left alone.
    const raised = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: server({}).post, buildIdAt: ids(true), log: () => {}, setGlobal, globalFloor: async () => "1.1.300" });
    expect(global).toEqual(["1.1.306"]);
    expect(raised).toContain("Forced everywhere: the global floor is now 1.1.306.");
    const unread = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.307", waitMs: 0, post: server({}).post, buildIdAt: ids(true), log: () => {}, setGlobal, globalFloor: async () => { throw new Error("offline"); } });
    expect(global).toEqual(["1.1.306"]);
    expect(unread).toContain("Could not read the global floor, so it is not raised: offline");
  });

  test("a non-staff finish forces only its own team and has the server tell other teams' Release Captains; an unchanged daemon asks for neither", async () => {
    const asked: string[] = [];
    const setGlobal = async (v: string) => { asked.push(v); return false; };
    const s = server({}, { otherTeams: 2 });
    const forced = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {}, setGlobal });
    expect(forced).not.toContain("Forced everywhere");
    expect(forced).toContain("Forced: Acme's floor is now 1.1.306.");
    expect(s.calls.find((c) => c.path === "/cli/team-cli-floor/tell-other-teams")!.body).toEqual({ deploy: "dp-9", version: "1.1.306" });
    expect(forced).toContain("Checking 2 other teams with a Release Captain: each whose machines run older is told.");
    const unchanged = server({});
    await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.307", waitMs: 0, post: unchanged.post, buildIdAt: ids(false), log: () => {}, setGlobal });
    expect(asked).toEqual(["1.1.306"]);
    expect(unchanged.calls.some((c) => c.path === "/cli/team-cli-floor/tell-other-teams")).toBe(false);
  });

  test("an earlier release's commit that cannot be read forces, and the finish still records it", async () => {
    const s = server({});
    const buildIdAt = (sha: string) => { if (sha.startsWith("a")) throw new Error("git archive aaaaaaaaaa failed"); return "new-build"; };
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt, log: () => {} });
    expect(note).toContain("Release 1.1.306: could not read aaaaaaaaaa: forced");
    expect(note).toContain("Forced: Acme's floor is now 1.1.306.");
    expect(s.calls.at(-1)!.path).toBe("/cli/line/deploy/report");
  });

  test("an unchanged daemon forces nothing and says so on the deploy, after the note it had", async () => {
    const s = server({ note: "Sent by Ana" });
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(false), log: () => {} });
    expect(s.calls.map((c) => c.path)).toEqual(["/cli/deploys/get", "/cli/team-cli-floor/forced", "/cli/deploys/get", "/cli/line/deploy/report"]);
    expect(note).toBe("Sent by Ana\n\nRelease 1.1.306: no force: daemon unchanged since 1.1.305 (aaaaaaaaaa) (build old-build)");
  });

  test("a release that skipped its force is made up: the daemon is compared with the release the floor names, not the one before", async () => {
    // 1.1.305 (a) is the floor; 1.1.306 (b) changed the daemon but was not forced; 1.1.307 (c) leaves it as 1.1.306 had it.
    const s = server({ sha: "c".repeat(40), previous_sha: "b".repeat(40) });
    const id = (sha: string) => (sha.startsWith("a") ? "old-build" : "new-build");
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.307", waitMs: 0, post: s.post, buildIdAt: id, log: () => {} });
    expect(note).toContain("daemon changed since 1.1.305 (aaaaaaaaaa) (build old-build -> new-build)");
    expect(s.calls.some((c) => c.path === "/cli/team-cli-floor/set")).toBe(true);
  });

  test("a finish whose runner cannot raise the floor records why, tells @release, and still reports the deploy", async () => {
    const refusal = "Forcing a team's machines onto a release is held by the team's admins and its Release Captain";
    const s = server({}, { set: () => { throw new Error(refusal); } });
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {} });
    expect(note).toContain(`Not forced: ${refusal}`);
    expect(note).toContain("Told @release.");
    expect(s.calls.find((c) => c.path === "/cli/team-cli-floor/tell-release")!.body).toEqual({ team_id: "team_1", deploy: "dp-9", version: "1.1.306", not_forced: refusal });
    expect(s.calls.some((c) => c.path === "/cli/team-cli-floor/fleet")).toBe(false);
    expect(s.calls.at(-1)!.path).toBe("/cli/line/deploy/report");
  });

  test("machines still lagging after the wait reach @release once; a note written during the wait is kept", async () => {
    const s = server({ note: "Sent by Ana" }, { fleet: fleet([device("bo-mac", "1.1.305")]), laterNote: "Sent by Ana\n\nPaused by Bo" });
    const note = await finishCliRelease({ root: "/x", deploy: "dp-9", version: "1.1.306", waitMs: 0, post: s.post, buildIdAt: ids(true), log: () => {} });
    const tells = s.calls.filter((c) => c.path === "/cli/team-cli-floor/tell-release");
    expect(tells.map((c) => c.body)).toEqual([{ team_id: "team_1", deploy: "dp-9", version: "1.1.306" }]);
    expect(note.startsWith("Sent by Ana\n\nPaused by Bo\n\nRelease 1.1.306:")).toBe(true);
    expect(note).toContain("Lagging: bo-mac (Bo, 1.1.305)");
  });
});
