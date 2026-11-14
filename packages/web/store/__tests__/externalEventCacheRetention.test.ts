import { describe, it, expect } from "bun:test";
import {
  COLLECTION_RETENTION,
  EXTERNAL_EVENT_OUTCOME_TTL_MS,
  MAX_CACHED_EXTERNAL_EVENTS,
  partitionExternalEventRetention,
} from "../cacheRetention";
import { indexOutcomes, prThreads } from "../../components/activity/activityModel";
import { PR_STATE_OF_KIND } from "../../lib/externalEventOutcomes";
import { deleteInBatches, RETENTION_DELETE_BATCH } from "../idbCache";

// Hydration-time retention for the persisted externalEvents collection. The
// team feeder shows the newest 200 events and the key is a delta overlay, so
// without this pass the cache keeps every event that ever passed through the
// window (153,681 rows on 2026-11-14). Three readers have no feeder beyond
// that window, so the pass may drop only what none of them reads. See
// partitionExternalEventRetention.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = 1_800_000_000_000;
const cid = (n: number) => `e${String(n).padStart(31, "0")}`; // 32-char convex-shaped id
const conv = (n: number) => `c${String(n).padStart(31, "0")}`;

let nextId = 0;
function row(over: Record<string, any> = {}) {
  return { _id: cid(nextId++), kind: "pr_check", team_id: "t1", repository: "acme/app", created_at: NOW - MINUTE, ...over };
}

// A busy team's cache: far more rows than the newest window, most of them the
// noise a PR generates, with sessions' own commits, pushes and PR ties spread
// through the whole horizon.
function busyTeam(total = MAX_CACHED_EXTERNAL_EVENTS * 4) {
  const rows: any[] = [];
  for (let i = 0; i < total; i++) {
    const at = NOW - i * 5 * MINUTE; // newest first, 5 minutes apart: 8,000 rows is about 28 days
    // PRs and sessions come and go with time (a new set every two weeks or so),
    // and every third one is long-lived, so a longer span holds finished work,
    // live work, and work that runs across the horizon.
    const era = Math.floor(i / 4000);
    const pr = i % 3 === 0 ? 1 + (i % 31) : 1000 * (era + 1) + (i % 97);
    const session = i % 11 === 0 ? (i % 2 === 0 ? conv(i % 17) : conv(1000 * (era + 1) + (i % 53))) : undefined;
    const kinds = ["pr_check", "pr_edited", "pr_synchronize", "pr_review", "commit", "push", "pr_opened", "pr_merged", "pr_closed", "pr_behind"];
    const kind = kinds[i % kinds.length];
    const onPr = kind.startsWith("pr_");
    rows.push(row({
      kind,
      created_at: at,
      pr_number: onPr ? pr : undefined,
      conversation_id: session,
      sha: kind === "commit" ? `sha${i}` : undefined,
      meta: kind === "push" ? { commits_count: 1 + (i % 3) } : undefined,
      title: onPr ? `PR ${pr} at ${i}` : undefined,
      actor_login: `dev${i % 7}`,
    }));
  }
  return rows;
}

const newestFirst = (rows: any[]) => [...rows].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

