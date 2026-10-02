import { describe, expect, test } from "bun:test";
import { commit, MIN, T0 } from "./__fixtures__/commit";
import days from "./__fixtures__/codecastDays.json";
import { buildLayerZero, type LayerZeroInput } from "./cluster";
import type { ChangeCommit, LayerZeroStory, VisibleConversation } from "./types";

const REPO = "codecast-sh/codecast";
const day = (d: string) => (days as unknown as Record<string, ChangeCommit[]>)[d];
const sessionsOf = (cs: readonly ChangeCommit[]): VisibleConversation[] =>
  [...new Set(cs.map((c) => c.conversation_id).filter((id): id is string => !!id))].map((conversation_id) => ({ conversation_id }));
const build = (over: Partial<LayerZeroInput> & Pick<LayerZeroInput, "commits">) =>
  buildLayerZero({ team_id: "team1", repository: REPO, date: "2026-10-02", visible: [], ...over });
const holding = (stories: LayerZeroStory[], sha: string) => stories.filter((s) => s.commit_shas.includes(sha));

/** The commit-everything session on 10-02 (14 topical commits) and the one that wrote the Codex Cloud fixtures. */
const COMMITTER = "jx7bptrwftzn5n82mbhxtm02ks8fg9ra";
const FIXTURES = "jx778f85yqqw98xjyxyym30s1s8favmm";

describe("the 2026-10-02 codecast day", () => {
  const commits = day("2026-10-02");
  const r = build({ commits, visible: sessionsOf(commits) });

  test("rebase twins collapse onto the main copy", () => {
    expect(r.twins).toEqual({ ca172db32: ["c0e2a7aed"], "3d5b5984f": ["830683c2f"] });
    const all = r.stories.flatMap((s) => s.commit_shas).concat(r.bursts.flatMap((b) => b.shas));
    expect(all).not.toContain("c0e2a7aed");
    expect(all).not.toContain("830683c2f");
  });

  test("the three release commits form one burst with the restamp folded in", () => {
    expect(r.bursts).toHaveLength(1);
    expect([...r.bursts[0].shas].sort()).toEqual(["3d5b5984f", "ca172db32", "f692b70ca"]);
    expect(r.bursts[0].releases.map((x) => `${x.surface} ${x.version}`)).toEqual(["desktop 1.1.123", "cli 1.1.163"]);
    expect(r.stories.flatMap((s) => s.commit_shas)).not.toContain("3d5b5984f");
  });

  test("the 5-area ci commit splits by area and its unclaimed slices stay together", () => {
    const [s] = holding(r.stories, "e7d2da040");
    expect(holding(r.stories, "e7d2da040")).toHaveLength(1);
    expect(s.whole_shas).toEqual([]);
    expect(Object.keys(s.area_counts).sort()).toEqual(["codecast", "github", "plans", "root", "scripts"]);
    expect(s.area).toBe("scripts");
    expect(s.headline).toBe("Workflow, changed path scope and check config");
    expect(s.dek).toBe("8 files across scripts, github, codecast, plans, root");
    expect(s.importance).toBe(1);
    // A slice never carries the session that made the batch commit.
    expect(s.conversation_ids).toEqual([]);
  });

  test("a session committing the whole tree does not fuse the day into one story", () => {
    expect(r.stories).toHaveLength(13);
    const web = holding(r.stories, "0de614861")[0];
    expect(web.commit_shas).toEqual(["0de614861"]);
    expect(web.area).toBe("web");
    expect(web.headline).toBe("Line pages, share pages, org staffing and app updates");
    expect(web.conversation_ids).toEqual([COMMITTER]);
    expect(holding(r.stories, "926be8efb")[0].commit_shas).toEqual(["926be8efb"]);
  });

  test("a single-intent session anchors its own story", () => {
    const [s] = holding(r.stories, "3250f11ca");
    expect(s.anchor).toBe(FIXTURES);
    expect(s.kind).toBe("test");
    expect(s.area).toBe("cli");
  });

  test("stories ship in the first covering release after their last commit", () => {
    const rel = (sha: string) => {
      const x = holding(r.stories, sha)[0].release;
      return x ? `${x.surface} ${x.version}` : null;
    };
    expect(rel("0de614861")).toBe("desktop 1.1.123");
    expect(rel("926be8efb")).toBe("cli 1.1.163");
    expect(rel("f44387928")).toBe("desktop 1.1.123");
    expect(rel("65c80e05c")).toBeNull();
    expect(rel("3250f11ca")).toBeNull();
  });

  test("risks: the convex schema touch, and no bulk while a session vouches", () => {
    expect(holding(r.stories, "65c80e05c")[0].risks.map((x) => x.code)).toEqual(["schema"]);
    expect(r.stories.some((s) => s.risks.some((x) => x.code === "bulk"))).toBe(false);
  });

  test("a private committer leaves commit text, no session, and a count", () => {
    const priv = build({ commits, visible: [{ conversation_id: FIXTURES }] });
    expect(priv.private_conversation_count).toBe(1);
    expect(priv.visible_conversation_ids).toEqual([FIXTURES]);
    const web = holding(priv.stories, "0de614861")[0];
    expect(web.conversation_ids).toEqual([]);
    expect(web.private_conversation_count).toBe(1);
    expect(web.headline).toBe("Line pages, share pages, org staffing and app updates");
    expect(web.risks.map((x) => x.code)).toEqual(["bulk"]);
    expect(priv.stories.flatMap((s) => s.conversation_ids)).not.toContain(COMMITTER);
  });

  test("keys are stable across reruns and when a late commit joins", () => {
    const again = build({ commits: [...commits].reverse(), visible: sessionsOf(commits) });
    expect(again.stories.map((s) => s.story_key)).toEqual(r.stories.map((s) => s.story_key));
    const cliKey = holding(r.stories, "926be8efb")[0].story_key;
    const late = commit({ sha: "late1", subject: "fix(cli): wake retries", timestamp: Date.UTC(2026, 9, 2, 17, 0), paths: { "packages/cli/src/wake.ts": 12 } });
    const withLate = build({ commits: [...commits, late], visible: sessionsOf(commits) });
    const s = holding(withLate.stories, "late1")[0];
    expect(s.story_key).toBe(cliKey);
    expect(s.commit_shas).toEqual(["926be8efb", "late1"]);
    expect(s.dek).toBe("Wake retries");
  });
});

