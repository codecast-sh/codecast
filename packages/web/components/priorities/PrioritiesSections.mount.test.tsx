// /priorities across every workspace the viewer holds (lib/prioritySections,
// components/priorities/PrioritySections and PrioritiesToolbar), mounted in
// jsdom over the shared list fixtures. Proves: a section per workspace, the
// active one first, then by name; a chip per workspace that hides its section
// and is kept in the viewer's ui prefs; the header count over the sections
// shown; Group by's three groupings and where drag to rank works; Compact
// folds every priority to its head; and a teammate's priority reads like the
// viewer's own: ranks, faces, and Start on its milestones.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesSections.mount.test.tsx
import { afterEach, expect, test } from "bun:test";
import { describeFailures, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage } = await import("./PrioritiesPage");
const { ThemeContext } = await import("../ThemeProvider");
const { HISTORY, block, links, listOf, mount, order, row, sess, step, states, view } = await import("../../test-helpers/prioritiesList");
const { act } = React as any;

const OTHER_TEAM = "team-aardvark";
useInboxStore.getState().syncTable("teams", [
  { _id: TEAM_ID, name: "Degrade Co", role: "admin", features: { priorities: true } },
  { _id: OTHER_TEAM, name: "Aardvark", role: "member", icon: "rocket", features: { priorities: true } },
] as any);

const TEAM = `team:${TEAM_ID}`;
const AARD = `team:${OTHER_TEAM}`;
const PERSONAL = `user:${VIEWER_ID}`;
const mate = { mine: false, user_id: "user-sam", owner: "Sam Teammate", owner_image: null, person_pos: null, ai_rank: null, rank_source: null };

// The viewer: two in the active team, one in Aardvark, one personal. Sam: two in the active team, one in Aardvark.
const ROWS = [
  row(1, "Ship the redesign", 1, [step("s1", "Land it", "critical")], { links: [links("s1", [])] }),
  row(2, "Cut eval spend", 2, [step("s1", "Drop the job", "critical")], { links: [links("s1", [])] }),
  row(3, "Union launch", 1, [step("s1", "Pick a date", "critical")], { workspace: AARD, links: [links("s1", [])] }),
  row(4, "Wardrobe", 1, [step("s1", "Shop", "critical")], { workspace: PERSONAL, links: [links("s1", [])] }),
  row(5, "Sharded engine", 1, [step("s1", "Shadow mode", "critical"), step("s2", "Soak", "critical")], {
    ...mate,
    mapped_links: [links("s1", [sess("samwork", "Shadow mode run", "working", 0, { mine: false })]), links("s2", [])],
  }),
  row(6, "Meeting bots", 2, [step("s1", "Room kind", "critical")], { ...mate, mapped_links: [links("s1", [])] }),
  row(7, "Deploy pipeline", 1, [step("s1", "Release lane", "critical")], { ...mate, workspace: AARD, mapped_links: [links("s1", [])] }),
  row(8, "Old thing", null, [step("s1", "Done", "critical", true)], { ...mate, status: "set_aside" }),
];

const setView = (v: Record<string, unknown> | undefined) => useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, priorities_view: v } } }));
afterEach(() => setView(undefined));

