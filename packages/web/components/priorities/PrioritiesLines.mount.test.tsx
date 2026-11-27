// /priorities mounted in jsdom (test-helpers/prioritiesList.tsx): an open milestone's connected list
// (grouped by kind, sessions in the sidebar's order, closed ones folded, tasks in the task vocabulary),
// the coarse-pointer targets, and the layout the list's width and the screen pick.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesLines.mount.test.tsx
import { expect, test } from "bun:test";
import { fixtureId, TEAM_ID, VIEWER_ID, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage } = await import("./PrioritiesPage");
const { default: PrioritiesRoute } = await import("../../app/priorities/page");
const { HISTORY, HOUR, KINDS, NOW, PL_1075, ROWS, block, links, listOf, mount, row, seedKinds, seedNeedsYou, sess, step, view } = await import("../../test-helpers/prioritiesList");

const openLine = async (b: HTMLElement, key: string) => {
  const { act } = React as any;
  await act(async () => { (b.querySelector(`[data-milestone="${key}"] [role=button]`) as HTMLElement).click(); });
  return b.querySelector(`[data-milestone="${key}"] [data-connected]`) as HTMLElement;
};
const groups = (c: HTMLElement) => [...c.querySelectorAll("[data-group]")].map((g) => g.getAttribute("data-group"));

