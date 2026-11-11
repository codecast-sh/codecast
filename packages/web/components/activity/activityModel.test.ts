import { describe, expect, test } from "bun:test";
import type { Conversation } from "../../lib/conversationRow";
import type { ExternalEventRecord } from "../../lib/externalEventRecord";
import {
  filterItems, filterLoose, groupActivity, indexOutcomes, keepStableItems, loosePrs, makeItem, needsList, nowStrip,
  peopleFacets, prFromStatus, prThreads, projectFacets, summarize, withLivePr, NO_OUTCOMES,
  type ActivityActor, type ActivityItem,
} from "./activityModel";
import { activityViewQuery, parseActivityView, togglePerson } from "./activityView";
import type { SessionStatus } from "../../lib/sessionStatus";

const TZ = "UTC";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 15, 0, 0);
const sam: ActivityActor = { id: "sam", name: "Sam", image: null };
const ana: ActivityActor = { id: "ana", name: "Ana", image: null };

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  _id: id, user_id: "", title: id, started_at: T0 - 3_600_000, updated_at: T0, duration_ms: 3_600_000,
  is_active: false, author_name: "", is_own: false, project_path: "/Users/x/src/web", ...extra,
});
const item = (id: string, actor: ActivityActor, status: SessionStatus, extra: Partial<Conversation> = {}, outcomes = NO_OUTCOMES): ActivityItem =>
  makeItem({ conv: conv(id, extra), status, reason: null, line: `${id} line`, title: id, actor, outcomes, hiddenFromTeam: false });

const ev = (id: string, extra: Partial<ExternalEventRecord>): ExternalEventRecord => ({ _id: id, created_at: T0, repository: "acme/web", ...extra });

describe("outcomes", () => {
  test("a PR's state is its newest state-moving event, whichever session moved it", () => {
    const prs = prThreads([
      ev("1", { kind: "pr_opened", pr_number: 42, title: "Fix checkout", conversation_id: "s1", created_at: T0 - 1000 }),
      ev("2", { kind: "pr_merged", pr_number: 42, title: "Fix checkout", actor_user_id: "ana", created_at: T0 }),
      ev("3", { kind: "pr_review", pr_number: 43, conversation_id: "s2" }),
    ]);
    expect(prs.get("acme/web#42")).toMatchObject({ label: "merged", merged: true, title: "Fix checkout", href: "/pr/acme/web/42", accent: "violet" });
    expect([...prs.get("acme/web#42")!.convIds]).toEqual(["s1"]);
    // Touched but never moved: open.
    expect(prs.get("acme/web#43")).toMatchObject({ label: "open", merged: false });
  });

  test("a session gets its PRs, commits, tasks and decisions", () => {
    const events = [
      ev("c1", { kind: "commit", sha: "a1", conversation_id: "s1" }),
      ev("c2", { kind: "commit", sha: "a2", conversation_id: "s1" }),
      ev("c3", { kind: "commit", sha: "a2", conversation_id: "s1" }),
      ev("p1", { kind: "push", conversation_id: "s2", meta: { commits_count: 3 } }),
      ev("pr", { kind: "pr_merged", pr_number: 9, conversation_id: "s1" }),
    ];
    const out = indexOutcomes({
      events,
      prs: prThreads(events),
      tasks: [
        { _id: "t1", short_id: "ct-1", title: "Done one", status: "done", closed_at: T0, conversation_ids: ["s1"] },
        { _id: "t2", short_id: "ct-2", title: "Open one", status: "open", created_from_conversation: "s1" },
        { _id: "t3", short_id: "ct-3", title: "Dropped", status: "dropped", conversation_ids: ["s1"] },
      ],
      decisions: [
        { _id: "d1", short_id: "sd-1", conversation_id: "s2", question: "Which cache?", status: "pending", asked_user_ids: ["me"], created_at: T0 },
        { _id: "d2", conversation_id: "s2", question: "Old", status: "answered", resolved_at: T0 - 5 },
        { _id: "d3", conversation_id: "s2", question: "Gone", status: "withdrawn" },
      ],
      viewerId: "me",
    });
    const s1 = out.get("s1")!;
    expect(s1.commits).toBe(2);
    expect(s1.prs.map((p) => p.key)).toEqual(["acme/web#9"]);
    expect(s1.tasks.map((t) => [t.shortId, t.done])).toEqual([["ct-1", true], ["ct-2", false]]);
    const s2 = out.get("s2")!;
    expect(s2.commits).toBe(3);
    expect(s2.decisions.map((d) => [d.id, d.pending, d.askedOfViewer])).toEqual([["d1", true, true], ["d2", false, false]]);
  });

  test("the session's live PR state outranks the events'", () => {
    const base = { ...NO_OUTCOMES, prs: [{ ...prFromStatus({ repository: "acme/web", number: 9, state: "open", at: T0 - 9 }), label: "open" }] };
    const live = prFromStatus({ repository: "acme/web", number: 9, state: "ci_red", at: T0 });
    const merged = withLivePr(base, live);
    expect(merged.prs).toHaveLength(1);
    expect(merged.prs[0]).toMatchObject({ label: "ci red", accent: "red" });
  });

  test("a PR no listed session touched is loose, and files under whoever moved it", () => {
    const prs = prThreads([
      ev("1", { kind: "pr_merged", pr_number: 1, conversation_id: "listed", actor_user_id: "sam" }),
      ev("2", { kind: "pr_merged", pr_number: 2, actor_user_id: "ana", actor_login: "ana-gh" }),
    ]);
    const loose = loosePrs(prs, new Set(["listed"]));
    expect(loose.map((p) => p.number)).toEqual([2]);
    expect(loose[0].actor).toMatchObject({ id: "ana" });
  });
});

