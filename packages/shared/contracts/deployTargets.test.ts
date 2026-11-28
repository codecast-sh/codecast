import { describe, expect, test } from "bun:test";
import { commitCiState, commitTouchesTarget, DeployTargetError, fileShipsTo, globMatch, groupQueueBySession, isLiveVersionBump, parseLiveReader, readJsonLive, parseDeployTargetEntries, parseDeployTargets, publishableTarget, releaseOrder, targetFromLineDeploy, type QueueCommit } from "./deployTargets";

describe("deploy targets from config (deploys.md DP10)", () => {
  const SHIP = [{ name: "convex", when: ["api/**"], run: "deploy.sh", stage: "before_push" as const }];

  test("a [[target]] that names a ship step takes its command, paths and stage", () => {
    const raw = { target: [{ name: "backend", ship: "convex" }, { name: "web", runs: "push", when: "web/**", live: "github-status:acme - web" }] };
    expect(parseDeployTargets(raw, SHIP)).toEqual([
      { name: "backend", command: "deploy.sh", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["api/**"], ship_stage: "before_push" },
      { name: "web", runs: "push", live: { kind: "github-status", context: "acme - web" }, policy: "press", paths: ["web/**"], ship_stage: "press" },
    ]);
    expect(parseDeployTargetEntries(raw, SHIP).map((e) => e.ship_step)).toEqual(["convex", undefined]);
    expect(parseDeployTargets(undefined, SHIP)).toEqual([]);
  });

  test("a bad target is refused with its table and reason", () => {
    expect(() => parseDeployTargets({ target: [{ name: "x" }] }, SHIP)).toThrow(/target\[0\]: target x: runs = "here" needs run/);
    expect(() => parseDeployTargets({ target: [{ name: "x", run: "a", policy: "sometimes" }] }, SHIP)).toThrow(/policy/);
    expect(() => parseDeployTargets({ target: [{ name: "x", ship: "nope" }] }, SHIP)).toThrow(/names no \[\[ship.deploy\]\] step/);
    // A key this CLI does not know (a newer CLI's step, or a typo) is read past and named, never refused (DP10).
    expect(parseDeployTargetEntries({ target: [{ name: "x", run: "a", colour: "red" }] }, SHIP)).toMatchObject([{ target: { name: "x", command: "a" }, unknown: ["colour"] }]);
    expect(() => parseDeployTargets({ target: [{ name: "x", run: "a" }, { name: "x", run: "b" }] }, SHIP)).toThrow(/declared twice/);
    expect(() => parseDeployTargets({ targets: [] }, SHIP)).toThrow(DeployTargetError);
    expect(() => parseLiveReader("json:http://plain")).toThrow(/https/);
    expect(() => parseLiveReader("ping")).toThrow(/not marker/);
  });

  test("a line's [line.deploy] is one target", () => {
    expect(targetFromLineDeploy({ command: "outreach/deploy.sh", target: "production" })).toMatchObject({ name: "production", runs: "here", paths: [] });
    expect(targetFromLineDeploy({ command: null })).toBeNull();
  });

  test("a json reader reads the commit and the version from a release document", () => {
    const r = parseLiveReader("json:https://dl.x.dev/latest.json#sourceCommit,version");
    expect(r).toEqual({ kind: "json", url: "https://dl.x.dev/latest.json", sha_field: "sourceCommit", version_field: "version" });
    expect(readJsonLive(r as any, { version: "1.1.211", sourceCommit: "688578E6C7411589F57E2049B6BB31ABD8E185B9" })).toEqual({ sha: "688578e6c7411589f57e2049b6bb31abd8e185b9", version: "1.1.211" });
    expect(readJsonLive(parseLiveReader("json:https://x.dev/version.json#sha") as any, { sha: "unknown" }).sha).toBeNull();
  });
});

