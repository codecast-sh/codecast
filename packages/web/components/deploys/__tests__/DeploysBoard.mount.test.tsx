// The Deploys board drawn from a small fixture, the way the page hands it plain data: a Shipping card's stepper and
// words, a deploy card's session rows with the lines read for it, the switch changing what each card lists, Mine
// narrowing both columns, the line saying where the viewer's sessions are, and a backend without the Ship runs query.
// The pills run for real; only Convex is faked.
import { afterAll, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { DeploysBoard } = await import("../DeploysBoard");
const { EntityFixtureContext } = await import("../../../lib/entityDisplay");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const H = 60 * 60_000;
const NOW = 1_800_000_000_000;
const ME = "user-me";
const sess = (id: string, user_id: string, title: string) => ({ conversation_id: id, short_id: id.slice(0, 7), title, user_id });
const commit = (sha: string, main_at: number, session: ReturnType<typeof sess>, extra: Record<string, unknown> = {}) => ({
  sha, subject: `Change ${sha}`, at: main_at, main_at, author: "a", ci: "passed", ci_url: null, session, tasks: [], ...extra,
});

// Waiting on main: one of mine and one of a teammate's, both newer than the live deploy.
const queue = [
  commit("a1aaaaaaaa", NOW - H, sess("jx7mineaaaaaaa", ME, "My waiting session"), { insertions: 12, deletions: 3, pr_number: 41, tasks: [{ task_id: "t41", short_id: "ct-41", title: "Waiting task" }] }),
  commit("b2bbbbbbbb", NOW - 2 * H, sess("jx7theirsaaaaa", "user-ana", "Ana's waiting session"), { insertions: 5, deletions: 0, pr_number: 42 }),
];
const target = {
  _id: "o/r#production", workspace: "team:t", team_id: "t", name: "production", repository: "o/r", runs: "here", policy: "press", command: "x", rollback: null,
  paths: [], can_deploy: true, can_redeploy_sha: false, can_rollback: false, device_id: "d", publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: 2, untouched: 0, head_sha: "a1aaaaaaaa", head_ci: "passed", head_ci_url: null, shown: 2, groups: [{ key: "all", session: null, ci: "passed", commits: queue }] },
} as any;
// Live now: carried a session of mine and one of Ana's. Its rows carry no lines: deployLines answers for the card.
const live = {
  _id: "d1", workspace: "team:t", target: "production", repository: "o/r", short_id: "dp-7", status: "live", action: "deploy", rollback_of: null,
  sha: "c3cccccccc", previous_sha: null, version: null, url: null, started_by: "ana", note: null, commits: 2, created_at: NOW - 5 * H, live_at: NOW - 5 * H, finished_at: NOW - 5 * H,
  sessions: [sess("jx7mineoldaaaa", ME, "My live session"), sess("jx7anaoldaaaaa", "user-ana", "Ana's live session")],
  commit_rows: [
    { sha: "c3cccccccc", subject: "Live change", conversation_id: "jx7mineoldaaaa", tasks: ["ct-30"] },
    { sha: "c4cccccccc", subject: "Ana's change", conversation_id: "jx7anaoldaaaaa", tasks: [] },
  ],
  tasks: [{ short_id: "ct-30", title: "Live task" }],
} as any;
// Lines were read for my commit; Ana's is not recorded.
const lines = new Map([["d1", [{ sha: "c3cccccccc", insertions: 100, deletions: 20, pr_number: 30, branch: "jb/live" }, { sha: "c4cccccccc", pr_number: null, branch: null }]]]);
let wanted: string[][] = [];
const run = (id: string, extra: Record<string, unknown>) => ({
  _id: id, status: "running", task_id: null, task_short_id: null, task_title: null, workflow_slug: "change", workflow_label: "change",
  current_node_id: null, current_node_label: null, node_statuses: [], pr: null, fail_reason: null, gate_node_id: null, gate_prompt: null,
  gate_decision_short_id: null, gate_decision_status: null, spawner_conversation_id: null, primary_conversation_id: null,
  project_path: null, user_id: ME, created_at: NOW - 3 * H, updated_at: NOW - H, ...extra,
});
const runs = [
  run("r-stopped", {
    status: "failed", task_short_id: "ct-50", task_title: "Fix the flaky upload", fail_reason: "Stopped: CI could not start", user_id: "user-ana",
    pr: { repository: "o/r", number: 50, first_head_sha: "x", head_sha: "x", at: 1 },
    node_statuses: [{ node_id: "pr", status: "completed" }, { node_id: "ci", status: "failed" }],
  }),
  run("r-fixing", {
    task_short_id: "ct-51", task_title: "Rework the deploy page", current_node_label: "Fix findings",
    pr: { repository: "o/r", number: 51, first_head_sha: "y", head_sha: "y", at: 1 }, ci_verdict: { green: true, head_sha: "y", at: 1 }, review_verdict: { verdict: "changes", at: 1 },
    node_statuses: [{ node_id: "pr", status: "completed" }, { node_id: "ci", status: "completed" }, { node_id: "review", status: "failed" }],
  }),
];