describe("the 2026-10-01 codecast day", () => {
  const commits = day("2026-10-01");
  const r = build({ commits, visible: sessionsOf(commits), date: "2026-10-01" });

  test("two bursts, restamps folded into the cli one", () => {
    expect(r.bursts.map((b) => [...b.shas].sort())).toEqual([["2bb06540a", "39acc4396", "b3d486bce"], ["b47af5aaa"]]);
  });

  test("one session's fix and test form one story; a sessionless fix stands alone", () => {
    expect(holding(r.stories, "955c2cb1d")[0].commit_shas).toEqual(["955c2cb1d", "07017d24f"]);
    const jason = holding(r.stories, "79bf51995")[0];
    expect(jason.commit_shas).toEqual(["79bf51995"]);
    expect(jason.dek.startsWith("An older install wrote")).toBe(true);
    expect(r.stories).toHaveLength(2);
  });

  test("the next day's release carries a story still waiting", () => {
    const next = build({ commits, visible: sessionsOf(commits), date: "2026-10-01", ships: build({ commits: day("2026-10-02") }).ships });
    expect(holding(next.stories, "79bf51995")[0].release?.version).toBe("1.1.163");
  });
});

describe("rules (a) to (c) in isolation", () => {
  const batch = day("2026-09-30")[0];

  test("slices of the 09-30 batch commit join the stories of their areas", () => {
    const cli = commit({ sha: "cli1", subject: "fix(cli): x", timestamp: batch.timestamp - 60 * MIN, paths: { "packages/cli/src/a.ts": 10 } });
    const convex = commit({ sha: "cvx1", subject: "feat(convex): y", timestamp: batch.timestamp + 30 * MIN, conversation_id: "jx7s", paths: { "packages/convex/convex/y.ts": 10 } });
    const r = build({ commits: [batch, cli, convex], visible: [{ conversation_id: "jx7s" }] });
    expect(holding(r.stories, "9dddac2af")).toHaveLength(3);
    const cliStory = holding(r.stories, "cli1")[0];
    expect(cliStory.commit_shas).toEqual(["cli1", "9dddac2af"]);
    expect(cliStory.whole_shas).toEqual(["cli1"]);
    expect(Object.keys(cliStory.area_counts)).toEqual(["cli"]);
    const cvx = holding(r.stories, "cvx1")[0];
    expect(cvx.anchor).toBe("jx7s");
    // The batch commit's convex slice carries its schema path; the cli slice does not.
    expect(cvx.risks.map((x) => x.code)).toEqual(["schema"]);
    expect(cliStory.risks).toEqual([]);
    const rest = r.stories.find((s) => s.commit_shas.includes("9dddac2af") && !s.whole_shas.length && s !== cliStory && s !== cvx)!;
    expect(Object.keys(rest.area_counts).sort()).toEqual(["animation-plans", "docs", "shared"]);
  });

  test("sessions sharing a task merge; the earlier session anchors", () => {
    const a = commit({ sha: "a", conversation_id: "s1", timestamp: T0, paths: { "packages/web/a.ts": 5 } });
    const b = commit({ sha: "b", conversation_id: "s2", timestamp: T0 + MIN, paths: { "packages/convex/b.ts": 5 } });
    const r = build({ commits: [b, a], visible: [{ conversation_id: "s1", task_ids: ["ct1"] }, { conversation_id: "s2", task_ids: ["ct1"] }] });
    expect(r.stories).toHaveLength(1);
    expect(r.stories[0].anchor).toBe("s1");
    expect(r.stories[0].conversation_ids).toEqual(["s1", "s2"]);
    expect(r.stories[0].task_ids).toEqual(["ct1"]);
  });

  test("rule (b) breaks on a 3 hour gap and on scope; a branch groups whole", () => {
    const cs = [
      commit({ sha: "m1", subject: "fix(cli): a", timestamp: T0, paths: { "packages/cli/a.ts": 1 } }),
      commit({ sha: "m2", subject: "fix(cli): b", timestamp: T0 + 170 * MIN, paths: { "packages/cli/a.ts": 1 } }),
      commit({ sha: "m3", subject: "fix(cli): c", timestamp: T0 + 360 * MIN, paths: { "packages/cli/a.ts": 1 } }),
      commit({ sha: "m4", subject: "fix(auth): d", timestamp: T0 + MIN, paths: { "packages/cli/a.ts": 1 } }),
      commit({ sha: "b1", branch: "feat/x", timestamp: T0, paths: { "packages/web/a.ts": 9 } }),
      commit({ sha: "b2", branch: "feat/x", timestamp: T0 + MIN, paths: { "packages/convex/a.ts": 1, "packages/web/b.ts": 1, "docs/a.md": 1 } }),
    ];
    const r = build({ commits: cs });
    expect(r.stories.map((s) => s.commit_shas.join(",")).sort()).toEqual(["b1,b2", "m1,m2", "m3", "m4"]);
    const branch = holding(r.stories, "b1")[0];
    expect(branch.on_default_branch).toBe(false);
    expect(branch.branch).toBe("feat/x");
    expect(branch.area).toBe("web");
    expect(branch.release).toBeNull();
    expect(holding(r.stories, "m4")[0].scope).toBe("auth");
  });

  test("PRs join by commit or by visible session", () => {
    const a = commit({ sha: "a", conversation_id: "s1", paths: { "packages/web/a.ts": 5 } });
    const b = commit({ sha: "b", subject: "fix(cli): b", pr_id: "pr9", paths: { "packages/cli/a.ts": 5 } });
    const r = build({ commits: [a, b], visible: [{ conversation_id: "s1" }], prs: [{ id: "pr1", conversation_ids: ["s1"] }, { id: "pr2", shas: ["b"] }, { id: "pr3", conversation_ids: ["private"] }] });
    expect(holding(r.stories, "a")[0].pr_ids).toEqual(["pr1"]);
    expect(holding(r.stories, "b")[0].pr_ids).toEqual(["pr2", "pr9"]);
  });
});