describe("what waits on a target (DP12)", () => {
  test("a commit ships to a target when it touches one of its paths; unknown files count", () => {
    expect(commitTouchesTarget({ paths: ["packages/convex/**"] }, ["packages/convex/convex/a.ts"])).toBe(true);
    expect(commitTouchesTarget({ paths: ["packages/convex/**"] }, ["packages/web/a.ts"])).toBe(false);
    expect(commitTouchesTarget({ paths: ["packages/convex/**"] }, null)).toBe(true);
    expect(commitTouchesTarget({ paths: [] }, ["anything"])).toBe(true);
    // What a target exempts ships nothing there; one shipped file among them ships it, and unknown files still count.
    const cli = { paths: ["packages/cli/**", "packages/shared/**"], unless: ["**/*.test.ts", "**/__fixtures__/**"] };
    expect(commitTouchesTarget(cli, ["packages/cli/src/a.test.ts", "packages/shared/contracts/__fixtures__/x.json"])).toBe(false);
    expect(commitTouchesTarget(cli, ["packages/cli/src/a.ts", "packages/shared/contracts/b.test.ts"])).toBe(true);
    expect(commitTouchesTarget(cli, null)).toBe(true);
    expect(commitTouchesTarget({ unless: ["**/*.test.ts"] }, ["a.test.ts"])).toBe(false);
  });

  test("a glob: ** spans directories, none included; * stays inside one; a path as written matches itself", () => {
    expect(globMatch("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(globMatch("**/*.test.ts", "x/y/a.test.ts")).toBe(true);
    expect(globMatch("**/__tests__/**", "a/__tests__/b.ts")).toBe(true);
    expect(globMatch("**/__tests__/**", "a/my__tests__/b.ts")).toBe(false);
    expect(globMatch("*.md", "docs/a.md")).toBe(false);
    expect(fileShipsTo({ paths: ["packages/mobile/app/task/[id].tsx"] }, "packages/mobile/app/task/[id].tsx")).toBe(true);
    expect(fileShipsTo({ paths: ["packages/mobile/app/task/[id].tsx"] }, "packages/mobile/app/task/i.tsx")).toBe(false);
  });

  test("a commit's CI: red beats running beats green; a cancelled run says nothing; the newest run of a workflow speaks", () => {
    expect(commitCiState([])).toBe("none");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "success", at: 1 }, { name: "Lint", status: "in_progress", at: 1 }])).toBe("running");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "failure", at: 1 }, { name: "Lint", status: "in_progress", at: 1 }])).toBe("failed");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "failure", at: 1 }, { name: "CI", status: "completed", conclusion: "success", at: 2 }])).toBe("passed");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "cancelled", at: 1 }])).toBe("none");
  });

  test("the queue groups by session, the newest session's work first, commits no session claims last", () => {
    const c = (sha: string, at: number, conv: string | null, ci: QueueCommit["ci"]): QueueCommit => ({ sha, subject: sha, at, main_at: at, author: null, session: conv ? { conversation_id: conv, short_id: conv.slice(0, 7), title: conv } : null, tasks: [], ci, ci_url: null });
    const groups = groupQueueBySession([c("a", 1, "s1", "passed"), c("b", 2, null, "passed"), c("c", 3, "s2", "running"), c("d", 4, "s1", "failed")]);
    expect(groups.map((g) => [g.key, g.commits.map((x) => x.sha), g.ci])).toEqual([["s:s1", ["d", "a"], "failed"], ["s:s2", ["c"], "running"], ["none", ["b"], "passed"]]);
  });
});

describe("a release's order and steps (DP15)", () => {
  const parse = (targets: Array<Record<string, unknown>>) => parseDeployTargets({ target: targets }, []);

  test("after, ci and finish are read; release is a policy", () => {
    const [backend, mobile] = parse([
      { name: "backend", run: "./deploy.sh", policy: "release" },
      { name: "mobile", run: "./ota.sh $sha", policy: "release", after: "Backend", ci: "cast line deploy ci", finish: "echo $version" },
    ]);
    expect(backend.policy).toBe("release");
    expect(mobile).toMatchObject({ after: ["backend"], ci: "cast line deploy ci", finish: "echo $version" });
  });

  test("targets come out after the ones they wait on, whatever order they are declared in", () => {
    const order = releaseOrder(parse([
      { name: "mobile", run: "x", after: ["backend", "cli"] },
      { name: "cli", run: "x", after: "backend" },
      { name: "backend", run: "x" },
    ])).map((t) => t.name);
    expect(order).toEqual(["backend", "cli", "mobile"]);
  });

  test("an after naming no target, or a cycle, refuses the file", () => {
    expect(() => parse([{ name: "mobile", run: "x", after: "api" }])).toThrow("after names api, which is not a target");
    expect(() => parse([{ name: "a", run: "x", after: "b" }, { name: "b", run: "x", after: "a" }])).toThrow("wait on each other");
    expect(() => parse([{ name: "web", runs: "push", finish: "x" }])).toThrow('runs = "push" sends nothing, so it has no finish step');
    expect(() => parse([{ name: "web", runs: "push", gate: "x", rollout: "y" }])).toThrow("so it has no gate or rollout step");
  });

  test("the server is sent the target without the keys only the CLI reads", () => {
    const [t] = parse([{ name: "cli", run: "x", policy: "release", after: [], ci: "c", gate: "g", rollout: "r", finish: "f", unless: "**/*.test.ts" }]);
    expect([t.ci, t.gate, t.rollout, t.finish]).toEqual(["c", "g", "r", "f"]);
    expect(t.unless).toEqual(["**/*.test.ts"]);
    // `unless` goes to the server: its reach and queue read what a target exempts as the CLI does.
    expect(Object.keys(publishableTarget(t)).sort()).toEqual(["command", "live", "name", "paths", "policy", "runs", "ship_stage", "unless"]);
    expect(() => parse([{ name: "cli", run: "x", gate: 3 }])).toThrow("'gate' must be a string");
    expect(() => parse([{ name: "cli", run: "x", unless: [3] }])).toThrow("'unless' must be a string or a list of strings");
    // Braces would match nothing (a missed deploy), so the file is refused, naming the target and the key.
    expect(() => parse([{ name: "web", runs: "push", when: ["packages/{web,shared}/**"] }])).toThrow(`target web: 'when' glob "packages/{web,shared}/**" uses braces`);
    expect(() => parse([{ name: "cli", run: "x", when: "cli/**", unless: "**/*.{test,spec}.ts" }])).toThrow("target cli: 'unless' glob");
  });
});

describe("a release's own version bump (isLiveVersionBump)", () => {
  const cli = { name: "cli", paths: ["packages/cli/**", "packages/shared/**"], unless: ["**/*.test.ts"] };
  const desktop = { name: "desktop", paths: ["packages/electron/**"], unless: ["**/*.test.ts"] };

  test("the bump the release workflow commits after its cut, for the version live now, is carried", () => {
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/cli/package.json"] }, "1.1.323")).toBe(true);
    // The desktop bump also rewrites the web server's download link: that file ships to web, not desktop.
    expect(isLiveVersionBump(desktop, { subject: "chore(electron): bump desktop to v1.1.134", files: ["packages/electron/package.json", "packages/web/server/index.ts"] }, "v1.1.134")).toBe(true);
  });

  test("a release that names the target bumps the target's own package, the one its paths name first (8c2272f)", () => {
    const bump = { subject: "chore(desktop): bump version to 1.1.135", files: ["packages/electron/package.json", "packages/web/server/index.ts"] };
    expect(isLiveVersionBump(desktop, bump, "1.1.135")).toBe(true);
    expect(isLiveVersionBump(desktop, bump, "1.1.134")).toBe(false);
    expect(isLiveVersionBump(desktop, { ...bump, files: ["packages/electron/package.json", "packages/electron/main.js"] }, "1.1.135")).toBe(false);
    // Another target's release, and a target whose first path is no whole package, name no package of this target's.
    expect(isLiveVersionBump(desktop, { ...bump, subject: "chore(mobile): bump version to 1.1.135" }, "1.1.135")).toBe(false);
    expect(isLiveVersionBump({ ...desktop, paths: ["packages/electron/*.json"] }, bump, "1.1.135")).toBe(false);
    // A target's other packages stay work: cli's shared manifest under a cli release.
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/shared/package.json"] }, "1.1.323")).toBe(false);
  });

  test("anything else is work: another version, code beside the bump, no live version, a dependency bump", () => {
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.324", files: ["packages/cli/package.json"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/cli/package.json", "packages/cli/src/a.ts"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/cli/package.json"] }, null)).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore(deps): bump zod from 1.1.0 to 1.1.323", files: ["packages/cli/package.json"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "fix(cli): read 1.1.323 config", files: ["packages/cli/package.json"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: [] }, "1.1.323")).toBe(false);
    // Only the package the release bumps: another manifest under the target's paths is a dependency change it ships.
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/cli/package.json", "packages/shared/package.json"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore(cli): bump version to 1.1.323", files: ["packages/shared/package.json"] }, "1.1.323")).toBe(false);
    expect(isLiveVersionBump(cli, { subject: "chore: bump version to 1.1.323", files: ["packages/cli/package.json"] }, "1.1.323")).toBe(false);
  });
});
