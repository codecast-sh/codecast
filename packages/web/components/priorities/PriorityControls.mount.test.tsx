// The person's controls over their priorities, mounted in jsdom over the
// store (the list reads the `priorities` collection, the page its detail) with
// the store's dispatch captured. Proves, per control, that the press paints at
// once and rides dispatch to the override of the same name
// (convex/dispatch.ts): the row's ⋯ (Move up and down, Move to #, Mark done,
// Set aside, Restore, Merge into… behind its review, Correct…), each
// milestone's ⋯ (Done, Rename in place, Move to polish, Drop… behind its
// review, Correct…) and its gutter toggle, each session's ⋯ (Not this
// milestone, Not this priority, Move to…), a drag of the rank, and the page's
// Correct… and correction delete. Rank provenance reads once per surface. A
// teammate's priority shows no write control anywhere.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityControls.mount.test.tsx
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

// What a refusal tells the person (the writes report it as a toast).
const toasts: string[] = [];
const realSonner = { ...(await import("sonner")) };
const fakeToast = Object.assign((m: unknown) => { toasts.push(String(m)); }, realSonner.toast, { error: (m: unknown) => { toasts.push(String(m)); } });
mock.module("sonner", () => ({ ...realSonner, toast: fakeToast }));
afterAll(() => mock.module("sonner", () => realSonner));

const React = await import("react");
const { act } = React as any;
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { PrioritiesView } = await import("./PrioritiesPage");
const { default: PriorityPage } = await import("./PriorityPage");
const { PriorityCard } = await import("./PriorityRef");
const { usePriorities } = await import("../../hooks/usePriorities");
const { lastDays, readFilters } = await import("../../lib/priorityList");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const days = lastDays(10, NOW);
const MATE = fixtureId("teammate");

const step = (key: string, title: string, tier: "critical" | "polish", done = false) => ({ key, title, tier, tier_set_by: "pass", refs: [], done });
const sess = (tag: string, title: string, state: string, extra: Record<string, unknown> = {}) => ({
  short_id: `jx7${tag}`.slice(0, 7), conversation_id: fixtureId(tag), title, state, mine: true, workflow: false, why: ["mapped"], last_active_at: NOW - HOUR, ...extra,
});
const links = (key: string, sessions: unknown[], extra: Record<string, unknown> = {}) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false, ...extra });
const counts = (steps: any[]) => ({ critical_done: steps.filter((s) => s.tier === "critical" && s.done).length, critical_total: steps.filter((s) => s.tier === "critical").length });
const base = { summary: "", person_pos: null, rank_source: "ai", serves: null, workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", mine: true, first_seen_at: NOW - 3 * DAY, last_active_at: NOW, done_at: null, session_count: 1, session_count_more: false, status: "active", status_set_by: "pass", correction_pending: false, plan: null };
const row = (id: number, title: string, rank: number, steps: any[], extra: Record<string, unknown> = {}) => ({
  ...base, _id: fixtureId(`pri${id}`), short_id: `pri-${id}`, title, rank, ai_rank: rank, steps, counts: counts(steps), sessions: [], links: steps.map((s) => links(s.key, [])), ...extra,
});

const FEED = sess("feed01", "Eval feed redesign", "dormant");
const rows = () => [
  row(1, "Cam's eval requests flow", 1, [step("s1", "Work the open eval requests", "critical"), step("s2", "Change request flow design", "critical")], {
    sessions: [{ short_id: FEED.short_id, title: FEED.title, step_key: "s1", updated_at: NOW - HOUR }],
    links: [links("s1", [FEED]), links("s2", [])],
  }),
  row(2, "One simple ship flow", 2, [step("s1", "Auto-deploy from main", "critical"), step("p1", "Deploy notes", "polish")]),
  row(3, "Cut eval spend", 3, [step("s1", "Deploy drops the eval job", "critical")]),
  row(4, "Sam's own priority", 1, [step("s1", "Sam's milestone", "critical")], {
    user_id: MATE, owner: "Sam Teammate", mine: false, session_count: 1,
    links: [links("s1", [sess("samses", "Sam's session", "dormant", { mine: false })])],
  }),
  row(5, "An old set-aside one", 0, [step("s1", "Old", "critical")], { status: "set_aside", rank: null, ai_rank: null }),
];

let calls: Array<[string, unknown[]]> = [];
beforeEach(() => {
  calls = [];
  const st = useInboxStore.getState() as any;
  st._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; });
  st.syncTable("priorities", rows());
});
afterAll(() => (useInboxStore.getState() as any)._clearRuntimeBindings?.());