/** A Littlebird-shaped day: 760 commits, 45 branches, sparse sessions, a few batch commits and twins. */
function littlebirdDay(): ChangeCommit[] {
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const dirs = ["backend/api", "backend/worker", "backend/db", "backend/auth", "apps/web", "apps/mobile", "apps/admin", "packages/ui", "packages/sdk", "infra"];
  const types = ["feat", "fix", "chore", "refactor", "test", "docs", "perf"];
  const branches = Array.from({ length: 45 }, (_, i) => `dev${i % 9}/topic-${i}`);
  const out: ChangeCommit[] = [];
  for (let i = 0; i < 760; i++) {
    const main = i % 10 === 0;
    const batch = rnd() < 0.05;
    const dir = pick(dirs);
    const paths: Record<string, number> = {};
    const n = 1 + Math.floor(rnd() * 30);
    for (let f = 0; f < n; f++) paths[`${batch ? pick(dirs) : dir}/src/f${Math.floor(rnd() * 400)}.ts`] = Math.floor(rnd() * 120);
    const area = dir.split("/").pop();
    out.push(commit({
      sha: `lb${i.toString(16).padStart(6, "0")}`,
      subject: i % 97 === 0 && main ? `chore(release): bump version to 2.${i}.0` : `${pick(types)}(${area}): change ${i}`,
      author_email: `dev${i % 23}@littlebird.test`,
      author_name: `Dev ${i % 23}`,
      timestamp: T0 - 12 * 60 * MIN + Math.floor(rnd() * 24 * 60) * MIN,
      branch: main ? "main" : pick(branches),
      conversation_id: rnd() < 0.015 ? `jx7lb${i % 5}` : null,
      paths,
    }));
  }
  // Rebase twins: some main commits also arrive from the branch they came from.
  for (let i = 0; i < 20; i++) out.push({ ...out[i * 10], sha: `tw${i}`, branch: pick(branches) });
  return out;
}