test("an open milestone lists what it is connected to, grouped by kind under labelled counts, in order", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS] }));
  try {
    const c = await openLine(block(page.container, "pri-9"), "s1");
    expect(groups(c)).toEqual(["sessions", "tasks", "prs", "branches", "plans", "deploys"]);
    const head = (k: string) => c.querySelector(`[data-group="${k}"] div`)!.textContent;
    expect([head("sessions"), head("tasks"), head("prs"), head("plans")]).toEqual(["Sessions2", "Tasks1", "Pull requests1", "Plans1"]);
    // A task by its title in the task vocabulary, a PR by its number and state, the plan by its title and progress.
    expect(c.querySelector('[data-group="tasks"]')!.textContent).toBe("Tasks1Write the wiring");
    expect(c.querySelector('[data-group="tasks"] [data-task-status]')!.getAttribute("data-task-status")).toBe("open");
    expect(c.querySelector("[data-pr]")!.textContent).toBe("#4580codecast · open");
    expect(c.querySelector('[data-group="plans"]')!.textContent).toContain(`${PL_1075.title}24/37`);
    expect(c.querySelector("[data-branch]")!.textContent).toBe("feat/every-link");
    expect(c.querySelector('[data-group="deploys"]')!.textContent).toContain("web");
    // No change-request group, and no short id as a label.
    expect(c.textContent).not.toMatch(/change request|ct-8001/i);
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("a connected PR opens the app's own pull request page and a deploy its own page; a plan shows only when it is the milestone's own", async () => {
  seedKinds();
  useInboxStore.getState().syncTable("teamDeploys", [{ _id: "dep8001", short_id: "dp-8001", workspace: `team:${TEAM_ID}`, target: "web", status: "live", live_at: NOW - HOUR, created_at: NOW - 2 * HOUR, sessions: [], tasks: [{ short_id: "ct-8001" }] }] as any, { isDelta: true });
  // The priority's own plan is pl-1075: a milestone whose link names it lists no plan; one with a plan of its own lists that.
  const OWN = { short_id: "pl-77", title: "Its own plan", done: 1, total: 3, size: 3 };
  const r = { ...KINDS, plan: PL_1075, links: [{ ...KINDS.links[0], plan: PL_1075 }, { ...KINDS.links[1], plan: OWN }] };
  const page = await mount(view({ rows: [r] }));
  try {
    const c = await openLine(block(page.container, "pri-9"), "s1");
    expect(c.querySelector("[data-pr]")!.getAttribute("href")).toBe("/pr/codecast-sh/codecast/4580");
    expect(c.querySelector("[data-pr]")!.hasAttribute("target")).toBe(false);
    expect(c.querySelector('[data-group="deploys"] a')!.getAttribute("href")).toBe("/deploys?deploy=dp-8001");
    expect(c.querySelector('[data-group="plans"]')).toBeNull();
    const c2 = await openLine(block(page.container, "pri-9"), "s2");
    expect(c2.querySelector('[data-group="plans"]')!.textContent).toContain(OWN.title);
    expect(c2.textContent).not.toContain(PL_1075.title);
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("sessions sort as the sidebar files them, then by recency; closed ones fold under \"n closed\"; older ones are a count", async () => {
  const r = row(12, "Sorted", 1, [step("s1", "Many sessions", "critical")], {
    links: [links("s1", [
      sess("idle1", "Idle one", "idle", 1),
      sess("gone1", "Finished one", "done", 2),
      sess("work1", "Older worker", "working", 5),
      sess("ask1", "Asks you", "needs_you", 9),
      sess("dorm1", "Sleeper", "dormant", 0),
      sess("work2", "Newer worker", "working", 1),
      sess("gone2", "Killed one", "killed", 3),
    ], { sessions_more: 2 })],
  });
  const unseed = seedNeedsYou("ask1");
  const page = await mount(view({ rows: [r] }));
  const { act } = React as any;
  try {
    const c = await openLine(block(page.container, "pri-12"), "s1");
    const listed = () => [...c.querySelectorAll("[data-session-row]")].map((li) => li.getAttribute("data-state"));
    expect(listed()).toEqual(["needs_you", "working", "working", "dormant", "idle"]);
    expect(c.querySelector('[data-session-row] a')!.textContent).toContain("Asks you");
    expect([...c.querySelectorAll("[data-session-row]")][1].textContent).toContain("Newer worker");
    // The group counts every session, the folded and the older ones too.
    expect(c.querySelector('[data-group="sessions"] div')!.textContent).toBe("Sessions9");
    const fold = c.querySelector("[data-closed-sessions]") as HTMLElement;
    expect(fold.textContent).toBe("2 closed");
    await act(async () => { fold.click(); });
    expect(listed()).toEqual(["needs_you", "working", "working", "dormant", "idle", "done", "killed"]);
    // Opening the fold leaves the milestone open.
    expect(block(page.container, "pri-12").querySelector('[data-milestone="s1"] [role=button]')!.getAttribute("aria-expanded")).toBe("true");
    // No page lists the older ones yet, so the count promises no way in: plain text, no link.
    const older = c.querySelector("[data-older-sessions]")!;
    expect(older.textContent).toBe("+2 older sessions");
    expect(older.tagName).toBe("SPAN");
    expect(older.closest("a")).toBeNull();
  } finally {
    await page.unmount();
    unseed();
  }
}, 60_000);

test("on a phone, Looks done? and correction pending sit on a line under the title, which keeps its width", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "A milestone title long enough to need its two lines", "critical"), step("s2", "Corrected", "critical")], {
    links: [links("s1", [sess("mk1", "Marked session", "needs_you", 1)], { looks_done: true, correction_pending: true }), links("s2", [])],
  });
  const page = await mount(view({ rows: [marked], layout: "phone" }));
  try {
    const line = block(page.container, "pri-8").querySelector('[data-milestone="s1"]')!;
    const marks = line.querySelector("[data-milestone-marks]")!;
    expect(marks.querySelector("[data-looks-done]")).not.toBeNull();
    expect(marks.querySelector("[data-correction-pending]")).not.toBeNull();
    // The title's own line holds the title (and its ⋯) alone, the marks on a line of their own under it.
    const title = line.querySelector("[data-milestone-title]")!;
    const column = marks.parentElement!;
    expect(column.className.split(" ")).toContain("flex-col");
    expect(title.parentElement!.parentElement).toBe(column);
    expect(title.parentElement!.nextElementSibling).toBe(marks);
    // The title wraps onto two lines rather than giving way to the marks.
    expect(title.className).toContain("line-clamp-2");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a session's row draws the mark the sidebar draws for it, its Done check and word, while the milestone reads it as idle", async () => {
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("donemark")]: { _id: fixtureId("donemark"), title: "Finished", message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, user_id: VIEWER_ID, thread_state_status: "done", thread_state_at: NOW - 10 * 60_000 } } }));
  const r = row(14, "Done marks", 1, [step("s1", "Has a finished session", "critical")], { links: [links("s1", [sess("donemark", "Finished", "idle", 1)])] });
  const page = await mount(view({ rows: [r] }));
  try {
    const b = block(page.container, "pri-14");
    expect(b.querySelector('[data-milestone="s1"]')!.getAttribute("data-state")).toBe("idle");
    const c = await openLine(b, "s1");
    const item = c.querySelector(`[data-session-row="${fixtureId("donemark")}"]`)!;
    expect([item.getAttribute("data-state"), item.getAttribute("data-mark")]).toEqual(["idle", "done"]);
    expect(item.querySelector('[data-status-mark="done"]')).not.toBeNull();
    expect(item.textContent).toContain("Done");
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("donemark")]: _, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("a task whose row has not loaded draws a neutral dot under its id, never the Open circle", async () => {
  useInboxStore.setState({ tasks: {} } as any);
  const r = row(15, "Unloaded", 1, [step("s1", "Names a task", "critical", false, { refs: [{ kind: "task", id: "ct-8199" }] })], { links: [links("s1", [])] });
  const page = await mount(view({ rows: [r] }));
  try {
    const c = await openLine(block(page.container, "pri-15"), "s1");
    const item = c.querySelector('[data-group="tasks"] li')!;
    expect(item.querySelector("[data-task-status]")!.getAttribute("data-task-status")).toBe("unknown");
    expect(item.querySelector("svg")).toBeNull();
    expect(item.textContent).toBe("ct-8199");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a dropped task is struck through; a done one is quiet", async () => {
  useInboxStore.setState({ tasks: {
    tk1: { _id: "tk1", short_id: "ct-8101", title: "Dropped idea", status: "dropped" },
    tk2: { _id: "tk2", short_id: "ct-8102", title: "Finished work", status: "done" },
  } } as any);
  const r = row(13, "Tasks", 1, [step("s1", "Has tasks", "critical", false, { refs: [{ kind: "task", id: "ct-8101" }, { kind: "task", id: "ct-8102" }] })], { links: [links("s1", [])] });
  const page = await mount(view({ rows: [r] }));
  try {
    const c = await openLine(block(page.container, "pri-13"), "s1");
    const items = [...c.querySelectorAll('[data-group="tasks"] li')];
    expect(items.map((li) => li.querySelector("[data-task-status]")!.getAttribute("data-task-status"))).toEqual(["dropped", "done"]);
    expect(items[0].querySelector(".line-through")!.textContent).toBe("Dropped idea");
    expect(items[1].querySelector(".line-through")).toBeNull();
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("a linked session's branch and a PR's state repaint when they change", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS] }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-9");
    await openLine(b, "s1");
    expect(b.querySelector("[data-branch]")!.textContent).toBe("feat/every-link");
    await act(async () => {
      useInboxStore.getState().syncTable("sessions", [{ _id: fixtureId("kinds2"), title: "Kinds helper", worktree_branch: "feat/renamed", updated_at: NOW }] as any, { isDelta: true });
      useInboxStore.setState((s: any) => ({ pullRequests: { ...s.pullRequests, pr4580: { _id: "pr4580", repository: "codecast-sh/codecast", number: 4580, state: "merged" } } }));
    });
    await page.waitFor(() => b.querySelector("[data-branch]")?.textContent === "feat/renamed");
    await page.waitFor(() => !!b.querySelector("[data-pr]")?.textContent?.includes("merged"));
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("under a coarse pointer every control on the list is a 44px target, at every layout", async () => {
  seedKinds();
  // A size of 44px or more (h-11, size-11, min-h-11) at every pointer, or one a coarse pointer gets: its own, 12px above and below a
  // 20px line, or a 44px ::after press area.
  const sized = /(?:^|\s)(?:size-11|h-11|min-h-11)(?:\s|$)|\[@media\(pointer:coarse\)\]:(?:h-11|min-h-11|size-11|py-3|after:)/;
  // A link or button inside a 44px row counts only when it stretches to the row's full height.
  const inTallRow = (el: Element) => /(?:^|\s)self-stretch(?:\s|$)/.test(el.className) && !!el.parentElement?.closest("li")?.className.includes("[@media(pointer:coarse)]:min-h-11");
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [...ROWS, KINDS], layout }));
    try {
      // Open a milestone and Polish, so its sessions, links and the section heads are in the count.
      await openLine(block(page.container, "pri-9"), "s1");
      const controls = [...page.container.querySelectorAll("a[href], button, [role=button]")];
      expect(controls.length).toBeGreaterThan(30);
      const small = controls.filter((el) => !sized.test(el.className) && !inTallRow(el)).map((el) => el.outerHTML.slice(0, 120));
      expect(small.join("\n")).toBe("");
    } finally {
      await page.unmount();
      useInboxStore.setState({ tasks: {} } as any);
    }
  }
}, 60_000);

