// The Deploys page in the viewer's own workspace, mounted on the real store: one chip per project (its face, name, state
// mark and deploys live in 30 days), every one on at first and the board drawing them together, each card in both
// columns tagged with its project; a chip toggles, one project left draws its single board, none says so, and the
// selection rides the address. A team's page still asks by team_id and draws targets. Only Convex is faked.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/deploys" });
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
// Every read the page asks for, by function name, with its args.
const asked: Array<{ fn: string; args: Record<string, unknown> }> = [];
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (q: any, args: any) => {
    if (args !== "skip") asked.push({ fn: getFunctionName(q), args });
    return { data: undefined };
  },
}));
const remembered: Array<{ page: string } & Record<string, string | null>> = [];
const realRemembered = await import("../../../lib/rememberedFilters");
mock.module("../../../lib/rememberedFilters", () => ({ ...realRemembered, rememberFilters: (page: string, v: Record<string, string | null>) => { remembered.push({ page, ...v }); } }));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../../store/inboxStore");
const { DeploysPage } = await import("../DeploysPage");
const { stampDeploysLive } = await import("../../../hooks/useDeploysCacheFresh");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const H = 60 * 60_000;
const NOW = Date.now();
const ME = "jx7me0000000000000000000000000001";
const WS = `user:${ME}`;
const TEAM = "jx7team00000000000000000000000001";

const deploy = (id: string, repository: string, status: string, at: number, over: Record<string, unknown> = {}) => ({
  _id: id, workspace: WS, target: "production", repository, short_id: id, status, action: "deploy", rollback_of: null, sha: `${id.replace(/\W/g, "")}aaaaaaaa`,
  previous_sha: null, version: null, url: null, started_by: "you", note: null, commits: 0, sessions: [], created_at: at,
  live_at: status === "live" ? at : null, finished_at: status === "running" ? null : at, ...over,
});
// sit: live two days ago, and once 40 days ago (outside the 30-day count). dance: its last deploy failed. wardrobe: one
// going out now. tycho: no deploy yet, only a Ship run in its checkout.
const deploys = [
  deploy("dp-11", "jasonbenn/sit", "live", NOW - 48 * H),
  deploy("dp-10", "jasonbenn/sit", "live", NOW - 40 * 24 * H),
  deploy("dp-12", "jasonbenn/dance", "failed", NOW - H, { note: "build failed" }),
  deploy("dp-13", "jasonbenn/wardrobe", "running", NOW - 10 * 60_000),
];
const run = (id: string, path: string, updated_at: number, title: string) => ({
  _id: id, workspace: WS, status: "running", task_id: null, task_short_id: null, task_title: title, workflow_slug: "change", workflow_label: "change",
  current_node_id: "check", current_node_label: "Check", node_statuses: [{ node_id: "check", status: "running" }], pr: null, fail_reason: null, gate_node_id: null,
  gate_prompt: null, gate_decision_short_id: null, gate_decision_status: null, spawner_conversation_id: null, primary_conversation_id: null,
  project_path: path, user_id: ME, created_at: updated_at - H, updated_at,
});
const runs = [run("r-sit", "/code/sit", NOW - 3 * H, "Tidy the timer"), run("r-tycho", "/code/tycho", NOW - 30 * 60_000, "First tycho deploy")];
const checkout = (repo: string) => ({ _id: `co-${repo}`, workspace: WS, device_id: "mac", path: `/code/${repo}`, repository: `jasonbenn/${repo}`, branch: "main", upstream: "origin/main", reported_at: NOW, level: { state: "ok" } });
const byId = (rows: Array<{ _id: string }>) => Object.fromEntries(rows.map((r) => [r._id, r]));

