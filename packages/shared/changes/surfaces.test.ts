import { describe, expect, test } from "bun:test";
import { commit, MIN, T0 } from "./__fixtures__/commit";
import { dedupeCommits, resolveDefaultBranch } from "./dedupe";
import { computeRisks } from "./risks";
import { assignRelease, detectSurfaces, latestShips, releaseBursts, surfaceCoversArea, waitingStories } from "./surfaces";
import type { ShipEvent } from "./types";

describe("dedupe", () => {
  test("the default branch copy wins, then the newest row", () => {
    const a = commit({ sha: "a1", subject: "fix: x", branch: "feature/x", created_at: 5 });
    const b = commit({ sha: "b1", subject: "fix: x", branch: "main", created_at: 1 });
    const c = commit({ sha: "c1", subject: "fix: y", branch: null, created_at: 1 });
    const d = commit({ sha: "d1", subject: "fix: y", branch: null, created_at: 2 });
    const r = dedupeCommits([a, b, c, d], "main");
    expect(r.commits.map((x) => x.sha)).toEqual(["b1", "d1"]);
    expect(r.twins).toEqual({ b1: ["a1"], d1: ["c1"] });
  });

  test("a different author time or subject is not a twin", () => {
    const r = dedupeCommits([commit({ sha: "a" }), commit({ sha: "b", timestamp: T0 + 1 }), commit({ sha: "c", subject: "fix: z" })], "main");
    expect(r.commits).toHaveLength(3);
  });

  test("default branch resolution", () => {
    expect(resolveDefaultBranch("trunk", ["main"])).toBe("trunk");
    expect(resolveDefaultBranch(null, ["feature", "master"])).toBe("master");
    expect(resolveDefaultBranch(undefined, [null])).toBe("main");
  });
});

describe("surfaces", () => {
  test("path map covers areas; an unmapped surface covers all", () => {
    expect(surfaceCoversArea("cli", "shared")).toBe(true);
    expect(surfaceCoversArea("desktop", "web")).toBe(true);
    expect(surfaceCoversArea("backend", "web")).toBe(false);
    expect(surfaceCoversArea("extension", "browser-extension")).toBe(true);
    expect(surfaceCoversArea("release", "anything")).toBe(true);
  });

  test("bursts chain releases within 10 minutes and fold the nearest restamp", () => {
    const cs = [
      commit({ sha: "r1", subject: "chore(electron): release desktop 1.1.123", timestamp: T0 }),
      commit({ sha: "s1", subject: "chore(cli): restamp daemon build id", timestamp: T0 + 2 * MIN }),
      commit({ sha: "r2", subject: "chore(cli): bump version to 1.1.163", timestamp: T0 + 9 * MIN }),
      commit({ sha: "r3", subject: "chore(cli): bump version to 1.1.164", timestamp: T0 + 40 * MIN }),
      commit({ sha: "s2", subject: "chore(cli): restamp daemon build id", timestamp: T0 + 80 * MIN }),
      commit({ sha: "r4", subject: "chore(cli): bump version to 9.9.9", timestamp: T0, branch: "next" }),
    ];
    const { bursts, absorbed } = releaseBursts(cs, "main");
    expect(bursts.map((b) => b.shas)).toEqual([["r1", "r2", "s1"], ["r3"]]);
    expect(bursts[0].releases.map((r) => `${r.surface} ${r.version}`)).toEqual(["desktop 1.1.123", "cli 1.1.163"]);
    expect(absorbed.has("s2")).toBe(false);
    expect(absorbed.has("r4")).toBe(false);
  });

  const ships: ShipEvent[] = [
    { surface: "cli", version: "1.1.163", sha: "r2", at: T0 + 60 * MIN, kind: "release" },
    { surface: "desktop", version: "1.1.123", sha: "r1", at: T0 + 30 * MIN, kind: "release" },
    { surface: "backend", sha: "d1", at: T0 + 90 * MIN, kind: "deploy" },
  ];

  test("a story ships in the first covering release after its last commit", () => {
    expect(assignRelease("shared", T0, ships)?.surface).toBe("desktop");
    expect(assignRelease("cli", T0, ships)?.version).toBe("1.1.163");
    expect(assignRelease("cli", T0 + 61 * MIN, ships)).toBeNull();
    expect(assignRelease("mobile", T0, ships)).toBeNull();
  });

  test("detection, latest ship and waiting stories", () => {
    expect(detectSurfaces(ships, T0 + 45 * MIN)).toEqual(["backend", "cli"]);
    expect(latestShips([...ships, { ...ships[0], version: "1.1.164", at: T0 + 99 * MIN }]).cli.version).toBe("1.1.164");
    const stories = [
      { area: "cli", last_at: T0 + 70 * MIN, on_default_branch: true },
      { area: "cli", last_at: T0 + 10 * MIN, on_default_branch: true },
      { area: "cli", last_at: T0 + 70 * MIN, on_default_branch: false },
      { area: "web", last_at: T0 + 70 * MIN, on_default_branch: true },
    ];
    expect(waitingStories(stories, ships[0])).toEqual([stories[0]]);
  });
});

describe("risks", () => {
  const base = { insertions: 0, deletions: 0, conversations: [], pr_ids: [], task_ids: [] };

  test("schema reads only the slice's own area", () => {
    const c = commit({ sha: "a", paths: { "packages/convex/convex/schema.ts": 3, "packages/web/x.ts": 1, "docs/a.md": 1 } });
    expect(computeRisks({ ...base, units: [{ commit: c, area: null }] }, { ships: [] })).toEqual([{ code: "schema", evidence: ["packages/convex/convex/schema.ts"] }]);
    expect(computeRisks({ ...base, units: [{ commit: c, area: "web" }] }, { ships: [] })).toEqual([]);
  });

  test("revert, bulk and blocked", () => {
    const r = commit({ sha: "r", subject: 'Revert "feat: x"' });
    const risks = computeRisks(
      { ...base, units: [{ commit: r, area: null }], insertions: 1400, deletions: 200 },
      { ships: [] },
    ).map((x) => x.code);
    expect(risks).toEqual(["revert", "bulk"]);
    const blocked = computeRisks(
      { ...base, units: [{ commit: r, area: null }], insertions: 2000, conversations: [{ conversation_id: "jx7b", outcome_type: "blocked" }] },
      { ships: [] },
    );
    expect(blocked.map((x) => x.code)).toEqual(["revert", "blocked"]);
  });

  test("skew needs a backend deploy marker and a newer web ship", () => {
    const c = commit({ sha: "b", timestamp: T0 + 10 * MIN, paths: { "packages/convex/convex/x.ts": 5 } });
    const story = { ...base, units: [{ commit: c, area: null }] };
    const deploy: ShipEvent = { surface: "backend", sha: "d", at: T0, kind: "deploy" };
    const web: ShipEvent = { surface: "desktop", version: "1.1.123", sha: "w", at: T0 + 20 * MIN, kind: "release" };
    expect(computeRisks(story, { ships: [web] })).toEqual([]);
    expect(computeRisks(story, { ships: [deploy] })).toEqual([]);
    const [sk] = computeRisks(story, { ships: [deploy, web] });
    expect(sk.code).toBe("skew");
    expect(sk.evidence[0]).toBe("b");
    expect(computeRisks(story, { ships: [{ ...deploy, at: T0 + 15 * MIN }, web] })).toEqual([]);
  });
});