describe("the four answers", () => {
  const items = [
    item("live1", sam, "working", { updated_at: T0 - 60_000 }),
    item("live2", sam, "working", { updated_at: T0 - 120_000 }),
    item("ask", ana, "needs_you", { updated_at: T0 - 30_000 }),
    item("err", ana, "error", { updated_at: T0 - 90_000 }),
    item("done", ana, "idle", { updated_at: T0 - DAY, project_path: "/Users/x/src/api" }),
  ];

  test("now: each live person with their live sessions, newest first", () => {
    expect(nowStrip(items).map((p) => [p.actor.id, p.items.map((i) => i.id)])).toEqual([["sam", ["live1", "live2"]]]);
  });

  test("needs: failures before asks", () => {
    expect(needsList(items).map((i) => i.id)).toEqual(["err", "ask"]);
  });

  test("a pending decision on any status waits on someone", () => {
    const withAsk = item("x", sam, "idle", {}, { ...NO_OUTCOMES, decisions: [{ id: "d", shortId: null, question: "?", pending: true, askedOfViewer: false, at: T0 }] });
    expect(withAsk.needs).toBe(true);
  });

  test("days, then people, newest first; loose PRs join their person's day", () => {
    const loose = loosePrs(prThreads([ev("m", { kind: "pr_merged", pr_number: 5, actor_user_id: "sam", created_at: T0 - 10 })]), new Set());
    const days = groupActivity(items, loose, "person", TZ);
    expect(days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-09"]);
    // Sam's merge, seconds ago, puts his group first.
    expect(days[0].groups.map((g) => g.key)).toEqual(["p:sam", "p:ana"]);
    expect(days[0].groups[0].prs.map((p) => p.number)).toEqual([5]);
    expect(groupActivity(items, [], "person", TZ)[0].groups.map((g) => g.key)).toEqual(["p:ana", "p:sam"]);
    expect(days[0].sessions).toBe(4);
    expect(days[0].people).toBe(2);
  });

  test("grouped by project instead", () => {
    const days = groupActivity(items, [], "project", TZ);
    expect(days[0].groups.map((g) => g.label)).toEqual(["web"]);
    expect(days[1].groups.map((g) => g.label)).toEqual(["api"]);
  });

  test("summary counts distinct merged PRs and done tasks", () => {
    const pr = prFromStatus({ repository: "acme/web", number: 1, state: "merged", at: T0 });
    const task = { id: "t", shortId: "ct-1", title: "", done: true, at: T0 };
    const a = item("a", sam, "idle", {}, { ...NO_OUTCOMES, prs: [pr], tasks: [task] });
    const b = item("b", ana, "idle", {}, { ...NO_OUTCOMES, prs: [pr], tasks: [task] });
    expect(summarize([a, b], [])).toMatchObject({ sessions: 2, people: 2, prsMerged: 1, tasksDone: 1 });
  });

  test("filters by people, project and needs; facets list everyone", () => {
    expect(filterItems(items, { people: ["ana"], project: null, needs: false }).map((i) => i.id)).toEqual(["ask", "err", "done"]);
    expect(filterItems(items, { people: [], project: "api", needs: false }).map((i) => i.id)).toEqual(["done"]);
    expect(filterItems(items, { people: [], project: null, needs: true }).map((i) => i.id)).toEqual(["ask", "err"]);
    expect(filterLoose([], { people: [], project: null, needs: true })).toEqual([]);
    expect(peopleFacets(items).map((f) => [f.actor.id, f.sessions, f.live])).toEqual([["sam", 2, 2], ["ana", 3, 0]]);
    expect(projectFacets(items)).toEqual([{ name: "web", sessions: 4 }, { name: "api", sessions: 1 }]);
  });

  test("an item whose drawn fields did not change keeps its identity", () => {
    const first = keepStableItems(new Map(), [item("a", sam, "idle")]);
    const again = keepStableItems(first.cache, [item("a", sam, "idle")]);
    expect(again.items[0]).toBe(first.items[0]);
    const moved = keepStableItems(again.cache, [item("a", sam, "working")]);
    expect(moved.items[0]).not.toBe(first.items[0]);
  });
});

describe("the view in the address", () => {
  test("defaults: the team's activity, the viewer's own messages", () => {
    expect(parseActivityView(new URLSearchParams(""), { tab: "activity", hasTeam: true })).toMatchObject({ scope: "team", group: "person", people: [], needs: false });
    expect(parseActivityView(new URLSearchParams(""), { tab: "messages", hasTeam: true }).scope).toBe("my");
    expect(parseActivityView(new URLSearchParams("filter=team"), { tab: "activity", hasTeam: false }).scope).toBe("my");
  });

  test("the address names a view; the saved grouping fills in when it does not", () => {
    const view = parseActivityView(new URLSearchParams("filter=my&people=a,b&project=web&needs=1&dir=/src/web"), { tab: "activity", hasTeam: true, savedGroup: "project" });
    expect(view).toMatchObject({ scope: "my", group: "project", people: ["a", "b"], project: "web", needs: true, dir: "/src/web" });
    const qs = activityViewQuery(view, true);
    expect(Object.fromEntries(new URLSearchParams(qs))).toEqual({ filter: "my", dir: "/src/web", group: "project", people: "a,b", project: "web", needs: "1" });
    expect(activityViewQuery({ ...view, tab: "activity", scope: "team", group: "person", people: [], project: null, needs: false, dir: null }, true)).toBe("");
  });

  test("a face toggles", () => {
    expect(togglePerson(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePerson(["a", "b"], "a")).toEqual(["b"]);
  });
});