describe("a Littlebird-shaped day", () => {
  const commits = littlebirdDay();
  const visible = [0, 1, 2, 3, 4].map((i) => ({ conversation_id: `jx7lb${i}` }));

  // CPU time, not wall clock: on a machine at load 500 a trivial 780-row map
  // takes 66ms of wall time, and Convex's cap counts JS execution anyway.
  test("clusters 780 rows in under 200ms of CPU", () => {
    build({ commits, visible });
    const c0 = process.cpuUsage();
    const r = build({ commits, visible });
    const cpu = process.cpuUsage(c0);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(200);
    expect(Object.values(r.twins).flat()).toHaveLength(20);
    expect(r.stories.filter((s) => s.on_default_branch).length).toBeLessThan(120);
  });

  test("every kept commit lands in a burst or a story, and whole commits in exactly one", () => {
    const r = build({ commits, visible });
    const twins = new Set(Object.values(r.twins).flat());
    const burst = new Set(r.bursts.flatMap((b) => b.shas));
    const whole = r.stories.flatMap((s) => s.whole_shas);
    expect(new Set(whole).size).toBe(whole.length);
    const placed = new Set([...burst, ...r.stories.flatMap((s) => s.commit_shas)]);
    for (const c of commits) if (!twins.has(c.sha)) expect(placed.has(c.sha)).toBe(true);
    expect(new Set(r.stories.map((s) => s.story_key)).size).toBe(r.stories.length);
  });
});