const press = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const chips = (c: HTMLElement) => [...c.querySelectorAll("[data-workspace-chip]")].map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`);
const headings = (c: HTMLElement, attr: string) => [...c.querySelectorAll(`[${attr}] [data-heading-name]`)].map((h) => h.textContent);

test("a section per workspace, the active one first, then by name; chips hide a section and the choice is kept", async () => {
  const page = await mount(view({ rows: ROWS }));
  try {
    expect(describeFailures(page)).toBe("");
    expect(chips(page.container)).toEqual(["Degrade Co:true", "Aardvark:true", "Personal:true"]);
    expect(headings(page.container, "data-section-heading")).toEqual(["Degrade Co", "Aardvark", "Personal"]);
    // Within a workspace, the viewer first, then each teammate, each in rank order.
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-5", "pri-6", "pri-3", "pri-7", "pri-4"]);
    await press(page.container.querySelector(`[data-workspace-chip="${AARD}"]`)!);
    expect(chips(page.container)).toEqual(["Degrade Co:true", "Aardvark:false", "Personal:true"]);
    expect(page.container.querySelector(`[data-workspace-chip="${AARD}"]`)!.className).toContain("border-dashed");
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-5", "pri-6", "pri-4"]);
    // Kept as a list of the workspaces turned off, in the ui prefs that follow the viewer to every device.
    expect(useInboxStore.getState().clientState.ui?.priorities_view).toEqual({ hidden: [AARD] });
    await press(page.container.querySelector(`[data-workspace-chip="${AARD}"]`)!);
    expect(order(page.container)).toContain("pri-3");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a page holding one workspace has no chips and no section heading", async () => {
  const page = await mount(view({ rows: ROWS.filter((r) => r.workspace === TEAM) }));
  try {
    expect(page.container.querySelector("[data-workspace-chips], [data-section-heading]")).toBeNull();
    expect(page.container.querySelector("[data-group-by-picker]")).not.toBeNull();
  } finally {
    await page.unmount();
  }
  // The viewer alone: no Group by either, and no person labels.
  const solo = await mount(view({ rows: ROWS.filter((r) => r.workspace === TEAM && r.mine) }));
  try {
    expect(solo.container.querySelector("[data-group-by-picker], [data-person-label]")).toBeNull();
    expect(solo.container.querySelector("[data-compact-toggle]")).not.toBeNull();
  } finally {
    await solo.unmount();
  }
}, 60_000);

test("the header count counts the active priorities in the sections shown", async () => {
  answers["priorities:history"] = HISTORY;
  answers["priorities:list"] = listOf(ROWS);
  const page = await mount(
    <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any}><PrioritiesPage /></ThemeContext.Provider>,
  );
  const count = () => page.container.querySelector("[data-cc-page-count]")?.textContent;
  try {
    await page.waitFor(() => !!page.container.querySelector('li[data-priority="pri-7"]'));
    expect(count()).toBe("7");
    await press(page.container.querySelector(`[data-workspace-chip="${AARD}"]`)!);
    expect(count()).toBe("5");
  } finally {
    await page.unmount();
    answers["priorities:list"] = listOf([]);
  }
}, 60_000);

test("Group by: Workspace interleaves by rank with each owner's face; Person then workspace nests; drag only where ranks are one person's", async () => {
  const page = await mount(view({ rows: ROWS }));
  const c = page.container;
  try {
    expect(c.querySelector("[data-priorities]")!.getAttribute("data-group-by")).toBe("workspace_person");
    expect(block(c, "pri-1").querySelector("[data-rank-handle]")).not.toBeNull();
    expect(block(c, "pri-5").querySelector("[data-rank-handle]")).toBeNull();

    setView({ group_by: "workspace" });
    await act(async () => {});
    expect(c.querySelector("[data-priorities]")!.getAttribute("data-group-by")).toBe("workspace");
    // All the #1s, then the #2s, the viewer first within a rank.
    expect(order(c)).toEqual(["pri-1", "pri-5", "pri-2", "pri-6", "pri-3", "pri-7", "pri-4"]);
    expect(block(c, "pri-5").querySelector("[data-priority-face] [data-face]")!.getAttribute("data-face")).toBe("Sam Teammate");
    expect(block(c, "pri-1").querySelector("[data-priority-face] [data-face]")!.getAttribute("data-face")).toBe("You");
    expect(c.querySelector("[data-rank-handle]")).toBeNull();
    // Its fold starts at the title edge, past the face column.
    expect(c.querySelector("[data-past-toggle]")!.parentElement!.className).toContain("pl-[60px]");

    setView({ group_by: "person_workspace" });
    await act(async () => {});
    expect(headings(c, "data-person-heading")).toEqual(["You", "Sam Teammate"]);
    expect(order(c)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5", "pri-6", "pri-7"]);
    expect(block(c, "pri-1").querySelector("[data-rank-handle]")).not.toBeNull();
    // Sam's set-aside priority is the last row of his group in the active workspace, folded.
    const fold = c.querySelector(`[data-priority-group="user-sam/${TEAM}"] [data-past-toggle]`)!;
    expect(fold.textContent).toBe("Done and set aside 1");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the Group by field offers Person then workspace only with more than one workspace shown, and keeps the choice", async () => {
  const page = await mount(view({ rows: ROWS }));
  const c = page.container;
  const open = async () => {
    const trigger = c.querySelector("[data-group-by-picker]")!;
    await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    return [...document.querySelectorAll("[data-group-by-option]")] as HTMLElement[];
  };
  try {
    expect(c.querySelector("[data-group-by-picker]")!.textContent).toBe("Workspace, then person");
    const options = await open();
    expect(options.map((o) => o.getAttribute("data-group-by-option"))).toEqual(["workspace_person", "person_workspace", "workspace"]);
    await press(options[2]);
    expect(useInboxStore.getState().clientState.ui?.priorities_view).toEqual({ group_by: "workspace" });
    expect(c.querySelector("[data-group-by-picker]")!.textContent).toBe("Workspace");
  } finally {
    await page.unmount();
  }
  setView({ hidden: [AARD, PERSONAL] });
  const one = await mount(view({ rows: ROWS }));
  try {
    const trigger = one.container.querySelector("[data-group-by-picker]")!;
    await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect([...document.querySelectorAll("[data-group-by-option]")].map((o) => o.getAttribute("data-group-by-option"))).toEqual(["workspace_person", "workspace"]);
  } finally {
    await one.unmount();
  }
}, 60_000);

const oneLine = (root: Element) => [...root.querySelectorAll("[data-priority-title]")].every((t) => t.className.split(" ").includes("truncate") && !t.className.includes("line-clamp"));

test("Compact folds every priority to one line, in every grouping", async () => {
  const page = await mount(view({ rows: ROWS }));
  const c = page.container;
  try {
    expect(c.querySelectorAll("li[data-milestone]").length).toBeGreaterThan(0);
    await press(c.querySelector("[data-compact-toggle]")!);
    expect(c.querySelector("[data-compact-toggle]")!.getAttribute("aria-pressed")).toBe("true");
    expect(useInboxStore.getState().clientState.ui?.priorities_view).toEqual({ compact: true });
    expect(c.querySelectorAll("li[data-milestone]")).toHaveLength(0);
    expect(order(c)).toHaveLength(7);
    // One line per title at every width and pointer: truncated, never wrapping to two.
    expect(oneLine(c)).toBe(true);
    for (const g of ["workspace", "person_workspace"]) {
      setView({ compact: true, group_by: g });
      await act(async () => {});
      expect(c.querySelectorAll("li[data-milestone]")).toHaveLength(0);
      expect(order(c)).toHaveLength(7);
      expect(oneLine(c)).toBe(true);
    }
  } finally {
    await page.unmount();
  }
  setView({ compact: true });
  const phone = await mount(view({ rows: ROWS, layout: "phone" }));
  try {
    expect(phone.container.querySelectorAll("[data-priority-title]").length).toBeGreaterThan(0);
    expect(oneLine(phone.container)).toBe(true);
  } finally {
    await phone.unmount();
  }
}, 60_000);

test("a teammate's priority reads like the viewer's own: its rank, its milestones' real states, and Start linked to their milestone", async () => {
  const page = await mount(view({ rows: ROWS }));
  try {
    const b = block(page.container, "pri-5");
    expect(b.querySelector("[data-rank]")!.textContent).toBe("1");
    expect(block(page.container, "pri-6").querySelector("[data-rank]")!.textContent).toBe("2");
    // mapped_links carry their marks: working on one milestone, Start on the other.
    expect(states(b)).toEqual({ s1: "working", s2: "start" });
    const start = new URL(b.querySelector('[data-milestone="s2"] [data-state-action="start"]')!.getAttribute("href")!, "https://app.test");
    const { parseComposeLink } = await import("../../lib/composeLink");
    expect(parseComposeLink(start.searchParams)).toMatchObject({ priority: "pri-5", step: "s2" });
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a teammate's session that asks reads Needs you on their milestone, as the viewer's own would", async () => {
  const asking = row(9, "Referral partners", 1, [step("s1", "Read the backlog", "critical")], {
    ...mate,
    mapped_links: [links("s1", [sess("samask", "Backlog dry run", "needs_you", 1, { mine: false })])],
  });
  const page = await mount(view({ rows: [...ROWS, asking] }));
  try {
    expect(states(block(page.container, "pri-9"))).toEqual({ s1: "needs_you" });
  } finally {
    await page.unmount();
  }
}, 60_000);


test("the session menu on a teammate's milestone: a session the viewer started may leave their priority, and nothing else; a teammate's or a co-owned one has no menu", async () => {
  const theirs = row(10, "Shared grader", 1, [step("s1", "Pair on it", "critical")], {
    ...mate,
    mapped_links: [links("s1", [sess("minesess", "My pairing", "dormant", 1, { started_by_viewer: true }), sess("samsess", "Sam's run", "dormant", 2, { mine: false }), sess("coowned", "Co-owned run", "dormant", 3, { started_by_viewer: false })])],
  });
  const page = await mount(view({ rows: [...ROWS, theirs] }));
  try {
    const b = block(page.container, "pri-10");
    await press(b.querySelector('[data-milestone="s1"] [role=button]')!);
    const menus = [...b.querySelectorAll("[data-session-menu]")].map((m) => m.getAttribute("data-session-menu"));
    expect(menus).toEqual([sess("minesess", "", "dormant", 0).short_id]);
    await act(async () => { b.querySelector("[data-session-menu]")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute("data-act"))).toEqual(["not-priority"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("on a phone, Group by is a 44px square in every style; the first section sits right under the toolbar", async () => {
  const page = await mount(view({ rows: ROWS, layout: "phone" }));
  try {
    const picker = page.container.querySelector("[data-group-by-picker]")!;
    expect(picker.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-11", "modern:size-11"]));
    expect(picker.className).not.toMatch(/(^|\s)modern:h-6(\s|$)/);
    // Sections space themselves from each other, never from the toolbar before the first.
    const first = page.container.querySelector("section[data-section]")!;
    expect(first.className.split(/\s+/)).toEqual(expect.arrayContaining(["mt-6", "first-of-type:mt-0"]));
    expect(first.previousElementSibling?.hasAttribute("data-priorities-toolbar")).toBe(true);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the chips' edge fades follow the scroll: none while every chip fits", async () => {
  const page = await mount(view({ rows: ROWS }));
  try {
    const chips = page.container.querySelector("[data-workspace-chips]") as HTMLElement;
    // jsdom lays nothing out: the row reads as fitting, so neither edge fades.
    expect([chips.hasAttribute("data-fade-left"), chips.hasAttribute("data-fade-right")]).toEqual([false, false]);
    Object.defineProperties(chips, { scrollWidth: { value: 600, configurable: true }, clientWidth: { value: 300, configurable: true }, scrollLeft: { value: 120, configurable: true, writable: true } });
    await act(async () => { chips.dispatchEvent(new window.Event("scroll", { bubbles: true })); });
    expect([chips.hasAttribute("data-fade-left"), chips.hasAttribute("data-fade-right")]).toEqual([true, true]);
    Object.defineProperty(chips, "scrollLeft", { value: 300, configurable: true });
    await act(async () => { chips.dispatchEvent(new window.Event("scroll", { bubbles: true })); });
    expect([chips.hasAttribute("data-fade-left"), chips.hasAttribute("data-fade-right")]).toEqual([true, false]);
  } finally {
    await page.unmount();
  }
}, 60_000);