function seed({ personal = true, rows = true, saved, liveAt = Date.now() }: { personal?: boolean; rows?: boolean; saved?: Record<string, string>; liveAt?: number | null } = {}) {
  // The cache paints at once only when a Deploys page held these feeds live moments ago (useDeploysCacheFresh).
  for (const ws of [WS, `team:${TEAM}`]) {
    if (liveAt == null) window.localStorage.removeItem(`codecast:deploys-live:${ws}`);
    else stampDeploysLive(ws, liveAt);
  }
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { _id: ME, name: "You" },
    teams: [{ _id: TEAM, name: "Codecast" }],
    clientState: { ...s.clientState, ui: { ...(s.clientState?.ui ?? {}), active_team_id: personal ? null : TEAM, page_filters: saved ?? {} } },
    teamDeploys: rows ? byId(personal ? deploys : deploys.map((d) => ({ ...d, workspace: `team:${TEAM}`, repository: "o/codecast", target: "web" }))) : {},
    deployTargets: {},
    deployProductions: {},
    shippingRuns: rows && personal ? byId(runs) : {},
    shippingShippers: {},
    checkouts: rows && personal ? byId(["sit", "dance", "wardrobe", "tycho"].map(checkout)) : {},
    repoIcons: {},
  } as any);
}