function Board({ unavailable = false }: { unavailable?: boolean }) {
  const [show, setShow] = useState<any>("sessions");
  const [mine, setMine] = useState(false);
  return (
    <MemoryRouter>
      <DeploysBoard
        target={target} production={undefined} deploys={[live]} shipping={unavailable ? null : { runs: runs as any, shippers: [] }} shippingError={unavailable}
        linesByDeploy={lines} onLinesWanted={(ids) => wanted.push(ids)} checkouts={[]} me={ME} now={NOW}
        priorities={false} focus={null} reach={null} openDeploy={null} show={show} mine={mine} onShow={setShow} onMine={setMine}
        onClearFocus={() => {}} onPress={() => {}} onRollback={() => {}} onPause={() => {}} onLift={() => {}}
      />
    </MemoryRouter>
  );
}

function mount(unavailable = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Board unavailable={unavailable} />));
  return { host, unmount: () => act(() => root.unmount()) };
}

const card = (host: HTMLElement, id: string) => host.querySelector(`[data-deploy-card="${id}"]`)!;
const rowKeys = (el: Element) => [...el.querySelectorAll("[data-deploy-row]")].map((r) => r.getAttribute("data-deploy-row"));
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

test("a Shipping card shows its stepper and where the run stands, stopped runs first", () => {
  const { host, unmount } = mount();
  const cards = [...host.querySelectorAll("[data-deploy-run]")];
  expect(cards.map((c) => c.getAttribute("data-deploy-run"))).toEqual(["r-stopped", "r-fixing"]);
  const steps = (c: Element) => [...c.querySelectorAll(".dpp-step")].map((s) => `${s.textContent}:${s.getAttribute("data-state")}`);
  expect(steps(cards[0]!)).toEqual(["PR:done", "CI:failed", "Review:idle", "Merge:idle"]);
  expect(cards[0]!.querySelector("[data-deploy-run-state]")!.textContent).toBe("Stopped");
  expect(cards[0]!.textContent).toContain("CI could not start");
  expect(steps(cards[1]!)).toEqual(["PR:done", "CI:done", "Review:active", "Merge:idle"]);
  expect(cards[1]!.querySelector("[data-deploy-run-state]")!.textContent).toBe("Fixing review findings");
  expect(cards[1]!.querySelector(".dpp-run-title")!.getAttribute("href")).toBe("/tasks/ct-51");
  expect(host.querySelector("[data-deploy-shipping-count]")!.textContent).toBe("2 changes");
  unmount();
});

test("a deploy card lists its sessions, own first with a dot, with the lines read for it, unrecorded as —", () => {
  wanted = [];
  const { host, unmount } = mount();
  // The card on screen asked for its lines, by the deploy it lists.
  expect(wanted.at(-1)).toEqual(["d1"]);
  const dp = card(host, "dp-7");
  expect(dp.querySelector("[data-deploy-state]")!.textContent).toBe("Live now");
  expect(rowKeys(dp)).toEqual(["jx7mineoldaaaa", "jx7anaoldaaaaa"]);
  const [mineRow, theirs] = [...dp.querySelectorAll(".dpp-row")];
  expect(mineRow!.querySelector(".dpp-you")).not.toBeNull();
  expect(mineRow!.querySelector(".dpp-lines")!.textContent).toBe("+100−20");
  expect(theirs!.querySelector(".dpp-you")).toBeNull();
  expect(theirs!.querySelector(".dpp-lines")!.textContent).toBe("—");
  // Next deploy lists what waits, mine first, with the press.
  const next = card(host, "next");
  expect(rowKeys(next)).toEqual(["jx7mineaaaaaaa", "jx7theirsaaaaa"]);
  expect(next.textContent).toContain("2 commits on main after dp-7");
  expect(next.querySelector("[data-deploy-go]")!.hasAttribute("disabled")).toBe(false);
  unmount();
});