function activityAnswer(rows: any[]) {
  const events = newestFirst(rows);
  const prs = prThreads(events);
  const outcomes = indexOutcomes({ events, prs, tasks: [], decisions: [], viewerId: null });
  return {
    prs: [...prs.values()].map((p) => ({ ...p, convIds: [...p.convIds].sort() })).sort((a, b) => a.key.localeCompare(b.key)),
    outcomes: [...outcomes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

describe("partitionExternalEventRetention", () => {
  it("keeps everything while the cache is under one team's window, however old", () => {
    const rows = [row(), row({ created_at: NOW - 400 * DAY })];
    const { keep, drop } = partitionExternalEventRetention(rows, NOW);
    expect(keep.length).toBe(2);
    expect(drop).toEqual([]);
  });

  it("sheds most of a busy team's cache", () => {
    const rows = busyTeam();
    const { keep, drop } = partitionExternalEventRetention(rows, NOW);
    expect(keep.length + drop.length).toBe(rows.length);
    expect(drop.length).toBeGreaterThan(rows.length / 3);
    expect(new Set(drop).size).toBe(drop.length);
  });

  it("the Activity page derives the same PRs and the same session outcomes after the pass", () => {
    const rows = busyTeam();
    const { keep, drop } = partitionExternalEventRetention(rows, NOW);
    expect(drop.length).toBeGreaterThan(0);
    expect(activityAnswer(keep)).toEqual(activityAnswer(rows));
  });

  it("across the horizon, every PR and session it keeps reads exactly as before, and what it drops had nothing live", () => {
    // Ten weeks of the same traffic: PRs and sessions on both sides of the line and across it.
    const rows = busyTeam(MAX_CACHED_EXTERNAL_EVENTS * 10);
    const { keep, drop } = partitionExternalEventRetention(rows, NOW);
    expect(drop.length).toBeGreaterThan(rows.length / 2);
    const before = activityAnswer(rows);
    const after = activityAnswer(keep);
    const prsBefore = new Map(before.prs.map((p) => [p.key, p]));
    const sessionsBefore = new Map(before.outcomes);
    expect(after.prs.length).toBeGreaterThan(0);
    for (const pr of after.prs) expect(pr).toEqual(prsBefore.get(pr.key)!);
    for (const [id, outcomes] of after.outcomes) expect(outcomes).toEqual(sessionsBefore.get(id)!);
    // Whatever is gone had no event inside the horizon: it went whole, not in part.
    const horizon = NOW - EXTERNAL_EVENT_OUTCOME_TTL_MS;
    const keptPrs = new Set(after.prs.map((p) => p.key));
    const keptSessions = new Set(after.outcomes.map(([id]) => id));
    for (const r of rows) {
      if ((r.created_at ?? 0) < horizon) continue;
      if (r.pr_number !== undefined) expect(keptPrs.has(`${r.repository}#${r.pr_number}`)).toBe(true);
      if (r.conversation_id && (r.kind === "commit" || r.kind === "push" || r.pr_number !== undefined)) expect(keptSessions.has(r.conversation_id)).toBe(true);
    }
  });

  it("keeps the newest MAX rows of each team, whatever their kind", () => {
    const quiet = Array.from({ length: 50 }, (_, i) => row({ team_id: "quiet", created_at: NOW - 20 * DAY - i * MINUTE, pr_number: undefined, kind: "release" }));
    const busy = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 300 }, (_, i) => row({ team_id: "busy", created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
    const { keep, drop } = partitionExternalEventRetention([...quiet, ...busy], NOW);
    const kept = new Set(keep.map((r) => r._id));
    // A quiet team's window is its own: a busy team never pushes it out.
    for (const r of quiet) expect(kept.has(r._id)).toBe(true);
    expect(busy.slice(0, MAX_CACHED_EXTERNAL_EVENTS).every((r) => kept.has(r._id))).toBe(true);
    // Past its own window the busy team's rows go: nothing else reads these.
    expect(drop.length).toBe(300);
  });

  it("keeps each repository's last event at any age (the Repositories list)", () => {
    const filler = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 10 }, (_, i) => row({ created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
    const lastOfOldRepo = row({ repository: "acme/archive", kind: "release", pr_number: undefined, created_at: NOW - 300 * DAY });
    const earlierOfOldRepo = row({ repository: "acme/archive", kind: "release", pr_number: undefined, created_at: NOW - 301 * DAY });
    const { keep, drop } = partitionExternalEventRetention([...filler, lastOfOldRepo, earlierOfOldRepo], NOW);
    expect(keep.some((r) => r._id === lastOfOldRepo._id)).toBe(true);
    expect(drop).toContain(earlierOfOldRepo._id);
  });

  const filler = () => Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 10 }, (_, i) => row({ created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
  const INSIDE = NOW - EXTERNAL_EVENT_OUTCOME_TTL_MS + DAY;
  const OUTSIDE = NOW - EXTERNAL_EVENT_OUTCOME_TTL_MS - DAY;
  const commit = (session: string, sha: string, at: number) => row({ kind: "commit", pr_number: undefined, conversation_id: session, sha, created_at: at });

  it("a session that committed on both sides of the horizon keeps every commit", () => {
    const old = Array.from({ length: 20 }, (_, i) => commit(conv(1), `old${i}`, OUTSIDE - i * DAY));
    const recent = Array.from({ length: 5 }, (_, i) => commit(conv(1), `new${i}`, INSIDE + i * MINUTE));
    const rows = [...filler(), ...old, ...recent];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    const count = (r: any[]) => new Map(activityAnswer(r).outcomes).get(conv(1))!.commits;
    expect(count(rows)).toBe(25);
    expect(count(keep)).toBe(25);
  });

  it("a PR merged before the horizon and touched since still reads merged, with its title", () => {
    const rows = [
      ...filler(),
      row({ kind: "pr_opened", pr_number: 7, title: "Ship it", created_at: OUTSIDE - 5 * DAY }),
      row({ kind: "pr_merged", pr_number: 7, title: "Ship it", created_at: OUTSIDE - DAY }),
      row({ kind: "pr_review_comment", pr_number: 7, conversation_id: conv(2), created_at: INSIDE }),
    ];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    const pr = (r: any[]) => activityAnswer(r).prs.find((p) => p.number === 7)!;
    expect(pr(keep).label).toBe("merged");
    expect(pr(keep).title).toBe("Ship it");
    expect(pr(keep)).toEqual(pr(rows));
  });

  it("a draft opened before the horizon and still checked today reads draft", () => {
    const rows = [
      ...filler(),
      row({ kind: "pr_draft", pr_number: 8, title: "Long draft", created_at: OUTSIDE - 40 * DAY }),
      row({ kind: "pr_check", pr_number: 8, created_at: INSIDE }),
    ];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    const pr = (r: any[]) => activityAnswer(r).prs.find((p) => p.number === 8)!;
    expect(pr(keep).label).toBe("draft");
    expect(pr(keep)).toEqual(pr(rows));
  });

  it("live spreads along ties: a live session's old PR and a live PR's old session both stay whole", () => {
    const rows = [
      ...filler(),
      // An old PR whose only recent trace is its session committing elsewhere.
      row({ kind: "pr_merged", pr_number: 9, title: "Old PR", created_at: OUTSIDE - 3 * DAY }),
      row({ kind: "pr_synchronize", pr_number: 9, conversation_id: conv(3), created_at: OUTSIDE - 4 * DAY }),
      commit(conv(3), "recent", INSIDE),
      // An old session whose PR someone else reviewed yesterday.
      commit(conv(4), "a", OUTSIDE - 2 * DAY),
      commit(conv(4), "b", OUTSIDE - 3 * DAY),
      row({ kind: "pr_opened", pr_number: 10, title: "Reviewed late", conversation_id: conv(4), created_at: OUTSIDE - 2 * DAY }),
      row({ kind: "pr_review", pr_number: 10, created_at: INSIDE }),
    ];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    expect(activityAnswer(keep)).toEqual(activityAnswer(rows));
  });

  it("a PR and a session with nothing inside the horizon go whole", () => {
    const dead = [
      row({ kind: "pr_opened", pr_number: 11, title: "Long gone", conversation_id: conv(5), created_at: OUTSIDE - 9 * DAY }),
      row({ kind: "pr_merged", pr_number: 11, title: "Long gone", created_at: OUTSIDE - 8 * DAY }),
      commit(conv(5), "x", OUTSIDE - 9 * DAY),
    ];
    const { keep, drop } = partitionExternalEventRetention([...filler(), ...dead], NOW);
    for (const r of dead) expect(drop).toContain(r._id);
    const after = activityAnswer(keep);
    expect(after.prs.some((p) => p.number === 11)).toBe(false);
    expect(after.outcomes.some(([id]) => id === conv(5))).toBe(false);
  });

  it("a session whose only recent event is a pull keeps its commits at this start and the next", () => {
    const rows = [
      ...filler(),
      ...Array.from({ length: 20 }, (_, i) => commit(conv(6), `c${i}`, OUTSIDE - (i + 1) * DAY)),
      row({ kind: "pr_opened", pr_number: 13, title: "Before the line", conversation_id: conv(6), created_at: OUTSIDE - 6 * DAY }),
      row({ kind: "pr_merged", pr_number: 13, title: "Before the line", created_at: OUTSIDE - 5 * DAY }),
      row({ kind: "pull", pr_number: undefined, conversation_id: conv(6), created_at: NOW - 3 * DAY }),
    ];
    const first = partitionExternalEventRetention(rows, NOW);
    const second = partitionExternalEventRetention(first.keep, NOW);
    expect(second.drop).toEqual([]);
    const read = (r: any[]) => { const a = activityAnswer(r); return { session: new Map(a.outcomes).get(conv(6)), pr: a.prs.find((p) => p.number === 13) }; };
    expect(read(rows).session!.commits).toBe(20);
    expect(read(first.keep)).toEqual(read(rows));
    expect(read(second.keep)).toEqual(read(rows));
  });

  it("a second start over the first start's output drops nothing, on random caches", () => {
    // A small seeded generator: the same caches every run.
    let seed = 20261114;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const kinds = ["pr_check", "pr_edited", "pr_synchronize", "pr_review", "pr_review_comment", "pr_behind", "pr_opened", "pr_draft", "pr_ready_for_review", "pr_merged", "pr_closed", "commit", "amend", "push", "pull", "checkout", "rebase", "release"];
    for (let cache = 0; cache < 6; cache++) {
      const days = 100 + Math.floor(rnd() * 200);
      const rows = Array.from({ length: 12_000 }, () => {
        const kind = pick(kinds);
        const onPr = kind.startsWith("pr_");
        return row({
          kind,
          team_id: rnd() < 0.9 ? "t1" : "t2",
          repository: rnd() < 0.8 ? "acme/app" : "acme/tools",
          created_at: NOW - Math.floor(rnd() * days * DAY),
          pr_number: onPr ? 1 + Math.floor(rnd() * 400) : undefined,
          // Few sessions are tied to a PR, so many are live by their own events alone.
          conversation_id: rnd() < (onPr ? 0.02 : 0.4) ? conv(Math.floor(rnd() * 900)) : undefined,
          sha: kind === "commit" || kind === "amend" ? `s${Math.floor(rnd() * 1e9)}` : undefined,
          meta: kind === "push" ? { commits_count: 1 + Math.floor(rnd() * 4) } : undefined,
          title: onPr ? `PR title ${Math.floor(rnd() * 1e6)}` : undefined,
          plan_ids: rnd() < 0.01 ? [`plan${Math.floor(rnd() * 6)}`] : undefined,
          project_ids: rnd() < 0.01 ? [`project${Math.floor(rnd() * 3)}`] : undefined,
          task_ids: rnd() < 0.01 ? [`task${Math.floor(rnd() * 8)}`] : undefined,
        });
      });
      const first = partitionExternalEventRetention(rows, NOW);
      expect(first.drop.length).toBeGreaterThan(0);
      const second = partitionExternalEventRetention(first.keep, NOW);
      expect(second.drop).toEqual([]);
      // And what the first start kept reads exactly as it did before it.
      const before = activityAnswer(rows);
      const after = activityAnswer(first.keep);
      const prsBefore = new Map(before.prs.map((p) => [p.key, p]));
      const sessionsBefore = new Map(before.outcomes);
      for (const pr of after.prs) expect(pr).toEqual(prsBefore.get(pr.key)!);
      for (const [id, outcomes] of after.outcomes) expect(outcomes).toEqual(sessionsBefore.get(id)!);
      for (let i = 0; i < 6; i++) expect(planRows(first.keep, `plan${i}`)).toEqual(planRows(rows, `plan${i}`));
      for (let i = 0; i < 3; i++) expect(projectRows(first.keep, `project${i}`)).toEqual(projectRows(rows, `project${i}`));
      for (let i = 0; i < 8; i++) expect(taskRows(first.keep, `task${i}`)).toEqual(taskRows(rows, `task${i}`));
    }
  });

  // The plan panel, the project timeline, the task page and RepositoryLinks
  // read by these fields, and their feeders only filter the team's newest 500.
  const planRows = (r: any[], plan: string) => newestFirst(r).filter((e) => !!e.plan_ids?.includes(plan)).map((e) => e._id);
  const projectRows = (r: any[], project: string) => newestFirst(r).filter((e) => !!e.project_ids?.includes(project)).map((e) => e._id);
  const taskRows = (r: any[], task: string) => newestFirst(r).filter((e) => e.task_id === task || !!e.task_ids?.includes(task)).map((e) => e._id);

  it("a plan's list, a project's timeline and a task's git lines read the same after the pass, at any age", () => {
    const kinds = ["pr_edited", "pr_review_requested", "commit", "pr_check", "push"];
    const linked = Array.from({ length: 300 }, (_, i) => row({
      kind: kinds[i % kinds.length],
      pr_number: kinds[i % kinds.length].startsWith("pr_") ? 500 + (i % 9) : undefined,
      created_at: NOW - (i + 1) * DAY, // most of them far past the horizon
      plan_ids: i % 3 === 0 ? [`plan${i % 4}`] : undefined,
      project_ids: i % 3 === 1 ? [`project${i % 2}`] : undefined,
      task_ids: i % 3 === 2 ? [`task${i % 5}`, `task${(i + 1) % 5}`] : undefined,
    }));
    const rows = [...filler(), ...linked];
    const { keep, drop } = partitionExternalEventRetention(rows, NOW);
    for (let i = 0; i < 4; i++) expect(planRows(keep, `plan${i}`)).toEqual(planRows(rows, `plan${i}`));
    for (let i = 0; i < 2; i++) expect(projectRows(keep, `project${i}`)).toEqual(projectRows(rows, `project${i}`));
    for (let i = 0; i < 5; i++) expect(taskRows(keep, `task${i}`)).toEqual(taskRows(rows, `task${i}`));
    expect(planRows(rows, "plan0").length).toBeGreaterThan(10);
    for (const r of linked) expect(drop).not.toContain(r._id);
    expect(partitionExternalEventRetention(keep, NOW).drop).toEqual([]);
  });

  it("a PR kept only through a plan's row still reads from all its state events", () => {
    const rows = [
      ...filler(),
      row({ kind: "pr_opened", pr_number: 14, title: "Planned work", created_at: OUTSIDE - 20 * DAY }),
      row({ kind: "pr_merged", pr_number: 14, title: "Planned work", created_at: OUTSIDE - 15 * DAY }),
      row({ kind: "pr_edited", pr_number: 14, plan_ids: ["plan9"], created_at: OUTSIDE - 18 * DAY }),
    ];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    const pr = (r: any[]) => activityAnswer(r).prs.find((p) => p.number === 14)!;
    expect(pr(keep).label).toBe("merged");
    expect(pr(keep)).toEqual(pr(rows));
  });

  it("a PR the window rules keep a row of is live: it never reads from that row alone", () => {
    // A quiet team: its newest 2,000 reach back past the horizon, into the middle of an old PR.
    const quiet = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS - 1 }, (_, i) => row({ team_id: "quiet", repository: "acme/quiet", created_at: OUTSIDE - DAY - i * MINUTE, pr_number: undefined, kind: "release" }));
    const lastCheck = row({ team_id: "quiet", repository: "acme/quiet", kind: "pr_check", pr_number: 12, created_at: OUTSIDE - 2 * DAY });
    const merged = row({ team_id: "quiet", repository: "acme/quiet", kind: "pr_merged", pr_number: 12, title: "Quiet PR", created_at: OUTSIDE - 30 * DAY });
    const busy = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 10 }, (_, i) => row({ team_id: "busy", created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
    const rows = [...quiet, lastCheck, merged, ...busy];
    const { keep } = partitionExternalEventRetention(rows, NOW);
    const pr = (r: any[]) => activityAnswer(r).prs.find((p) => p.number === 12)!;
    expect(pr(keep)).toEqual(pr(rows));
    expect(pr(keep).label).toBe("merged");
  });

  it("keeps every kind the model reads a PR's state from", () => {
    const filler = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 10 }, (_, i) => row({ created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
    const states = Object.keys(PR_STATE_OF_KIND).flatMap((kind, i) => [
      row({ kind, pr_number: 7, created_at: NOW - 10 * DAY - i * MINUTE }),
      row({ kind, pr_number: 7, created_at: NOW - 11 * DAY - i * MINUTE }),
    ]);
    const { keep } = partitionExternalEventRetention([...filler, ...states], NOW);
    const kept = new Set(keep.map((r) => r._id));
    for (const s of states) expect(kept.has(s._id)).toBe(true);
  });

  it("never drops a row the server cannot restore (a non-Convex id)", () => {
    const filler = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS + 10 }, (_, i) => row({ created_at: NOW - i * MINUTE, pr_number: undefined, kind: "release" }));
    const stub = row({ _id: "temp_event", kind: "release", pr_number: undefined, created_at: 0 });
    const { keep, drop } = partitionExternalEventRetention([stub, ...filler], NOW);
    expect(keep.some((r) => r._id === "temp_event")).toBe(true);
    expect(drop).not.toContain("temp_event");
  });

  it("orders a row that has no created_at by its creation time", () => {
    const filler = Array.from({ length: MAX_CACHED_EXTERNAL_EVENTS }, (_, i) => row({ created_at: NOW - (i + 10) * MINUTE, pr_number: undefined, kind: "release" }));
    const newestUnstamped = { _id: cid(900_001), team_id: "t1", kind: "release", _creationTime: NOW };
    const oldestUnstamped = { _id: cid(900_002), team_id: "t1", kind: "release", _creationTime: NOW - 400 * DAY };
    const { keep, drop } = partitionExternalEventRetention([...filler, newestUnstamped, oldestUnstamped], NOW);
    expect(keep.some((r) => r._id === newestUnstamped._id)).toBe(true);
    expect(drop).toContain(oldestUnstamped._id);
  });

  it("is the rule every cache engine applies to the externalEvents key at boot", () => {
    expect(COLLECTION_RETENTION.externalEvents).toBe(partitionExternalEventRetention);
  });
});

describe("deleteInBatches", () => {
  it("deletes every id, a batch at a time and in order", async () => {
    const calls: string[][] = [];
    const ids = Array.from({ length: RETENTION_DELETE_BATCH * 2 + 7 }, (_, i) => cid(i));
    await deleteInBatches({ bulkDelete: async (batch) => { calls.push(batch); } }, ids);
    expect(calls.map((c) => c.length)).toEqual([RETENTION_DELETE_BATCH, RETENTION_DELETE_BATCH, 7]);
    expect(calls.flat()).toEqual(ids);
  });

  it("a failed batch stops the pass without throwing", async () => {
    let calls = 0;
    await deleteInBatches({ bulkDelete: async () => { calls++; throw new Error("disk"); } }, [cid(1), cid(2), cid(3)], 1);
    expect(calls).toBe(1);
  });
});