const FILTERS = { ...readFilters(new URLSearchParams()), mine: false, hideDone: false };
/** The list as /priorities draws it, read from the store so each paint shows. */
function Live({ layout = "wide" }: { layout?: "wide" | "phone" }) {
  const live = usePriorities();
  return <PrioritiesView rows={live} history={{ days, lanes: [] } as any} now={NOW} layout={layout} filters={FILTERS} onFilters={() => {}} compact={false} onCompact={() => {}} />;
}
const mount = (node: React.ReactNode) => mountSurface(<MemoryRouter initialEntries={["/priorities"]}>{node}</MemoryRouter>);

const stored = (id: string) => (Object.values(useInboxStore.getState().priorities) as any[]).find((r) => r.short_id === id);
const block = (id: string) => document.querySelector(`li[data-priority="${id}"]`) as HTMLElement;
const line = (id: string, key: string) => block(id).querySelector(`li[data-milestone="${key}"]`) as HTMLElement;
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true })); });
const press = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const item = (sel: string) => document.querySelector(`[role="menuitem"]${sel}`) as HTMLElement;
async function choose(trigger: Element, sel: string) {
  await key(trigger, "Enter");
  const it = item(sel);
  expect(it).not.toBeNull();
  await press(it);
  await tick();
}
async function openSub(trigger: Element, sub: string) {
  await key(trigger, "Enter");
  await press(item(sub));
  await tick();
}
const dispatched = async (name: string) => {
  for (let i = 0; i < 50 && !calls.some(([a]) => a === name); i++) await tick();
  return calls.filter(([a]) => a === name).map(([, args]) => args);
};
const priorityMenu = (id: string) => block(id).querySelector(`[data-priority-menu="${id}"]`)!;
const ranks = () => [...document.querySelectorAll("li[data-priority]")].filter((li) => li.getAttribute("data-status") === "active").map((li) => `${li.getAttribute("data-priority")}#${li.querySelector("[data-rank-source]")?.textContent}`);

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  await act(async () => { el.value = text; el.dispatchEvent(new window.Event("input", { bubbles: true })); });
}