function mount(props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><DeploysPage {...props} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

const chips = (host: HTMLElement) => [...host.querySelectorAll("[data-deploy-project-chip]")];
const chip = (host: HTMLElement, key: string) => host.querySelector(`[data-deploy-project-chip="${key}"]`) as HTMLElement;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const address = () => new URL(window.location.href).searchParams.get("projects");
const cardIds = (host: HTMLElement) => [...host.querySelectorAll("[data-deploy-card]")].map((c) => c.getAttribute("data-deploy-card"));

beforeEach(() => {
  asked.length = 0;
  remembered.length = 0;
  window.history.replaceState(null, "", "/deploys");
});

test("personal: a chip per project, newest activity first, each its face, state and deploys live in 30 days", () => {
  seed();
  const { host, unmount } = mount();
  expect(chips(host).map((c) => c.getAttribute("data-deploy-project-chip"))).toEqual(["jasonbenn/wardrobe", "jasonbenn/tycho", "jasonbenn/dance", "jasonbenn/sit"]);
  expect(chips(host).map((c) => c.querySelector(".dpp-target-name")!.textContent)).toEqual(["wardrobe", "tycho", "dance", "sit"]);
  expect(chips(host).map((c) => c.getAttribute("data-tone"))).toEqual(["going", "unknown", "failed", "current"]);
  expect(chips(host).every((c) => c.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(chips(host).every((c) => c.querySelector("[data-role-tile]"))).toBe(true);
  expect(chip(host, "jasonbenn/sit").querySelector("[data-deploy-project-live]")!.textContent).toBe("1");
  expect(chip(host, "jasonbenn/dance").querySelector("[data-deploy-project-live]")!.textContent).toBe("0");
  expect(host.querySelector("[data-deploy-projects-all]")).toBeNull();
  // It asked for the workspace by its key, and fed its projects' faces.
  const views = asked.filter((a) => a.fn === "deployTargets:view" || a.fn === "deployRefs:recentForTeam");
  expect(views.length).toBeGreaterThan(0);
  expect(views.every((a) => a.args.workspace === WS && !("team_id" in a.args))).toBe(true);
  expect(asked.some((a) => a.fn === "repoIcons:forWorkspace" && a.args.workspace === WS)).toBe(true);
  unmount();
});

test("personal, all on: one board draws every project's deploys newest first and every one's runs, each tagged in both columns", () => {
  seed();
  const { host, unmount } = mount();
  expect(host.querySelector("[data-deploy-pane]")!.getAttribute("data-deploy-pane")).toBe("projects");
  expect(host.querySelector("[data-deploy-heading]")!.textContent).toBe("All projects");
  expect(host.querySelector(".dpp-policy")).toBeNull();
  expect(cardIds(host)).toEqual(["dp-13", "dp-12", "dp-11", "dp-10"]);
  // The project tag follows the state pill on a deploy card, and leads a Shipping card's head.
  const tagOf = (el: Element) => el.querySelector("[data-deploy-project]")?.getAttribute("data-deploy-project");
  expect([...host.querySelectorAll("[data-deploy-card]")].map(tagOf)).toEqual(["jasonbenn/wardrobe", "jasonbenn/dance", "jasonbenn/sit", "jasonbenn/sit"]);
  const head = host.querySelector('[data-deploy-card="dp-12"] .dpp-card-head')!;
  expect(head.children[0].hasAttribute("data-deploy-state")).toBe(true);
  expect(head.children[1].getAttribute("data-deploy-project")).toBe("jasonbenn/dance");
  expect(head.querySelector("[data-role-tile]")).not.toBeNull();
  const shipping = [...host.querySelectorAll("[data-deploy-run]")];
  expect(shipping.map((r) => r.getAttribute("data-deploy-run"))).toEqual(["r-tycho", "r-sit"]);
  expect(shipping.map((r) => r.querySelector(".dpp-run-top")!.children[0].getAttribute("data-deploy-project"))).toEqual(["jasonbenn/tycho", "jasonbenn/sit"]);
  // Everything is the viewer's: no Mine, no "Your sessions"; nothing presses.
  expect(host.querySelector("[data-deploy-mine]")).toBeNull();
  expect(host.querySelector("[data-deploy-yours]")).toBeNull();
  expect(host.querySelector("[data-deploy-go], [data-deploy-rollback], [data-deploy-redeploy], [data-deploy-pause]")).toBeNull();
  expect(host.querySelector('[data-deploy-card="next"]')).toBeNull();
  unmount();
});

test("personal: a chip toggles, All turns every one back on, and one left draws its single board", () => {
  seed();
  const { host, unmount } = mount();
  click(chip(host, "jasonbenn/sit"));
  expect(chip(host, "jasonbenn/sit").getAttribute("aria-pressed")).toBe("false");
  expect(address()).toBe("jasonbenn/wardrobe,jasonbenn/tycho,jasonbenn/dance");
  expect(remembered.slice(-2)).toEqual([{ page: "deploys", show: null, mine: null }, { page: "deploys-projects", projects: "jasonbenn/wardrobe,jasonbenn/tycho,jasonbenn/dance" }]);
  expect(cardIds(host)).toEqual(["dp-13", "dp-12"]);
  expect(host.querySelector("[data-deploy-heading]")!.textContent).toBe("3 projects");
  click(host.querySelector("[data-deploy-projects-all]"));
  expect(chips(host).every((c) => c.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(address()).toBeNull();
  expect(host.querySelector("[data-deploy-projects-all]")).toBeNull();
  // Down to sit alone: its own board, Live in the head, its run in Shipping, no tags.
  for (const k of ["jasonbenn/wardrobe", "jasonbenn/tycho", "jasonbenn/dance"]) click(chip(host, k));
  expect(address()).toBe("jasonbenn/sit");
  expect(host.querySelector("[data-deploy-pane]")!.getAttribute("data-deploy-pane")).toBe("production");
  expect(host.querySelector("[data-deploy-heading]")!.textContent).toBe("sit");
  expect(host.querySelector(".dpp-policy")!.textContent).toBe("with every Ship");
  expect(host.querySelector(".dpp-head-sub")!.textContent).toBe("jasonbenn/sit");
  expect(host.querySelector(".dpp-live code")!.textContent).toBe("dp11aaa");
  expect(cardIds(host)).toEqual(["dp-11", "dp-10"]);
  expect(host.querySelector('[data-deploy-card="dp-11"] [data-deploy-state]')!.getAttribute("data-deploy-state")).toBe("Live now");
  expect([...host.querySelectorAll("[data-deploy-run]")].map((r) => r.getAttribute("data-deploy-run"))).toEqual(["r-sit"]);
  expect(host.querySelector("[data-deploy-project]")).toBeNull();
  expect(host.querySelector("[data-deploy-mine]")).toBeNull();
  // And none.
  click(chip(host, "jasonbenn/sit"));
  expect(address()).toBe("");
  expect(host.querySelector("[data-deploys-none-picked]")!.textContent).toBe("No projects selected");
  expect(host.querySelector("[data-deploy-pane]")).toBeNull();
  unmount();
});

test("personal: the address's projects open on, and a project with only a Ship run draws its board", () => {
  seed();
  const opened = mount({ initialProjects: "jasonbenn/dance" });
  expect(chips(opened.host).filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.getAttribute("data-deploy-project-chip"))).toEqual(["jasonbenn/dance"]);
  expect(cardIds(opened.host)).toEqual(["dp-12"]);
  expect(opened.host.querySelector('[data-deploy-card="dp-12"]')!.textContent).toContain("build failed");
  opened.unmount();
  const tycho = mount({ initialProjects: "jasonbenn/tycho" });
  expect(tycho.host.querySelector(".dpp-live .dpp-dim")!.textContent).toBe("no live version known");
  expect([...tycho.host.querySelectorAll("[data-deploy-run]")].map((r) => r.getAttribute("data-deploy-run"))).toEqual(["r-tycho"]);
  tycho.unmount();
  const none = mount({ initialProjects: "" });
  expect(none.host.querySelector("[data-deploys-none-picked]")).not.toBeNull();
  none.unmount();
});

test("personal, cold cache: nothing stored and nothing answered draws the waiting frame", () => {
  seed({ rows: false });
  const { host, unmount } = mount();
  expect(host.querySelector("[aria-busy]")).not.toBeNull();
  expect(chips(host)).toHaveLength(0);
  unmount();
});

test("a team's page asks by team_id and draws its targets as before, with Personal in the picker", () => {
  seed({ personal: false });
  const { host, unmount } = mount();
  const reads = asked.filter((a) => ["deployTargets:view", "deployRefs:recentForTeam", "workflow_runs:shippingRuns", "checkouts:forTeam"].includes(a.fn));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((a) => a.args.team_id === TEAM && !("workspace" in a.args))).toBe(true);
  expect(asked.some((a) => a.fn === "repoIcons:forWorkspace")).toBe(false);
  expect(chips(host)).toHaveLength(0);
  expect([...host.querySelectorAll("[data-deploy-target]")].map((t) => t.getAttribute("data-deploy-target"))).toEqual(["web"]);
  expect(host.querySelector("[data-deploy-mine]")).not.toBeNull();
  expect(host.querySelector("[data-deploy-project]")).toBeNull();
  const picker = host.querySelector("[data-deploys-team]") as HTMLSelectElement;
  expect([...picker.options].map((o) => `${o.value}:${o.textContent}`)).toEqual([`${WS}:Personal`, `team:${TEAM}:Codecast`]);
  expect(picker.value).toBe(`team:${TEAM}`);
  unmount();
});

// pl-1077 polish 5: switching to a workspace opened hours ago painted its old counts, live deploy and merged runs for
// the seconds its first answer took.
test("a cache no page held live recently reads until the feeds answer: no targets, no count, no runs", () => {
  for (const liveAt of [null, NOW - 3 * H]) {
    seed({ personal: false, liveAt });
    const { host, unmount } = mount();
    expect(host.querySelector(".dpp[aria-busy]")).not.toBeNull();
    expect(host.querySelector("[data-deploy-target]")).toBeNull();
    expect(host.querySelector("[data-deploy-run]")).toBeNull();
    unmount();
  }
  // Held live a minute ago: the cache paints at once.
  seed({ personal: false, liveAt: Date.now() - 60_000 });
  const { host, unmount } = mount();
  expect(host.querySelector("[data-deploy-target]")).not.toBeNull();
  unmount();
});

test("a stopped run's long reason folds to three lines until Show all, and Show less folds it back", () => {
  seed();
  const review = `Review said: ${"the reviewer asked for changes. ".repeat(40)}`;
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({ shippingRuns: { ...s.shippingRuns, "r-dance": { ...run("r-dance", "/code/dance", NOW - H / 6, "Snap capture"), status: "failed", fail_reason: review } } } as any); // stopped 10 minutes ago: older stops fold into Quiet runs
  // jsdom lays nothing out: a folded reason reads as taller than its box, an open one as fitting.
  const proto = dom.window.HTMLElement.prototype as any;
  const had = [Object.getOwnPropertyDescriptor(proto, "scrollHeight"), Object.getOwnPropertyDescriptor(proto, "clientHeight")];
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return this.classList?.contains("dpp-run-detail-text") ? 400 : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return this.classList?.contains("dpp-run-detail-text") && this.hasAttribute("data-clamped") ? 54 : 400; } });
  try {
    const { host, unmount } = mount({ initialProjects: "jasonbenn/dance" });
    const detail = host.querySelector('[data-deploy-run="r-dance"] [data-deploy-run-detail]')!;
    expect(detail.textContent).toContain("Review said:");
    expect(detail.querySelector(".dpp-run-detail-text")!.hasAttribute("data-clamped")).toBe(true);
    const more = () => detail.querySelector("[data-deploy-run-detail-more]") as HTMLElement;
    expect(more().textContent).toBe("Show all");
    click(more());
    expect(detail.querySelector(".dpp-run-detail-text")!.hasAttribute("data-clamped")).toBe(false);
    expect(more().textContent).toBe("Show less");
    click(more());
    expect(detail.querySelector(".dpp-run-detail-text")!.hasAttribute("data-clamped")).toBe(true);
    unmount();
  } finally {
    for (const [i, k] of (["scrollHeight", "clientHeight"] as const).entries()) {
      if (had[i]) Object.defineProperty(proto, k, had[i]!);
      else delete proto[k];
    }
  }
});