test("an open milestone's rows are whole targets: each link fills its 44px row, and its title wraps to two lines on a phone or a touch screen", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS] }));
  try {
    const c = await openLine(block(page.container, "pri-9"), "s1");
    const links = [...c.querySelectorAll("li a[href]")];
    expect(links.length).toBeGreaterThan(3);
    for (const a of links) {
      // The row is 44px under a coarse pointer; the link stretches across it, top to bottom and to the row's end.
      expect(a.closest("li")!.className).toContain("[@media(pointer:coarse)]:min-h-11");
      for (const cls of ["self-stretch", "flex-1"]) expect(a.className.split(/\s+/)).toContain(cls);
    }
    // A title keeps one line on a wide list under a mouse, and wraps to two on a narrow list or a touch screen.
    const titles = [...c.querySelectorAll("[data-item-title]")];
    expect(titles.length).toBeGreaterThan(3);
    for (const t of titles) {
      expect(t.className).toContain("truncate");
      for (const cls of ["[@container(max-width:40rem)]:line-clamp-2", "[@container(max-width:40rem)]:whitespace-normal", "[@media(pointer:coarse)]:line-clamp-2", "[@media(pointer:coarse)]:whitespace-normal"]) expect(t.className).toContain(cls);
    }
    // The priority's own title: at least 44px under a coarse pointer, centred by its padding.
    const title = block(page.container, "pri-9").querySelector("[data-priority-title]")!;
    for (const cls of ["[@media(pointer:coarse)]:min-h-11", "[@media(pointer:coarse)]:py-[13px]"]) expect(title.className).toContain(cls);
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("a narrow window takes the desktop layout on a touch screen at least 900px wide (Daylight), and the phone layout otherwise", async () => {
  answers["priorities:list"] = listOf(ROWS);
  answers["priorities:history"] = HISTORY;
  const realMatch = window.matchMedia;
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  const layoutWith = async (tablet: boolean) => {
    (window as any).matchMedia = (q: string) => ({ ...realMatch(q), matches: tablet && q === "(pointer: coarse) and (min-width: 900px)" });
    const page = await mount(<PrioritiesPage />);
    try {
      return page.container.querySelector("[data-priorities]")?.getAttribute("data-layout");
    } finally {
      await page.unmount();
    }
  };
  try {
    expect(await layoutWith(true)).toBe("wide");
    expect(await layoutWith(false)).toBe("phone");
  } finally {
    (window as any).matchMedia = realMatch;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: realWidth });
  }
}, 60_000);

test("the route shows the feature-off landing while the workspace has Priorities off", async () => {
  useInboxStore.getState().syncTable("teams", [{ _id: TEAM_ID, name: "Degrade Co", role: "admin", features: { priorities: false } }] as any);
  const page = await mount(<PrioritiesRoute />);
  try {
    expect(page.container.querySelector("[data-priorities]")).toBeNull();
    expect(page.text()).not.toContain("No priorities yet");
  } finally {
    await page.unmount();
  }
}, 60_000);