test("the row's ⋯ says who placed it, and Move down, Move up and Move to # paint the order and ride movePriority", async () => {
  const page = await mount(<Live />);
  try {
    expect(ranks().slice(0, 3)).toEqual(["pri-1#1", "pri-2#2", "pri-3#3"]);
    await key(priorityMenu("pri-1"), "Enter");
    expect(document.querySelector("[data-menu-rank-by]")?.textContent).toBe("#1 · ranked by AI");
    expect(block("pri-1").querySelector("[data-rank-source]")!.getAttribute("title")).toBe("#1 · ranked by AI. Drag to move, or use the arrow keys.");
    await press(item('[data-act="move-down"]'));
    await tick();
    expect(ranks().slice(0, 3)).toEqual(["pri-2#1", "pri-1#2", "pri-3#3"]);
    expect(await dispatched("movePriority")).toEqual([["pri-1", "down"]]);
    // Placed by the person now: the row says so.
    expect(block("pri-1").querySelector("[data-rank-source]")!.getAttribute("data-rank-source")).toBe("person");
    await choose(priorityMenu("pri-1"), '[data-act="move-up"]');
    expect(ranks().slice(0, 3)).toEqual(["pri-1#1", "pri-2#2", "pri-3#3"]);
    await openSub(priorityMenu("pri-1"), '[data-act="move-to"]');
    expect([...document.querySelectorAll("[data-move-to]")].map((n) => n.textContent)).toEqual(["#1(now)", "#2", "#3"]);
    await press(item('[data-move-to="3"]'));
    await tick();
    expect(ranks().slice(0, 3)).toEqual(["pri-2#1", "pri-3#2", "pri-1#3"]);
    expect(await dispatched("movePriority")).toEqual([["pri-1", "down"], ["pri-1", "up"], ["pri-1", 3]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a drag of the rank number drops the priority where it is let go, and rides movePriority", async () => {
  const page = await mount(<Live />);
  try {
    const handle = block("pri-3").querySelector("[data-rank-handle]")!;
    const dragEvent = (type: string) => Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), { dataTransfer: { setData() {}, effectAllowed: "", dropEffect: "" }, clientY: 0 });
    await act(async () => { handle.dispatchEvent(dragEvent("dragstart")); });
    expect(block("pri-3").getAttribute("data-dragging")).toBe("true");
    await act(async () => { block("pri-1").dispatchEvent(dragEvent("dragover")); });
    expect(block("pri-1").querySelector("[data-drop-at]")?.getAttribute("data-drop-at")).toBe("before");
    await act(async () => { block("pri-1").dispatchEvent(dragEvent("drop")); });
    expect(ranks().slice(0, 3)).toEqual(["pri-3#1", "pri-1#2", "pri-2#3"]);
    expect(await dispatched("movePriority")).toEqual([["pri-3", 1]]);
    expect(document.querySelector("[data-drop-at]")).toBeNull();
    // The arrow keys step the focused rank.
    await key(block("pri-3").querySelector("[data-rank-handle]")!, "ArrowDown");
    expect(ranks().slice(0, 3)).toEqual(["pri-1#1", "pri-3#2", "pri-2#3"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Mark done, Set aside and Restore paint the row's status and ride their overrides", async () => {
  const page = await mount(<Live />);
  try {
    await choose(priorityMenu("pri-3"), '[data-act="mark-done"]');
    expect(block("pri-3").getAttribute("data-status")).toBe("done");
    expect([stored("pri-3").status_set_by, stored("pri-3").ai_rank]).toEqual(["person", null]);
    expect(await dispatched("markPriorityDone")).toEqual([["pri-3"]]);
    await choose(priorityMenu("pri-2"), '[data-act="set-aside"]');
    expect(block("pri-2").getAttribute("data-status")).toBe("set_aside");
    expect(await dispatched("setPriorityAside")).toEqual([["pri-2"]]);
    await choose(priorityMenu("pri-5"), '[data-act="restore"]');
    expect(block("pri-5").getAttribute("data-status")).toBe("active");
    expect(await dispatched("restorePriority")).toEqual([["pri-5"]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Merge into… picks one of the person's other active priorities, asks first, then paints the merge and rides mergePriority", async () => {
  const page = await mount(<Live />);
  try {
    await openSub(priorityMenu("pri-3"), '[data-act="merge"]');
    // The person's own active priorities only: never a teammate's or a set-aside one.
    expect([...document.querySelectorAll("[data-merge-into]")].map((n) => n.getAttribute("data-merge-into"))).toEqual(["pri-1", "pri-2"]);
    await press(item('[data-merge-into="pri-2"]'));
    await page.waitFor(() => !!document.querySelector('[data-switch-review="Merge priority"]'));
    // Nothing happened yet: the review stands between the press and the merge.
    expect(stored("pri-3").status).toBe("active");
    expect(calls.some(([a]) => a === "mergePriority")).toBe(false);
    const confirm = [...document.querySelectorAll('[data-switch-review] button')].find((b) => b.textContent?.trim().startsWith("Merge")) as HTMLElement;
    await press(confirm);
    await tick();
    expect(block("pri-3")).toBeNull();
    expect(stored("pri-2").steps.map((s: any) => s.title)).toEqual(["Auto-deploy from main", "Deploy notes", "Deploy drops the eval job"]);
    expect(await dispatched("mergePriority")).toEqual([["pri-3", "pri-2"]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Correct… on a row saves the text, marks it correction pending, and rides correctPriority", async () => {
  const page = await mount(<Live />);
  try {
    expect(block("pri-2").querySelector("[data-correction-pending]")).toBeNull();
    await choose(priorityMenu("pri-2"), '[data-act="correct"]');
    await page.waitFor(() => !!document.querySelector("[data-correct-popover]"));
    const box = document.querySelector("[data-correct-text]") as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("What did it get wrong?");
    expect(document.querySelector("[data-correct-popover]")!.textContent).toContain("The next pass keeps this.");
    await typeInto(box, "  The ship flow is two priorities, not one  ");
    await press(document.querySelector("[data-correct-save]")!);
    await tick();
    expect(block("pri-2").querySelector("[data-correction-pending]")).not.toBeNull();
    expect(await dispatched("correctPriority")).toEqual([["pri-2", "The ship flow is two priorities, not one", null, expect.any(String)]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a milestone's ⋯: Done, Rename in place, Move to polish and Correct… paint at once and ride their overrides", async () => {
  const page = await mount(<Live />);
  try {
    const menu = () => line("pri-3", "s1").querySelector('[data-milestone-menu="s1"]')!;
    await choose(menu(), '[data-act="step-done"]');
    expect(stored("pri-3").steps[0].done).toBe(true);
    expect(block("pri-3").querySelector("[data-progress]")?.textContent).toBe("1/1");
    expect(await dispatched("setPriorityStepDone")).toEqual([["pri-3", "s1", true]]);

    const ship = () => line("pri-2", "s1").querySelector('[data-milestone-menu="s1"]')!;
    await choose(ship(), '[data-act="rename"]');
    await page.waitFor(() => !!line("pri-2", "s1").querySelector("[data-rename-input]"));
    const input = line("pri-2", "s1").querySelector("[data-rename-input]") as HTMLInputElement;
    await typeInto(input, "Auto-deploy every green main");
    await key(input, "Enter");
    expect(line("pri-2", "s1").textContent).toContain("Auto-deploy every green main");
    expect(await dispatched("renamePriorityStep")).toEqual([["pri-2", "s1", "Auto-deploy every green main"]]);

    await choose(ship(), '[data-act="tier"]');
    expect(stored("pri-2").steps[0].tier).toBe("polish");
    expect(await dispatched("setPriorityStepTier")).toEqual([["pri-2", "s1", "polish"]]);

    await choose(line("pri-1", "s2").querySelector('[data-milestone-menu="s2"]')!, '[data-act="correct"]');
    await page.waitFor(() => !!document.querySelector("[data-correct-text]"));
    await typeInto(document.querySelector("[data-correct-text]") as HTMLTextAreaElement, "This is the flow design, not the requests");
    await press(document.querySelector("[data-correct-save]")!);
    await tick();
    expect(line("pri-1", "s2").querySelector("[data-correction-pending]")).not.toBeNull();
    expect(await dispatched("correctPriority")).toEqual([["pri-1", "This is the flow design, not the requests", "s2", expect.any(String)]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Drop… asks first, then the milestone leaves the row and rides dropPriorityStep", async () => {
  const page = await mount(<Live />);
  try {
    await choose(line("pri-1", "s2").querySelector('[data-milestone-menu="s2"]')!, '[data-act="drop"]');
    await page.waitFor(() => !!document.querySelector('[data-switch-review="Drop milestone"]'));
    expect(line("pri-1", "s2")).not.toBeNull();
    const confirm = [...document.querySelectorAll('[data-switch-review] button')].find((b) => b.textContent?.trim().startsWith("Drop")) as HTMLElement;
    await press(confirm);
    await tick();
    expect(line("pri-1", "s2")).toBeNull();
    expect(stored("pri-1").counts).toEqual({ critical_done: 0, critical_total: 1 });
    expect(await dispatched("dropPriorityStep")).toEqual([["pri-1", "s2"]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the milestone's whole left gutter toggles Done, a 44px target on a phone", async () => {
  const page = await mount(<Live layout="phone" />);
  try {
    const toggle = line("pri-2", "s1").querySelector('[data-milestone-toggle="s1"]') as HTMLElement;
    expect(toggle.className).toContain("h-[52px]");
    expect(toggle.className).toContain("-ml-[30px]");
    await press(toggle);
    expect(stored("pri-2").steps[0].done).toBe(true);
    // The press toggles Done, never the line's expansion.
    expect(line("pri-2", "s1").querySelector("[data-milestone-detail]")).toBeNull();
    await press(line("pri-2", "s1").querySelector('[data-milestone-toggle="s1"]')!);
    expect(stored("pri-2").steps[0].done).toBe(false);
    expect(await dispatched("setPriorityStepDone")).toEqual([["pri-2", "s1", true], ["pri-2", "s1", false]]);
    // Every ⋯ on the phone is always shown and 44px.
    for (const b of document.querySelectorAll("[data-priority-menu], [data-milestone-menu]")) {
      expect(b.className).toContain("size-11");
      expect(b.className).not.toContain("opacity-0");
    }
    // The box sits by the title's first line, not the middle of a title that wraps or carries its marks under it:
    // the line starts its parts at the top, and the press area rises 8px and draws the box 15px down, beside the first line.
    expect(line("pri-2", "s1").querySelector("[data-line-title]")!.className).toContain("items-start");
    for (const c of ["-mt-2", "items-start", "pt-[15px]"]) expect(toggle.className.split(" ")).toContain(c);
  } finally {
    await page.unmount();
  }
  // A wide line starts its parts at the top on every pointer, so a title that wraps grows downward with the box by its first line;
  // Daylight (wide, coarse pointer) also draws the tall press area.
  const wide = await mount(<Live />);
  try {
    const title = line("pri-2", "s1").querySelector("[data-line-title]")!;
    expect(title.className.split(" ")).toContain("items-start");
    expect(title.querySelector("[data-milestone-toggle]")!.className).toContain("[@media(pointer:coarse)]:-mt-2 [@media(pointer:coarse)]:-mb-4 [@media(pointer:coarse)]:h-[52px]");
  } finally {
    await wide.unmount();
  }
}, 60_000);

test("a session's ⋯: Not this milestone, Move to… and Not this priority paint and ride their overrides", async () => {
  const page = await mount(<Live />);
  try {
    const open = async () => {
      await press(line("pri-1", "s1").querySelector('[role="button"]')!);
      await page.waitFor(() => !!line("pri-1", "s1").querySelector("[data-milestone-detail]"));
    };
    await open();
    const sessionMenu = () => line("pri-1", "s1").querySelector(`[data-session-menu="${FEED.short_id}"]`)!;
    await openSub(sessionMenu(), '[data-act="move-session"]');
    expect([...document.querySelectorAll("[data-move-session-to]")].map((n) => n.getAttribute("data-move-session-to"))).toEqual(["pri-1/s2"]);
    expect([...document.querySelectorAll("[data-move-session-priority]")].map((n) => n.getAttribute("data-move-session-priority"))).toEqual(["pri-2", "pri-3"]);
    await press(item('[data-move-session-to="pri-1/s2"]'));
    await tick();
    expect(stored("pri-1").links.map((l: any) => [l.key, l.sessions.map((s: any) => s.short_id)])).toEqual([["s1", []], ["s2", [FEED.short_id]]]);
    expect(stored("pri-1").sessions[0]).toMatchObject({ short_id: FEED.short_id, step_key: "s2", set_by_person: true });
    expect(await dispatched("movePrioritySession")).toEqual([[FEED.short_id, "pri-1", "pri-1", "s2"]]);

    await press(line("pri-1", "s2").querySelector('[role="button"]')!);
    await page.waitFor(() => !!line("pri-1", "s2").querySelector("[data-milestone-detail]"));
    await choose(line("pri-1", "s2").querySelector(`[data-session-menu="${FEED.short_id}"]`)!, '[data-act="not-milestone"]');
    expect(stored("pri-1").links.every((l: any) => l.sessions.length === 0)).toBe(true);
    expect(stored("pri-1").sessions[0].step_key).toBeNull();
    expect((await dispatched("movePrioritySession")).at(-1)).toEqual([FEED.short_id, "pri-1", "pri-1", null]);

    // Back on a milestone, then off the priority.
    useInboxStore.getState().syncTable("priorities", rows() as any);
    await page.waitFor(() => stored("pri-1").links[0].sessions.length === 1 && !!line("pri-1", "s1"));
    if (!line("pri-1", "s1").querySelector("[data-milestone-detail]")) await open();
    await page.waitFor(() => !!sessionMenu());
    await choose(sessionMenu(), '[data-act="not-priority"]');
    expect(stored("pri-1").sessions).toEqual([]);
    expect(stored("pri-1").session_count).toBe(0);
    expect(await dispatched("prioritySessionNotThis")).toEqual([[FEED.short_id, "pri-1"]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a teammate's priority shows no write control: no toggles, no milestone or session ⋯, a menu of Copy link alone", async () => {
  const page = await mount(<Live />);
  try {
    const mate = block("pri-4");
    expect(mate.querySelector("[data-milestone-toggle]")).toBeNull();
    expect(mate.querySelector("[data-milestone-menu]")).toBeNull();
    expect(mate.querySelector("[data-rank-handle]")).toBeNull();
    await press(mate.querySelector('li[data-milestone="s1"] [role="button"]')!);
    await page.waitFor(() => !!mate.querySelector("[data-milestone-detail]"));
    expect(mate.querySelector("[data-session-row]")).not.toBeNull();
    expect(mate.querySelector("[data-session-menu]")).toBeNull();
    await key(priorityMenu("pri-4"), "Enter");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute("data-act"))).toEqual(["copy-link"]);
    // A rank is the viewer's own order: a teammate's priority has none, in its menu or its rank cell.
    expect(document.querySelector("[data-menu-rank-by]")).toBeNull();
    expect(mate.querySelector("[data-rank-source]")).toBeNull();
  } finally {
    await page.unmount();
  }
  // On the list, wide and phone, a teammate's milestone is a status mark, never a checkbox.
  for (const layout of ["wide", "phone"] as const) {
    const list = await mount(<Live layout={layout} />);
    try {
      const mate = block("pri-4");
      expect(mate.querySelector('li[data-milestone="s1"] [data-milestone-mark="open"]')).not.toBeNull();
      expect(mate.querySelector('[aria-label="Open"]:not([data-milestone-mark]), [aria-label="Done"]:not([data-milestone-mark])')).toBeNull();
    } finally {
      await list.unmount();
    }
  }
}, 60_000);

const DETAIL = (over: Record<string, unknown> = {}) => {
  const r = rows()[1];
  return {
    ...r, steps: r.steps.map((s) => ({ ...s, sessions: [] })), other_sessions: [], correction_pending: true,
    corrections: [{ _id: fixtureId("corr1"), step_key: null, text: "Deploy notes are polish", status: "pending", created_at: NOW - DAY }],
    ...over,
  };
};
const inRouter = (node: React.ReactNode) => mountSurface(<MemoryRouter initialEntries={["/priorities/pri-2"]}>{node}</MemoryRouter>);

test("the page: Correct… beside Share writes a correction that lists at once; a correction's delete takes it off and the pending mark with it", async () => {
  answers["priorities:show"] = DETAIL();
  answers["priorities:history"] = { days, lanes: [] };
  const page = await inRouter(<PriorityPage id="pri-2" />);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-corrections]"));
    expect(page.container.querySelector("[data-rank-by]")?.textContent).toBe("ranked by AI");
    await press(page.container.querySelector("[data-correct-priority]")!);
    await page.waitFor(() => !!document.querySelector("[data-correct-text]"));
    await typeInto(document.querySelector("[data-correct-text]") as HTMLTextAreaElement, "Notes belong to the deploy milestone");
    await press(document.querySelector("[data-correct-save]")!);
    await tick();
    const listed = () => [...page.container.querySelectorAll("[data-correction]")].map((n) => n.textContent);
    expect(listed()[0]).toContain("Notes belong to the deploy milestone");
    expect(await dispatched("correctPriority")).toEqual([["pri-2", "Notes belong to the deploy milestone", null, expect.any(String)]]);
    // The one still on its way deletes by its local id (the server finds it by its client key), as the stored one does by its own.
    const pending = [...page.container.querySelectorAll("[data-delete-correction]")].map((n) => n.getAttribute("data-delete-correction")!);
    expect(pending).toHaveLength(2);
    const local = pending.find((id) => id.startsWith("local-correction-"))!;
    expect(local).toBeDefined();
    await press(page.container.querySelector(`[data-delete-correction="${fixtureId("corr1")}"]`)!);
    expect(listed().some((t) => t?.includes("Deploy notes are polish"))).toBe(false);
    await press(page.container.querySelector(`[data-delete-correction="${local}"]`)!);
    expect(listed().some((t) => t?.includes("Notes belong to the deploy milestone"))).toBe(false);
    expect(await dispatched("deletePriorityCorrection")).toEqual([[fixtureId("corr1")], [local]]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the page: a milestone's box and ⋯ write as on the list, and the header's ⋯ holds the priority's controls", async () => {
  answers["priorities:show"] = DETAIL();
  const page = await inRouter(<PriorityPage id="pri-2" />);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-critical-path]"));
    await press(page.container.querySelector('[data-critical-path] [data-milestone-toggle="s1"]')!);
    expect(stored("pri-2").steps[0].done).toBe(true);
    expect(page.container.querySelector("[data-critical-path]")!.textContent).toContain("Landed");
    expect(await dispatched("setPriorityStepDone")).toEqual([["pri-2", "s1", true]]);
    await choose(page.container.querySelector('[data-polish-list] [data-milestone-menu="p1"]')!, '[data-act="tier"]');
    expect(page.container.querySelector("[data-polish-list]")).toBeNull();
    expect(await dispatched("setPriorityStepTier")).toEqual([["pri-2", "p1", "critical"]]);
    await key(page.container.querySelector('[data-priority-menu="pri-2"]')!, "Enter");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute("data-act"))).toEqual(["move-up", "move-down", "move-to", "mark-done", "set-aside", "merge", "correct", "copy-link"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the page and the card of a teammate's priority show no write control", async () => {
  answers["priorities:show"] = { ...DETAIL(), ...rows()[3], steps: rows()[3].steps.map((s) => ({ ...s, sessions: [] })), corrections: [], other_sessions: [] };
  const page = await inRouter(<PriorityPage id="pri-4" />);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-critical-path]"));
    for (const sel of ["[data-correct-priority]", "[data-milestone-toggle]", "[data-milestone-menu]", "[data-delete-correction]"]) expect(page.container.querySelector(sel)).toBeNull();
    // An active priority with no rank shows no badge, never "Set aside".
    const meta = page.container.querySelector("[data-priority-meta]")!;
    expect(meta.querySelector("[data-rank]")).toBeNull();
    expect(meta.querySelector("[data-rank-by]")).toBeNull();
    expect(meta.textContent).not.toContain("Set aside");
    // Each milestone is a status mark, not a box that looks pressable.
    expect(page.container.querySelector('[data-critical-path] [data-milestone="s1"] [data-milestone-mark="open"]')).not.toBeNull();
    expect(page.container.querySelector('[data-critical-path] [aria-label="Open"]:not([data-milestone-mark])')).toBeNull();
  } finally {
    await page.unmount();
  }
  const card = await mount(<PriorityCard row={stored("pri-4")} />);
  try {
    expect(card.container.querySelector("[data-milestone-toggle]")).toBeNull();
  } finally {
    await card.unmount();
  }
}, 60_000);

test("the card: provenance once, and the owner marks its Next milestone done from it", async () => {
  const card = await mount(<PriorityCard row={stored("pri-3")} />);
  try {
    expect(card.text()).toContain("#3 ranked by AI");
    await press(card.container.querySelector('[data-milestone-toggle="s1"]')!);
    expect(stored("pri-3").steps[0].done).toBe(true);
    expect(await dispatched("setPriorityStepDone")).toEqual([["pri-3", "s1", true]]);
  } finally {
    await card.unmount();
  }
}, 60_000);

test("on a phone the row's correction pending sits on the meta line, so the title keeps its width", async () => {
  useInboxStore.getState().syncTable("priorities", [{ ...stored("pri-2"), correction_pending: true }] as any, { isDelta: true });
  const phone = await mount(<Live layout="phone" />);
  try {
    const mark = block("pri-2").querySelector("[data-correction-pending]")!;
    expect(mark.closest("[data-meta]")).not.toBeNull();
  } finally {
    await phone.unmount();
  }
  const wide = await mount(<Live />);
  try {
    expect(block("pri-2").querySelector("[data-correction-pending]")!.closest("[data-meta]")).toBeNull();
  } finally {
    await wide.unmount();
  }
}, 60_000);

test("on the desktop grid each ⋯ keeps its 24px look and a coarse pointer presses 44px; lines and the Done toggle make room for it", async () => {
  const page = await mount(<Live />);
  try {
    for (const b of [priorityMenu("pri-1"), line("pri-1", "s1").querySelector('[data-milestone-menu="s1"]')!]) {
      expect(b.className).toContain("size-6");
      expect(b.className).toContain("[@media(pointer:coarse)]:after:-inset-2.5");
      // Always shown where a finger points, as where nothing hovers.
      if (b.hasAttribute("data-milestone-menu")) {
        expect(b.className).toContain("[@media(hover:none)]:opacity-100");
        expect(b.className).toContain("[@media(pointer:coarse)]:opacity-100");
      }
    }
    expect(line("pri-1", "s1").querySelector('[role="button"]')!.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(line("pri-1", "s1").querySelector("[data-milestone-toggle]")!.className).toContain("[@media(pointer:coarse)]:h-[52px]");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a refused write takes back only what it painted, keeps a server push that landed meanwhile, and says why", async () => {
  let refuse: (e: Error) => void = () => {};
  (useInboxStore.getState() as any)._setDispatch((action: string, args: unknown[]) => {
    calls.push([action, args]);
    return new Promise((_, reject) => { refuse = reject; });
  });
  toasts.length = 0;
  const page = await mount(<Live />);
  try {
    await press(line("pri-3", "s1").querySelector('[data-milestone-toggle="s1"]')!);
    expect(stored("pri-3").steps[0].done).toBe(true);
    await dispatched("setPriorityStepDone");
    // A push from the server (a pass, another window) lands on another row before the refusal.
    useInboxStore.getState().syncTable("priorities", [{ ...stored("pri-2"), title: "One ship flow, renamed by the pass" }] as any, { isDelta: true });
    await tick();
    await act(async () => { refuse(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught Error: pri-3 is Sam's priority; only they can change it")); });
    await page.waitFor(() => stored("pri-3").steps[0].done === false && block("pri-3").querySelector("[data-progress]")?.textContent === "0/1" && toasts.length > 0);
    expect(stored("pri-3").steps[0].done).toBe(false);
    expect(block("pri-3").querySelector("[data-progress]")?.textContent).toBe("0/1");
    expect(stored("pri-2").title).toBe("One ship flow, renamed by the pass");
    expect(block("pri-2").textContent).toContain("One ship flow, renamed by the pass");
    expect(toasts).toEqual(["pri-3 is Sam's priority; only they can change it"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Looks done? is the owner's button: it marks the milestone done through setPriorityStepDone, and a refusal puts it back", async () => {
  useInboxStore.getState().syncTable("priorities", [{ ...stored("pri-3"), links: [links("s1", [], { looks_done: true })] }] as any, { isDelta: true });
  let refuse: (e: Error) => void = () => {};
  (useInboxStore.getState() as any)._setDispatch((action: string, args: unknown[]) => {
    calls.push([action, args]);
    return new Promise((_, reject) => { refuse = reject; });
  });
  toasts.length = 0;
  const page = await mount(<Live />);
  try {
    const looks = line("pri-3", "s1").querySelector("[data-looks-done]") as HTMLElement;
    expect(looks.tagName).toBe("BUTTON");
    // The press itself is 44px under a coarse pointer; the pill inside is the look.
    for (const c of ["[@media(pointer:coarse)]:min-h-11", "[@media(pointer:coarse)]:min-w-11"]) expect(looks.className).toContain(c);
    expect(looks.querySelector("span")!.className).toContain("rounded-full");
    await press(looks);
    expect(stored("pri-3").steps[0].done).toBe(true);
    // The press marks it done; it never opens the line.
    expect(line("pri-3", "s1").querySelector("[data-milestone-detail]")).toBeNull();
    expect(await dispatched("setPriorityStepDone")).toEqual([["pri-3", "s1", true]]);
    await act(async () => { refuse(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught Error: pri-3 changed under you")); });
    await page.waitFor(() => stored("pri-3").steps[0].done === false && toasts.length > 0);
    expect(toasts).toEqual(["pri-3 changed under you"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Drop and Merge count linked sessions the same way, from the links; Drop says the sessions stay on the priority", async () => {
  // pri-1: the feed session on s1 with two more s1 counts but does not carry, and the same session again on s2.
  useInboxStore.getState().syncTable("priorities", [{ ...stored("pri-1"), session_count: 9, links: [links("s1", [FEED], { sessions_more: 2 }), links("s2", [FEED])] }] as any, { isDelta: true });
  const page = await mount(<Live />);
  try {
    await choose(line("pri-1", "s1").querySelector('[data-milestone-menu="s1"]')!, '[data-act="drop"]');
    await page.waitFor(() => !!document.querySelector('[data-switch-review="Drop milestone"]'));
    const drop = document.querySelector('[data-switch-review="Drop milestone"]')!.textContent!;
    expect(drop).toContain("3linked sessions");
    expect(drop).toContain("Stay on the priority, without that milestone");
    // The keyboard hints (esc, ⌘↵) are gone under a coarse pointer.
    const keys = [...document.querySelectorAll("[data-switch-review] [data-switch-keys]")];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.className).toContain("[@media(pointer:coarse)]:hidden");
    await press([...document.querySelectorAll("[data-switch-review] button")].find((b) => b.textContent?.trim().startsWith("Cancel")) as HTMLElement);
    await page.waitFor(() => !document.querySelector("[data-switch-review]"));
    await openSub(priorityMenu("pri-1"), '[data-act="merge"]');
    await press(item('[data-merge-into="pri-2"]'));
    await page.waitFor(() => !!document.querySelector('[data-switch-review="Merge priority"]'));
    // The feed session once across both milestones, plus the two s1 does not carry; never the server's session_count.
    expect(document.querySelector('[data-switch-review="Merge priority"]')!.textContent).toContain("3sessions move");
    // The confirm's buttons are 44px under a coarse pointer, as every confirm's are.
    for (const b of document.querySelectorAll("[data-switch-cancel], [data-switch-confirm]")) expect(b.className).toContain("[@media(pointer:coarse)]:h-11");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a push that changes only a milestone's looks done repaints its line", async () => {
  const page = await mount(<Live />);
  try {
    expect(line("pri-3", "s1").querySelector("[data-looks-done]")).toBeNull();
    await act(async () => { useInboxStore.getState().syncTable("priorities", [{ ...stored("pri-3"), links: [links("s1", [], { looks_done: true })] }] as any, { isDelta: true }); });
    await page.waitFor(() => !!line("pri-3", "s1").querySelector("[data-looks-done]"));
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Correct…'s Cancel and Save are 44px under a coarse pointer", async () => {
  const page = await mount(<Live />);
  try {
    await choose(priorityMenu("pri-2"), '[data-act="correct"]');
    await page.waitFor(() => !!document.querySelector("[data-correct-popover]"));
    for (const sel of ["[data-correct-cancel]", "[data-correct-save]"]) expect(document.querySelector(sel)!.className).toContain("[@media(pointer:coarse)]:h-11");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Move to… lists this priority's milestones under its name, polish after a separator; Merge into… and Move to… fit the screen, their names wrapping", async () => {
  const r1 = stored("pri-1");
  useInboxStore.getState().syncTable("priorities", [{ ...r1, steps: [...r1.steps, step("p1", "Request digest", "polish")], links: [...r1.links, links("p1", [])] }] as any, { isDelta: true });
  const page = await mount(<Live />);
  try {
    await press(line("pri-1", "s1").querySelector('[role="button"]')!);
    await page.waitFor(() => !!line("pri-1", "s1").querySelector("[data-milestone-detail]"));
    await openSub(line("pri-1", "s1").querySelector(`[data-session-menu="${FEED.short_id}"]`)!, '[data-act="move-session"]');
    const list = document.querySelector('[data-sub-list="move-session"]')!;
    const parts = [...list.children].map((n) => n.hasAttribute("data-move-here") ? `head:${n.textContent}` : n.hasAttribute("data-move-polish") ? "polish-sep" : n.getAttribute("data-move-session-to") ?? (n.getAttribute("role") === "separator" ? "sep" : n.querySelector("[data-move-session-priority]")?.getAttribute("data-move-session-priority") ?? n.getAttribute("data-move-session-priority") ?? n.tagName));
    expect(parts).toEqual(["head:Cam's eval requests flow", "pri-1/s2", "polish-sep", "pri-1/p1", "sep", "pri-2", "pri-3"]);
    // Never wider than the room beside its parent menu, and its names wrap rather than clip.
    expect(list.className).toContain("max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))]");
    expect(list.querySelector('[data-move-session-to="pri-1/p1"] span')!.className).toContain("whitespace-normal");
  } finally {
    await page.unmount();
  }
  const merge = await mount(<Live />);
  try {
    await openSub(priorityMenu("pri-3"), '[data-act="merge"]');
    const list = document.querySelector('[data-sub-list="merge"]')!;
    expect(list.className).toContain("max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))]");
    expect(list.querySelector("[data-merge-into] span:last-child")!.className).toContain("whitespace-normal");
  } finally {
    await merge.unmount();
  }
}, 60_000);