test("the switch changes what every card lists", () => {
  const { host, unmount } = mount();
  click(host.querySelector('[data-deploy-view="prs"]'));
  expect(rowKeys(card(host, "next"))).toEqual(["#41", "#42"]);
  expect(rowKeys(card(host, "dp-7"))).toEqual(["#30", "c4cccccccc"]);
  // One pill per row holding the number and the title; a commit with no PR says so before its subject.
  const prRow = card(host, "dp-7").querySelector('[data-deploy-row="#30"]')!;
  expect(prRow.querySelectorAll(".entity-ref")).toHaveLength(1);
  expect(prRow.querySelector(".entity-ref")!.textContent).toContain("#30 Live change");
  expect(card(host, "dp-7").querySelector('[data-deploy-row="c4cccccccc"]')!.textContent).toBe("No PR · Ana's change—");
  click(host.querySelector('[data-deploy-view="shas"]'));
  expect(card(host, "dp-7").querySelector('[data-deploy-row="c3cccccccc"] .entity-ref')!.textContent).toContain("c3ccccc Live change");
  click(host.querySelector('[data-deploy-view="tasks"]'));
  expect(rowKeys(card(host, "dp-7"))).toEqual(["ct-30"]);
  expect(card(host, "dp-7").querySelector(".dpp-lines")).toBeNull();
  click(host.querySelector('[data-deploy-view="branches"]'));
  expect(rowKeys(card(host, "dp-7"))).toEqual(["jb/live", "no-branch"]);
  // A branch with a PR opens the PR's page.
  expect(card(host, "dp-7").querySelector('[data-deploy-branch="jb/live"]')!.getAttribute("href")).toBe("/pr/o/r/30");
  expect(card(host, "dp-7").querySelector('[data-deploy-row="no-branch"]')!.textContent).toContain("Branch not recorded");
  expect(host.querySelector('[data-deploy-view="priorities"]')).toBeNull();
  unmount();
});