test("personal: the projects last turned on open a bare address; a team page never reads, remembers or writes them", () => {
  seed({ saved: { "deploys-projects": "projects=jasonbenn%2Fdance" } });
  const own = mount();
  expect(chips(own.host).filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.getAttribute("data-deploy-project-chip"))).toEqual(["jasonbenn/dance"]);
  own.unmount();
  seed({ personal: false, saved: { "deploys-projects": "projects=jasonbenn%2Fdance" } });
  window.history.replaceState(null, "", "/deploys?projects=jasonbenn%2Fsit");
  const team = mount({ initialProjects: "jasonbenn/sit" });
  click(team.host.querySelector('[data-deploy-view="prs"]'));
  expect(new URL(window.location.href).searchParams.get("show")).toBe("prs");
  expect(remembered).toEqual([{ page: "deploys", show: "prs", mine: null }]);
  expect([...team.host.querySelectorAll("[data-deploy-target]")].map((t) => t.getAttribute("data-deploy-target"))).toEqual(["web"]);
  team.unmount();
  window.history.replaceState(null, "", "/deploys");
  const bare = mount();
  click(bare.host.querySelector('[data-deploy-view="tasks"]'));
  expect(window.location.search).toBe("?show=tasks");
  bare.unmount();
});

test("personal: one project with two targets draws them together under its name, untagged", () => {
  seed();
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({ teamDeploys: { ...s.teamDeploys, "dp-14": deploy("dp-14", "jasonbenn/sit", "live", NOW - 5 * H, { target: "web" }) } } as any);
  const { host, unmount } = mount({ initialProjects: "jasonbenn/sit" });
  expect(host.querySelector("[data-deploy-pane]")!.getAttribute("data-deploy-pane")).toBe("projects");
  expect(host.querySelector("[data-deploy-heading]")!.textContent).toBe("sit");
  expect(cardIds(host)).toEqual(["dp-14", "dp-11", "dp-10"]);
  expect(host.querySelector("[data-deploy-project]")).toBeNull();
  expect([...host.querySelectorAll("[data-deploy-run]")].map((r) => r.getAttribute("data-deploy-run"))).toEqual(["r-sit"]);
  // Each target's own live deploy reads Live now.
  expect([...host.querySelectorAll('[data-deploy-state="Live now"]')].map((e) => e.closest("[data-deploy-card]")!.getAttribute("data-deploy-card"))).toEqual(["dp-14", "dp-11"]);
  unmount();
});
