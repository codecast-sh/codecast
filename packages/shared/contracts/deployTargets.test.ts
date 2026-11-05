import { describe, expect, test } from "bun:test";
import { commitCiState, commitTouchesTarget, DeployTargetError, groupQueueBySession, parseLiveReader, readJsonLive, parseDeployTargetEntries, parseDeployTargets, targetFromLineDeploy, type QueueCommit } from "./deployTargets";

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
    expect(() => parseDeployTargets({ target: [{ name: "x", run: "a", colour: "red" }] }, SHIP)).toThrow(/unknown key 'colour'/);
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
    expect(commitTouchesTarget(["packages/convex/**"], ["packages/convex/convex/a.ts"])).toBe(true);
    expect(commitTouchesTarget(["packages/convex/**"], ["packages/web/a.ts"])).toBe(false);
    expect(commitTouchesTarget(["packages/convex/**"], null)).toBe(true);
    expect(commitTouchesTarget([], ["anything"])).toBe(true);
  });

  test("a commit's CI: red beats running beats green; a cancelled run says nothing; the newest run of a workflow speaks", () => {
    expect(commitCiState([])).toBe("none");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "success", at: 1 }, { name: "Lint", status: "in_progress", at: 1 }])).toBe("running");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "failure", at: 1 }, { name: "Lint", status: "in_progress", at: 1 }])).toBe("failed");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "failure", at: 1 }, { name: "CI", status: "completed", conclusion: "success", at: 2 }])).toBe("passed");
    expect(commitCiState([{ name: "CI", status: "completed", conclusion: "cancelled", at: 1 }])).toBe("none");
  });

  test("the queue groups by session, the newest session's work first, commits no session claims last", () => {
    const c = (sha: string, at: number, conv: string | null, ci: QueueCommit["ci"]): QueueCommit => ({ sha, subject: sha, at, author: null, session: conv ? { conversation_id: conv, short_id: conv.slice(0, 7), title: conv } : null, tasks: [], ci, ci_url: null });
    const groups = groupQueueBySession([c("a", 1, "s1", "passed"), c("b", 2, null, "passed"), c("c", 3, "s2", "running"), c("d", 4, "s1", "failed")]);
    expect(groups.map((g) => [g.key, g.commits.map((x) => x.sha), g.ci])).toEqual([["s:s1", ["d", "a"], "failed"], ["s:s2", ["c"], "running"], ["none", ["b"], "passed"]]);
  });
});