test("your sessions are counted once by where their newest work is, each part linking to its card", () => {
  const { host, unmount } = mount();
  const yours = host.querySelector("[data-deploy-yours]")!;
  expect(yours.textContent).toBe("Your sessions: 1 waiting to deploy · 1 live");
  expect([...yours.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["#deploy-next", "#deploy-dp-7"]);
  unmount();
});

test("Mine narrows both columns to the viewer's work and counts what it kept", () => {
  const { host, unmount } = mount();
  click(host.querySelector("[data-deploy-mine]"));
  expect(host.querySelector("[data-deploy-mine]")!.getAttribute("aria-pressed")).toBe("true");
  expect([...host.querySelectorAll("[data-deploy-run]")].map((c) => c.getAttribute("data-deploy-run"))).toEqual(["r-fixing"]);
  expect(host.querySelector("[data-deploy-shipping-count]")!.textContent).toBe("1 of 2");
  expect(rowKeys(card(host, "next"))).toEqual(["jx7mineaaaaaaa"]);
  expect(rowKeys(card(host, "dp-7"))).toEqual(["jx7mineoldaaaa"]);
  // The dot marks yours among others; with only yours listed it says nothing.
  expect(host.querySelector(".dpp-you:not(.dpp-sub .dpp-you)")).toBeNull();
  expect(host.querySelector("[data-deploy-count]")!.textContent).toBe("1 of 1");
  unmount();
});

test("a backend without the Ship runs query says Shipping can't be read, and the deploys still list what they carried", () => {
  const { host, unmount } = mount(true);
  expect(host.querySelector("[data-deploy-shipping]")!.textContent).toContain("What is shipping can't be read right now");
  expect(host.querySelector("[data-deploy-shipping-count]")).toBeNull();
  expect(rowKeys(card(host, "dp-7"))).toEqual(["jx7mineoldaaaa", "jx7anaoldaaaaa"]);
  unmount();
});

// Link landing and the cards' own words, on a longer history: props change under a mounted board, as reach and feeds
// arrive after the page opened.
const dep = (short_id: string, at: number, extra: Record<string, unknown> = {}) => ({
  ...live, _id: short_id, short_id, sha: `${short_id}-sha-0000`, status: "live", created_at: at, live_at: at, finished_at: at, sessions: [], commit_rows: [], tasks: [], commits: 0, ...extra,
});
const many = [
  dep("dp-11", 20 * H, { status: "cancelled", sha: "retry-sha-000", live_at: null }),
  dep("dp-10", 19 * H, { status: "failed", sha: "retry-sha-000", live_at: null, note: "Health check failed" }),
  ...[9, 8, 7, 6, 5, 4, 3].map((i) => dep(`dp-${i}`, i * H)),
  dep("dp-2", 2 * H, {
    commits: 15, sessions: [sess("jx7anaoldaaaaa", "user-ana", "Ana's live session")],
    commit_rows: Array.from({ length: 15 }, (_, i) => ({ sha: `f${String(i).padStart(9, "0")}`, subject: `Fix ${i} (#${100 + i})`, conversation_id: "jx7anaoldaaaaa", tasks: [] })),
  }),
];
const props = (over: Record<string, unknown> = {}) => ({
  target: { ...target, queue: { ...target.queue, commits: 0, shown: 0, groups: [] } }, production: undefined, deploys: many,
  shipping: { runs: runs as any, shippers: [] }, checkouts: [], me: ME, now: NOW + 30 * H, priorities: false, focus: null, reach: null,
  openDeploy: null, show: "sessions", mine: false, onShow() {}, onMine() {}, onClearFocus() {}, onPress() {}, onRollback() {}, onPause() {}, onLift() {}, ...over,
}) as any;
function mountWith(p: any, fixtures: Record<string, { type: any; entity: any }> | null = null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const draw = (q: any) => act(() => root.render(<MemoryRouter><EntityFixtureContext.Provider value={fixtures}><DeploysBoard {...q} /></EntityFixtureContext.Provider></MemoryRouter>));
  draw(p);
  return { host, draw, unmount: () => act(() => root.unmount()) };
}

test("a cancelled attempt that sent nothing is one line, and a link to an earlier attempt opens that attempt's detail", () => {
  const { host, unmount } = mountWith(props({ openDeploy: "dp-10" }));
  const retry = card(host, "dp-11");
  expect(retry.hasAttribute("data-quiet")).toBe(true);
  expect(retry.querySelector(".dpp-none")).toBeNull();
  expect(retry.querySelector('[data-deploy-detail="dp-10"]')!.textContent).toContain("Health check failed");
  // Its own button closes it, and the lead's opens the lead's.
  click(retry.querySelector('[data-deploy-open="dp-10"]'));
  expect(retry.querySelector("[data-deploy-detail]")).toBeNull();
  click(retry.querySelector('[data-deploy-open="dp-11"]'));
  expect(retry.querySelector('[data-deploy-detail="dp-11"]')).not.toBeNull();
  unmount();
});

test("a deploy asked for with no commit reads Asked for across its card, never going out", () => {
  const { host, unmount } = mountWith(props({ deploys: [dep("dp-12", 21 * H, { status: "requested", sha: null, live_at: null, finished_at: null }), ...many] }));
  const asked = card(host, "dp-12");
  expect(asked.getAttribute("data-kind")).toBe("asked");
  expect(asked.querySelector('[data-deploy-state]')!.textContent).toBe("Asked for");
  expect(asked.textContent).not.toContain("no step reported yet");
  expect(asked.querySelector(".dpp-age")!.getAttribute("title")).toMatch(/^Asked for /);
  unmount();
});

test("a card a link finds after the page opened is drawn past Earlier deploys, and its folded row opens", () => {
  const { host, draw, unmount } = mountWith(props());
  expect(card(host, "dp-2")).toBeNull();
  expect(host.querySelector("[data-deploy-older]")).not.toBeNull();
  draw(props({ focus: { kind: "pr", pr: 114 } }));
  const dp = card(host, "dp-2");
  expect(dp).not.toBeNull();
  // The session row holds the PR, so the row lights up, not the whole card.
  expect(dp.querySelector('[data-deploy-row="jx7anaoldaaaaa"]')!.hasAttribute("data-focus")).toBe(true);
  expect(dp.hasAttribute("data-focus")).toBe(false);
  // Under PRs the matching row sits past the fold (15 rows): the list opens on its own.
  draw(props({ focus: { kind: "pr", pr: 114 }, show: "prs" }));
  expect(card(host, "dp-2").querySelector('[data-deploy-row="#114"]')!.hasAttribute("data-focus")).toBe(true);
  // A view with no row holding it (Tasks: none named) lights the card itself.
  draw(props({ focus: { kind: "pr", pr: 114 }, show: "tasks" }));
  expect(card(host, "dp-2").hasAttribute("data-focus")).toBe(true);
  unmount();
});

test("Mine keeps the run a link points at, and reads the owner of the session that pressed Ship", () => {
  const shippers = [{ run_id: "r-stopped", task_short_id: "ct-50", merged_sha: null, spawner_conversation_id: "c", user_id: ME, stand_in: false, created_at: 1 }];
  const ids = (host: HTMLElement) => [...host.querySelectorAll("[data-deploy-run]")].map((c) => c.getAttribute("data-deploy-run"));
  // r-stopped's run belongs to Ana, but the session that pressed Ship is the viewer's.
  const { host, draw, unmount } = mountWith(props({ mine: true, shipping: { runs, shippers } }));
  expect(ids(host)).toEqual(["r-stopped", "r-fixing"]);
  draw(props({ mine: true, shipping: { runs, shippers: [{ ...shippers[0], user_id: "user-ana" }] } }));
  expect(ids(host)).toEqual(["r-fixing"]);
  draw(props({ mine: true, shipping: { runs, shippers: [{ ...shippers[0], user_id: "user-ana" }] }, focus: { kind: "task", id: "ct-50" } }));
  expect(ids(host)).toEqual(["r-stopped", "r-fixing"]);
  unmount();
});

test("Dropped opens on its own once the run a link points at is found there", () => {
  const stale = [run("r-old", { task_short_id: "ct-60", task_title: "Old change", updated_at: NOW - 9 * 24 * H, pr: { repository: "o/r", number: 60, first_head_sha: "z", head_sha: "z", at: 1 } })];
  const { host, draw, unmount } = mountWith(props({ shipping: null, focus: { kind: "task", id: "ct-60" } }));
  expect(host.querySelector('[data-deploy-run="r-old"]')).toBeNull();
  draw(props({ shipping: { runs: stale, shippers: [] }, focus: { kind: "task", id: "ct-60" } }));
  expect(host.querySelector("[data-deploy-dropped]")!.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[data-deploy-run="r-old"]')!.hasAttribute("data-focus")).toBe(true);
  unmount();
});

test("the deploy a link opens beside its change is drawn with its detail open, however far down the history it is", () => {
  const { host, unmount } = mountWith(props({ openDeploy: "dp-3" }));
  expect(card(host, "dp-3").querySelector('[data-deploy-detail="dp-3"]')).not.toBeNull();
  unmount();
});

test("an open deploy asked for before the live one reads as never gone out", () => {
  const stale = dep("dp-12", 8.5 * H, { status: "running", live_at: null, finished_at: null });
  const { host, unmount } = mountWith(props({ deploys: [stale, ...many] }));
  expect(card(host, "dp-12").querySelector("[data-deploy-state]")!.textContent).toBe("Never went out");
  unmount();
});

test("a press asked for with no commit yet reads as asked for on the press it holds, never going out", () => {
  const asked = dep("dp-13", 21 * H, { status: "requested", sha: null, live_at: null, finished_at: null });
  const { host, unmount } = mountWith(props({ target, deploys: [asked, ...many] }));
  const go = card(host, "next").querySelector("[data-deploy-go]")!;
  expect(go.hasAttribute("disabled")).toBe(true);
  expect(go.getAttribute("title")).toBe("dp-13 is asked for");
  unmount();
});

test("a head with red CI is never the primary press: Deploy stays a plain button", () => {
  const red = { ...target, queue: { ...target.queue, head_ci: "failed", head_ci_url: "https://ci/red" } };
  const { host, unmount } = mountWith(props({ target: red, deploys: [live] }));
  const go = card(host, "next").querySelector("[data-deploy-go]")!;
  expect(go.classList.contains("dpp-go")).toBe(false);
  expect(go.getAttribute("data-ci")).toBe("failed");
  unmount();
  const green = mountWith(props({ target, deploys: [live] }));
  expect(card(green.host, "next").querySelector("[data-deploy-go]")!.classList.contains("dpp-go")).toBe(true);
  green.unmount();
});

test("opened at a waiting commit, the chip says its place since the live deploy and the failed try holding it", () => {
  const failed = { ...live, _id: "d9", short_id: "dp-9", status: "failed", sha: "a1aaaaaaaa", live_at: null, created_at: NOW - 0.5 * H, commit_rows: [], sessions: [] };
  const reach = { state: "failed", sha: "b2bbbbbbbb", targets: [{ target: "production", state: "failed", deploy: { short_id: "dp-9", status: "failed", sha: "a1aaaaaaaa", at: NOW, url: null }, now: null }] };
  const { host, unmount } = mountWith(props({ target, deploys: [failed, live], focus: { kind: "sha", sha: "b2bbbbb" }, reach }));
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.querySelector("[data-spot-place]")!.textContent).toBe("1 of 2 since dp-7");
  expect(chip.querySelector('[data-spot-held="failed"]')!.getAttribute("href")).toBe("#deploy-dp-9");
  unmount();
});

test("a merged PR on the board is one pill at full colour, not a settled reference's dim", () => {
  const merged = { _id: "pr30", repository: "o/r", number: 30, title: "Live change", state: "merged", merged_at: NOW - 6 * H };
  const { host, unmount } = mountWith(props({ deploys: [live], linesByDeploy: lines, show: "prs" }), { "o/r#30": { type: "pr", entity: merged } });
  const pill = card(host, "dp-7").querySelector('[data-deploy-row="#30"] .entity-ref')!;
  expect(pill.textContent).toContain("#30 Live change");
  const classes = pill.className.split(/\s+/);
  expect(classes).toContain("text-sol-green");
  expect(classes).not.toContain("text-sol-green/60");
  unmount();
});

test("Priorities: one pill per priority with its sessions, yours by rank, then teammates' by rank, then unranked, No priority last", () => {
  const pri = (id: string, rank: number | null, user_id: string) => ({ id, title: `Priority ${id}`, rank, user_id });
  const s = (id: string, priority: ReturnType<typeof pri> | null) => ({ ...sess(id, ME, `Session ${id}`), priority });
  const sessions = [
    s("jx7nonesaaaaaa", null),
    s("jx7unrankedaaa", pri("pri-9", null, ME)),
    s("jx7theirs2aaaa", pri("pri-4", 2, "user-ana")),
    s("jx7mine2aaaaaa", pri("pri-3", 2, ME)),
    s("jx7theirs1aaaa", pri("pri-2", 1, "user-ana")),
    s("jx7mine1aaaaaa", pri("pri-1", 1, ME)),
    s("jx7mine1bbbbbb", pri("pri-1", 1, ME)),
  ];
  const d = dep("dp-20", 21 * H, { commits: sessions.length, sessions, commit_rows: sessions.map((x, i) => ({ sha: `p${String(i).padStart(9, "0")}`, subject: `Change ${i}`, conversation_id: x.conversation_id, tasks: [] })) });
  const { host, unmount } = mountWith(props({ deploys: [d], show: "priorities", priorities: true }));
  const c = card(host, "dp-20");
  expect(rowKeys(c)).toEqual(["pri-1", "pri-3", "pri-2", "pri-4", "pri-9", "none"]);
  const row = (k: string) => c.querySelector(`[data-deploy-row="${k}"]`)!;
  expect(row("pri-1").querySelectorAll(".entity-ref")).toHaveLength(1);
  expect(row("pri-1").textContent).toContain("Priority pri-1");
  expect(row("pri-1").textContent).toContain("· 2 sessions");
  expect(row("none").querySelector(".entity-ref")).toBeNull();
  expect(row("none").textContent).toContain("No priority · 1 session");
  unmount();
});
