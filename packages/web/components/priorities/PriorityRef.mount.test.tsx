// A priority as an object, mounted in jsdom over a convex transport that
// answers by name (test-helpers/missingBackend.tsx) with priorities.show's
// contract. Proves: `pri-N` in a message is a pill (owner's face, rank badge,
// title, critical meter, n/m; a wide one wraps as prose) that opens
// /priorities/pri-N; hovering it shows the card (face, rank badge, title,
// plan, its open critical milestones with their states, pri-N, Share and
// Open), a teammate's with their face and real rank; on a touch screen a tap
// opens the same card as a bottom sheet; alone on a line it is the card; and
// the page at /priorities/pri-N is the
// list row made bigger: its title (the owner double-clicks it to rename),
// Correct…, Share with Copy ID and ⋯, the ten days, the plan once, its
// milestones in one list by state with every one expanded and its sessions
// unfolded (closed last, shipped ones reading done), and the corrections; no
// meta line, AI summary, Next box, Linked section, or Done and Polish heads.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityRef.mount.test.tsx
import { afterEach, expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/conversation/x");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { act } = React as any;
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { EntityIdPill } = await import("../EntityIdPill");
const { EntityObjectCard } = await import("../EntityObjectCard");
const { default: PriorityPage } = await import("./PriorityPage");
const { lastDays } = await import("../../lib/priorityList");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const days = lastDays(10, NOW);

const step = (key: string, title: string, tier: "critical" | "polish", done = false, extra: Record<string, unknown> = {}) => ({ key, title, tier, tier_set_by: "pass", refs: [], done, sessions: [], ...extra });
const sess = (tag: string, title: string, state: string, ageHours: number, extra: Record<string, unknown> = {}) => ({
  short_id: `jx7${tag}`.slice(0, 7), conversation_id: fixtureId(tag), title, state, mine: true, workflow: false, why: ["mapped"], last_active_at: NOW - ageHours * HOUR, ...extra,
});
const links = (key: string, sessions: unknown[], extra: Record<string, unknown> = {}) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false, ...extra });
const PLAN = { short_id: "pl-1075", title: "Codecast follows what each person drives", done: 5, total: 6, size: 6 };

const DETAIL = {
  _id: fixtureId("pri60"), short_id: "pri-60", title: "Priorities for Union",
  summary: "Priorities is live on Union; session mapping sits around 0.65, short of the 0.75 bar, and calibration is paused.",
  status: "active", rank: 7, person_pos: null, ai_rank: 7, rank_source: "ai", status_set_by: "pass", serves: null,
  steps: [
    step("s1", "Priorities live behind a flag", "critical", true, { done_at: NOW - 2 * HOUR }),
    step("s2", "Calibrate goal finding and session mapping", "critical"),
    step("s3", "Turn on for the Union team", "critical", true, { done_at: NOW - DAY }),
    step("s4", "Session mapping reaches 0.75", "critical"),
    step("p1", "Priorities page redesign", "polish"),
  ],
  counts: { critical_done: 2, critical_total: 4 },
  workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", owner_image: null, mine: true,
  first_seen_at: NOW - 3 * DAY, last_active_at: NOW, done_at: null, session_count: 3, session_count_more: false, sessions: [], correction_pending: true,
  links: [
    links("s1", []),
    links("s2", [sess("build", "Priorities feature build", "needs_you", 3), sess("runone", "Review · ct-9001 mapping", "idle", 5, { workflow: true })]),
    links("s3", []),
    links("s4", [sess("build", "Priorities feature build", "needs_you", 3)], { correction_pending: true }),
    links("p1", [sess("polish", "Visual design polish", "needs_you", 7)]),
  ],
  plan: PLAN,
  other_sessions: [],
  corrections: [{ _id: "c1", step_key: "s4", text: "Calibration scorer belongs here, not under Calibrate goal finding.", status: "pending", created_at: NOW - DAY }],
};
const at = (n: number) => days.map((_, i) => (i === days.length - 1 ? n : i === days.length - 2 ? 6 : 0));
const HISTORY = { days, lanes: [{ key: "pri-60", short_id: "pri-60", title: "Priorities for Union", status: "active", counts: at(1), total: 7 }] };

answers["priorities:show"] = DETAIL;
answers["priorities:history"] = HISTORY;

// The sessions DETAIL says ask, as the sidebar files them under Needs You (blocked on the viewer, theirs): only
// such a row makes a milestone read Needs you.
const asking = { message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, user_id: VIEWER_ID, thread_state_status: "blocked", thread_state_at: NOW - 10 * 60_000 };
useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries([fixtureId("build"), fixtureId("evalmap"), fixtureId("polish")].map((id) => [id, { _id: id, title: id, ...asking }])) } }));

const inRouter = (node: React.ReactNode, path = "/conversation/x") => mountSurface(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const coarse = (on: boolean) => {
  const mm = (q: string) => ({ matches: on && q === "(pointer: coarse)", media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false });
  (window as any).matchMedia = mm;
  (globalThis as any).matchMedia = mm;
};

afterEach(() => {
  coarse(false);
  useInboxStore.setState({ priorityDetails: {} } as any);
});

test("pri-N in a message is a pill: face, rank badge, title, critical meter, and it opens the priority's page", async () => {
  const page = await inRouter(<p>Can you pick up <EntityIdPill shortId="pri-60" /> next?</p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    expect(describeFailures(page)).toBe("");
    const pill = page.container.querySelector("[data-priority-pill]") as HTMLAnchorElement;
    expect(pill.getAttribute("href")).toBe("/priorities/pri-60");
    expect(pill.textContent).toContain("Priorities for Union");
    expect(pill.querySelector("[data-critical-meter]")?.textContent).toBe("2/4");
    // The owner's face (your own initial, with no picture), then the rank badge, then the title; each an image with its name.
    const face = pill.querySelector("[data-owner-face]")!;
    expect(face.getAttribute("role")).toBe("img");
    expect(face.getAttribute("aria-label")).toBe("You");
    expect(face.getAttribute("title")).toBe("You");
    expect(face.textContent).toBe("D");
    const badge = pill.querySelector("[data-rank-mark]")!;
    expect(badge.textContent).toBe("7");
    expect(badge.getAttribute("role")).toBe("img");
    expect(badge.getAttribute("aria-label")).toBe("Rank 7");
    expect([...pill.children].map((c) => (c.hasAttribute("data-owner-face") ? "face" : c.hasAttribute("data-rank-mark") ? "rank" : c.hasAttribute("data-critical-meter") ? "meter" : "title"))).toEqual(["face", "rank", "title", "meter"]);
    // Not in a wide row: the title truncates.
    expect(pill.className).toContain("inline-flex");
    // The row went through the store, as every surface reads it.
    expect(Object.values((useInboxStore.getState() as any).priorityDetails).map((r: any) => r.short_id)).toEqual(["pri-60"]);
  } finally {
    await page.unmount();
  }
});

test("hovering the pill shows the card: face, rank badge, title, plan, its open milestones with their states, pri-N, Share and Open; no summary, no meter", async () => {
  const page = await inRouter(<p>See <EntityIdPill shortId="pri-60" /></p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    const trigger = page.container.querySelector("[data-priority-pill]")!.parentElement!;
    await act(async () => {
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseenter", { bubbles: false }));
    });
    await page.waitFor(() => !!document.querySelector("[data-priority-card]"), 2000);
    const card = document.querySelector("[data-priority-card]") as HTMLElement;
    expect(card).not.toBeNull();
    const text = card.textContent!;
    expect(text).toContain("Priorities for Union");
    expect(text).toContain("pri-60");
    expect(card.querySelector("[data-owner-face]")?.getAttribute("title")).toBe("You");
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("7");
    expect(card.querySelector('[data-chip="plan"]')?.textContent).toContain(PLAN.title);
    // Each open critical milestone with its state, as the list draws it, and the polish one that needs you: Needs you opens the session to answer.
    const listed = [...card.querySelectorAll("[data-priority-milestones] li[data-milestone]")].map((li) => `${li.getAttribute("data-milestone")}:${li.getAttribute("data-state")}`);
    expect(listed).toEqual(["s2:needs_you", "s4:needs_you", "p1:needs_you"]);
    expect(card.querySelector('[data-milestone="s2"]')!.textContent).toContain("Calibrate goal finding and session mapping");
    expect(card.querySelector('[data-milestone="s2"] [data-state-action="needs_you"]')?.getAttribute("href")).toBe(`/conversation/${fixtureId("build")}`);
    // The milestones and their marks say where it stands: no AI summary, no critical pips.
    expect(text).not.toContain("session mapping sits around 0.65");
    expect(card.querySelector("[data-critical-meter]")).toBeNull();
    expect(card.querySelector("[data-priority-share]")).not.toBeNull();
    expect(card.querySelector("[data-priority-open]")?.getAttribute("href")).toBe("/priorities/pri-60");
  } finally {
    await page.unmount();
  }
});

test("a teammate's card: their face and real rank, and no write control on its milestones", async () => {
  answers["priorities:show"] = { ...DETAIL, mine: false, user_id: fixtureId("mate"), owner: "Sam Teammate", owner_image: null, rank: 3, person_pos: 3, rank_source: "person" };
  const page = await inRouter(<EntityObjectCard refId="pri-60" count={1} />);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-card]"));
    const card = page.container.querySelector("[data-priority-card]")!;
    expect(card.querySelector("[data-owner-face]")?.getAttribute("aria-label")).toBe("Sam Teammate");
    expect(card.querySelector("[data-owner-face]")?.textContent).toBe("S");
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("3");
    expect(card.querySelectorAll("[data-priority-milestones] li[data-milestone]").length).toBeGreaterThan(0);
    expect(card.querySelector('[data-state-action="start"], [data-milestone-menu]')).toBeNull();
  } finally {
    await page.unmount();
    answers["priorities:show"] = DETAIL;
  }
});

test("a priority with no rank shows the target in the badge's place; a wide pill wraps as prose, never between its face, badge and first word", async () => {
  answers["priorities:show"] = { ...DETAIL, status: "set_aside", rank: null, ai_rank: null };
  const page = await inRouter(<p><EntityIdPill shortId="pri-60" wide /></p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    const pill = page.container.querySelector("[data-priority-pill]") as HTMLElement;
    expect(pill.querySelector('[data-rank-mark="none"]')?.tagName.toLowerCase()).toBe("svg");
    expect(pill.className).not.toContain("inline-flex");
    expect(pill.className).toContain("[box-decoration-break:clone]");
    expect(pill.querySelector(".truncate")).toBeNull();
    // "Priorities for Union": face, badge and "Priorities" hold together, as do "Union" and the meter; "for" may wrap.
    const lead = pill.querySelector("[data-pill-lead]")!;
    expect(lead.className).toContain("whitespace-nowrap");
    expect(lead.querySelector("[data-owner-face]")).not.toBeNull();
    expect(lead.querySelector("[data-rank-mark]")).not.toBeNull();
    expect(lead.textContent).toBe("DPriorities");
    const tail = pill.querySelector("[data-pill-tail]")!;
    expect(tail.className).toContain("whitespace-nowrap");
    expect(tail.textContent).toBe("Union2/4");
    expect(pill.textContent).toBe("DPriorities for Union2/4");
  } finally {
    await page.unmount();
    answers["priorities:show"] = DETAIL;
  }
});

test("on a touch screen a tap opens the same card as a bottom sheet, and does not leave the message", async () => {
  coarse(true);
  const page = await inRouter(<p>See <EntityIdPill shortId="pri-60" /></p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    const pill = page.container.querySelector("[data-priority-pill]") as HTMLElement;
    let defaultPrevented = false;
    await act(async () => {
      const e = new (window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      pill.dispatchEvent(e);
      defaultPrevented = e.defaultPrevented;
    });
    expect(defaultPrevented).toBe(true);
    await page.waitFor(() => !!document.querySelector("[data-priority-sheet]"), 2000);
    const sheet = document.querySelector("[data-priority-sheet]") as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector("[data-priority-card]")?.textContent).toContain("Calibrate goal finding and session mapping");
    expect(sheet.querySelector('[data-state-action="needs_you"]')).not.toBeNull();
    expect(sheet.querySelector("[data-priority-open]")?.getAttribute("href")).toBe("/priorities/pri-60");
  } finally {
    await page.unmount();
  }
});

test("pri-N alone on its line is the card its pill opens", async () => {
  const page = await inRouter(<EntityObjectCard refId="pri-60" count={1} />);
  try {
    await page.waitFor(() => !!page.container.querySelector('[data-entity-card="priority"]'));
    expect(describeFailures(page)).toBe("");
    const card = page.container.querySelector('[data-entity-card="priority"] [data-priority-card]')!;
    expect(card.textContent).toContain("Priorities for Union");
    expect(card.querySelector('[data-state-action="needs_you"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});

test("the page lists every milestone in one list by state, critical before polish, done last; each open, the polish one marked; no Done or Polish heads", async () => {
  const both = [sess("evalmap", "Session mapping eval", "needs_you", 7), sess("build", "Priorities feature build", "needs_you", 3)];
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "s4" ? { ...l, sessions: both } : l)) };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector('[data-milestones] [data-milestone="s4"] [data-state-action="needs_you"]'));
    // The most recent ask is the one to answer.
    expect(page.container.querySelector('[data-milestones] [data-milestone="s4"] [data-state-action="needs_you"]')!.getAttribute("href")).toBe(`/conversation/${fixtureId("build")}`);
    const rows = [...page.container.querySelectorAll("[data-milestones] li[data-milestone]")];
    expect(rows.map((li) => `${li.getAttribute("data-milestone")}:${li.getAttribute("data-state")}`)).toEqual(["s2:needs_you", "s4:needs_you", "p1:needs_you", "s1:done", "s3:done"]);
    // Every one open, done ones too, and one list: no section heads.
    expect(rows.map((li) => li.querySelector("[role=button]")!.getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "true", "true"]);
    expect(page.container.querySelector("[data-milestones] [data-section], [data-milestones] [data-sections]")).toBeNull();
    // A polish milestone says so beside its title; a critical one says nothing.
    expect(rows.filter((li) => li.querySelector("[data-polish]")).map((li) => li.getAttribute("data-milestone"))).toEqual(["p1"]);
    // Room above each milestone but the first.
    expect(rows[1].className).toContain("mt-3");
    expect(rows[0].className).toContain("first:mt-0");
  } finally {
    answers["priorities:show"] = DETAIL;
    await page.unmount();
  }
}, 60_000);

test("the page lists a milestone's closed sessions after the live ones, never folded; a closed one whose work reached main reads Shipped", async () => {
  const s2 = [
    sess("build", "Priorities feature build", "needs_you", 3),
    sess("plain", "Abandoned spike", "killed", 1),
    sess("shipped", "Visual design polish", "killed", 30, { shipped: true }),
    sess("settled", "Mapping notes", "done", 2),
  ];
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "s2" ? { ...l, sessions: s2 } : l)) };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector('[data-milestone="s2"] [data-connected] [data-session-row]'));
    const box = page.container.querySelector('[data-milestone="s2"] [data-connected]')!;
    expect(box.querySelector("[data-closed-sessions]")).toBeNull();
    const rows = [...box.querySelectorAll("[data-session-row]")];
    // Live first, then the closed: shipped before merely settled or closed, each in the sidebar's order.
    expect(rows.map((r) => r.getAttribute("data-session-row"))).toEqual([fixtureId("build"), fixtureId("shipped"), fixtureId("settled"), fixtureId("plain")]);
    expect(rows.map((r) => r.getAttribute("data-row-mark"))).toEqual(["needs_you", "done", "done", "killed"]);
    const shipped = rows[1];
    expect(shipped.hasAttribute("data-shipped")).toBe(true);
    expect(shipped.textContent).toContain("Shipped");
    expect(shipped.textContent).not.toContain("Closed");
    expect(rows[2].textContent).toContain("Done");
    expect(rows[3].textContent).toContain("Closed");
    expect(box.querySelector('[data-group="sessions"]')!.textContent).toContain("Sessions4");
  } finally {
    answers["priorities:show"] = DETAIL;
    await page.unmount();
  }
}, 60_000);

test("the page opened at a milestone (the list's \"+N older sessions\") brings that milestone into view", async () => {
  const proto = (window as any).HTMLElement.prototype;
  const real = proto.scrollIntoView;
  const seen: string[] = [];
  proto.scrollIntoView = function (this: Element) { seen.push(this.getAttribute("data-milestone") ?? ""); };
  try {
    const at = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60?milestone=s4");
    await at.waitFor(() => !!at.container.querySelector("[data-milestones]"));
    expect(seen).toEqual(["s4"]);
    await at.unmount();
  } finally {
    if (real) proto.scrollIntoView = real;
    else delete proto.scrollIntoView;
  }
}, 60_000);

test("the page opened at a done or a polish milestone shows it open and brings it into view", async () => {
  const proto = (window as any).HTMLElement.prototype;
  const real = proto.scrollIntoView;
  const seen: string[] = [];
  proto.scrollIntoView = function (this: Element) { seen.push(this.getAttribute("data-milestone") ?? ""); };
  // p1 with nothing asking: on the list it would fold behind POLISH.
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "p1" ? { ...l, sessions: [] } : l)) };
  try {
    for (const key of ["s3", "p1"]) {
      seen.length = 0;
      const at = await inRouter(<PriorityPage id="pri-60" />, `/priorities/pri-60?milestone=${key}`);
      try {
        await at.waitFor(() => !!at.container.querySelector("[data-milestones]"));
        const li = at.container.querySelector(`[data-milestones] li[data-milestone="${key}"]`)!;
        expect(li).not.toBeNull();
        // Opened at it, the milestone shows what it is connected to.
        expect(li.querySelector("[role=button]")!.getAttribute("aria-expanded")).toBe("true");
        expect(seen).toEqual([key]);
      } finally {
        await at.unmount();
      }
    }
  } finally {
    answers["priorities:show"] = DETAIL;
    if (real) proto.scrollIntoView = real;
    else delete proto.scrollIntoView;
  }
}, 60_000);

test("the page: title, Correct…, Share and ⋯; ten days; the plan once; milestones; corrections; no meta line or AI summary", async () => {
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    expect(describeFailures(page)).toBe("");
    const el = page.container;
    expect(el.querySelector("h1")?.textContent).toBe("Priorities for Union");
    // Its glyph is the registered priority mark, its title beside it.
    expect(el.querySelector('header [data-mark="entity.priority"]')!.hasAttribute("data-mark-labeled")).toBe(true);
    // The priority's own page shows its title whole.
    expect(el.querySelector("h1")!.className).not.toContain("line-clamp");
    // No meta line (rank, id, started, pips), no AI summary, no Next box, no Linked section.
    expect(el.querySelector("[data-priority-meta], [data-rank], [data-rank-by], [data-ai-summary], [data-priority-next], [data-linked], [data-action]")).toBeNull();
    expect(el.textContent).not.toContain(DETAIL.summary);
    expect(el.textContent).not.toContain("Started");
    // The viewer's own priority names no owner.
    expect(el.querySelector("[data-priority-owner]")).toBeNull();

    // Correct…, Share and ⋯ in the header; on a phone they take a row of their own above the title, which gets the whole width.
    const actions = el.querySelector("header [data-priority-actions]")!;
    // On a phone Correct… is its pencil, its name kept for a screen reader rather than removed.
    const correct = actions.querySelector("[data-correct-priority]")!;
    expect(correct.textContent).toContain("Correct…");
    expect(correct.querySelector("span")!.className).toContain("max-sm:sr-only");
    expect(correct.innerHTML).not.toContain("max-sm:hidden");
    expect(actions.querySelector("[data-share-trigger]")?.getAttribute("aria-label")).toBe("Share priority");
    expect(actions.querySelector('[data-priority-menu="pri-60"]')).not.toBeNull();
    expect(actions.className).toContain("max-sm:order-first");
    expect(actions.parentElement!.className).toContain("max-sm:flex-col");
    expect(el.querySelector("h1")!.parentElement!.className).toContain("max-sm:self-stretch");

    // Ten days across the page, today last, each with its date.
    const ten = el.querySelector("[data-ten-days]")!;
    expect([...ten.querySelectorAll("[data-day]")].map((d) => d.getAttribute("data-count"))).toEqual(["0", "0", "0", "0", "0", "0", "0", "0", "6", "1"]);
    expect(ten.textContent).toContain("Today");

    // The priority's plan once, above the milestones, not under each of them.
    const plans = el.querySelectorAll('[data-priority-plan="pl-1075"]');
    expect(plans).toHaveLength(1);
    expect(plans[0].getAttribute("href")).toBe("/plans/pl-1075");
    expect(plans[0].textContent).toContain(PLAN.title);
    expect(plans[0].textContent).toContain("5/6");
    // Its title wraps to two lines on a phone or a touch screen, one on a wide page under a mouse.
    for (const cls of ["truncate", "[@container(max-width:40rem)]:line-clamp-2", "[@media(pointer:coarse)]:line-clamp-2"]) expect(plans[0].querySelector("[data-priority-plan-title]")!.className).toContain(cls);
    const list = el.querySelector("[data-milestones]")!;
    expect(list.querySelector('[data-group="plans"]')).toBeNull();
    expect(list.textContent).not.toContain(PLAN.title);

    // Every milestone in one list by state, each expanded with its connected items; no Done or Polish heads.
    expect([...list.querySelectorAll("li[data-milestone]")].map((li) => `${li.getAttribute("data-milestone")}:${li.getAttribute("data-state")}`)).toEqual(["s2:needs_you", "s4:needs_you", "p1:needs_you", "s1:done", "s3:done"]);
    expect(list.querySelector('[data-milestone="s4"] [data-correction-pending]')).not.toBeNull();
    expect(list.querySelectorAll('[data-milestone="s2"] [data-connected] [data-session-row]')).toHaveLength(2);
    expect(list.querySelector("[data-section]")).toBeNull();

    // Corrections, with the milestone each is about.
    const corrections = el.querySelector("[data-corrections]")!;
    expect(corrections.textContent).toContain("Session mapping reaches 0.75: Calibration scorer belongs here");
  } finally {
    await page.unmount();
  }
});

test("the page's strip, with no typing yet, is its baseline: no counts, no hover cards", async () => {
  delete answers["priorities:history"];
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-ten-days] [data-day-strip]"));
    const strip = page.container.querySelector("[data-ten-days] [data-day-strip]")!;
    expect(strip.hasAttribute("data-pending")).toBe(true);
    expect(strip.querySelectorAll("[data-count]")).toHaveLength(0);
    // The dates still sit under the columns.
    expect(strip.textContent).toContain("Today");
  } finally {
    await page.unmount();
    answers["priorities:history"] = HISTORY;
  }
});

test("a milestone's own plan, other than the priority's, still shows under that milestone", async () => {
  const OWN = { short_id: "pl-77", title: "Session mapping scorer", done: 1, total: 3, size: 3 };
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "s4" ? { ...l, plan: OWN } : l.key === "s2" ? { ...l, plan: PLAN } : l)) };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-milestones]"));
    const list = page.container.querySelector("[data-milestones]")!;
    expect(page.container.querySelectorAll("[data-priority-plan]")).toHaveLength(1);
    expect(list.querySelector('[data-milestone="s2"] [data-group="plans"]')).toBeNull();
    expect(list.querySelector('[data-milestone="s4"] [data-group="plans"]')!.textContent).toContain(OWN.title);
  } finally {
    answers["priorities:show"] = DETAIL;
    await page.unmount();
  }
});

test("the page's Share holds the priority's id with Copy ID", async () => {
  const copied: string[] = [];
  const nav = window.navigator as any;
  const realClipboard = nav.clipboard;
  Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-share-trigger]"));
    await act(async () => { (page.container.querySelector("[data-share-trigger]") as HTMLElement).click(); });
    await page.waitFor(() => !!document.querySelector("[data-copy-id]"));
    const row = document.querySelector("[data-copy-id]")!;
    expect(row.textContent).toContain("pri-60");
    await act(async () => { (row.querySelector('[data-act="copy-id"]') as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(copied).toEqual(["pri-60"]);
  } finally {
    await page.unmount();
    Object.defineProperty(nav, "clipboard", { configurable: true, value: realClipboard });
  }
});

test("the owner double-clicks the page's title to rename it in place: Enter saves, Escape takes it back; Rename is in ⋯ for touch only", async () => {
  useInboxStore.getState().syncTable("priorities", [{ ...listRows()[0], title: DETAIL.title }] as any);
  const sent: Array<[string, unknown[]]> = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: unknown[]) => { sent.push([action, args]); return null; });
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  const el = page.container;
  const input = () => el.querySelector('[data-rename-input][aria-label="Priority title"]') as HTMLInputElement | null;
  const dbl = () => act(async () => { el.querySelector("h1")!.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true })); });
  const keyIn = (k: string, value: string) => act(async () => {
    input()!.value = value;
    input()!.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  try {
    await page.waitFor(() => !!el.querySelector("[data-priority-page]"));
    await dbl();
    expect(input()!.value).toBe(DETAIL.title);
    await keyIn("Escape", "Not this");
    expect(input()).toBeNull();
    expect(el.querySelector("h1")!.textContent).toBe(DETAIL.title);
    // Focus goes back to the title, never to the page.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(el.querySelector("h1"));
    // A bare blur (an extension that ate Escape) takes the edit back too.
    await dbl();
    await act(async () => { input()!.value = "Abandoned"; input()!.blur(); });
    expect(input()).toBeNull();
    expect(el.querySelector("h1")!.textContent).toBe(DETAIL.title);
    await dbl();
    await keyIn("Enter", "Priorities for Union, calibrated");
    expect(input()).toBeNull();
    expect(el.querySelector("h1")!.textContent).toBe("Priorities for Union, calibrated");
    for (let i = 0; i < 20 && !sent.some(([a]) => a === "renamePriorityTitle"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(sent.filter(([a]) => a === "renamePriorityTitle").map(([, args]) => args)).toEqual([["pri-60", "Priorities for Union, calibrated"]]);
    // On a touch screen, which has no double-click to speak of, the ⋯ keeps Rename.
    await act(async () => { el.querySelector('[data-priority-menu="pri-60"]')!.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const rename = document.querySelector('[role="menuitem"][data-act="rename"]') as HTMLElement;
    expect(rename.className).toContain("[@media(pointer:fine)]:hidden");
    await act(async () => { rename.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(input()).not.toBeNull();
  } finally {
    await page.unmount();
    (useInboxStore.getState() as any)._clearRuntimeBindings?.();
    useInboxStore.getState().syncTable("priorities", [] as any);
  }
});

const { isDetailPinned } = await import("../../lib/detailRows");
const { renderGalleryRecords, GALLERY_PRIORITY } = await import("../../lib/renderGallery");

/** The list row of DETAIL as priorities.list carries it, beside another of the owner's that sits first. */
const listRows = () => {
  const { corrections: _c, other_sessions: _o, ...row } = DETAIL;
  return [
    { ...row, steps: row.steps.map(({ sessions: _s, ...st }) => st), title: "Priorities for Union, as listed", person_pos: null, ai_rank: 7 },
    { ...row, _id: fixtureId("pri61"), short_id: "pri-61", title: "Another one", person_pos: 2, ai_rank: null, rank_source: "person", links: [] },
  ];
};

test("the list row wins: the detail holds only what show alone returns, and the store's own writes paint on the page at once", async () => {
  useInboxStore.getState().syncTable("priorities", listRows() as any);
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    const el = page.container;
    // Every field the list row carries is read from it.
    expect(el.querySelector("h1")?.textContent).toBe("Priorities for Union, as listed");
    // What only show has is laid on.
    expect(el.querySelector("[data-corrections]")?.textContent).toContain("Calibration scorer belongs here");
    // The detail row is not a second copy of the priority.
    const detail = (useInboxStore.getState() as any).priorityDetails[DETAIL._id];
    expect(Object.keys(detail).sort()).toEqual(["_cachedAt", "_id", "corrections", "other_sessions", "short_id"]);
    // Pinned while the page shows it.
    expect(isDetailPinned("priorityDetails", DETAIL._id)).toBe(true);
    // A rename paints through the list row, before any server push.
    await act(async () => { void (useInboxStore.getState() as any).renamePriorityTitle("pri-60", "Priorities for Union, renamed").catch(() => {}); });
    await page.waitFor(() => el.querySelector("h1")?.textContent === "Priorities for Union, renamed");
    expect(el.querySelector("h1")?.textContent).toBe("Priorities for Union, renamed");
  } finally {
    await page.unmount();
    useInboxStore.getState().syncTable("priorities", [] as any);
  }
  expect(isDetailPinned("priorityDetails", DETAIL._id)).toBe(false);
});

test("a teammate's priority: its owner by the title, its title is no rename, and its ⋯ holds no Rename", async () => {
  answers["priorities:show"] = { ...DETAIL, mine: false, owner: "Sam Teammate", person_pos: 3, rank_source: "person" };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    const el = page.container;
    // Their face and name: the initial is theirs.
    const owner = el.querySelector("header [data-priority-owner]")!;
    expect(owner.textContent).toBe("SSam Teammate");
    expect(owner.querySelector("[data-owner-face]")?.getAttribute("aria-label")).toBe("Sam Teammate");
    // No write control on a teammate's milestones; the viewer's own sessions on them may only leave (Not this priority).
    expect(el.querySelector("[data-priority-page] [data-milestone-menu]")).toBeNull();
    const sessionMenu = el.querySelector("[data-priority-page] [data-session-menu]")!;
    await act(async () => { sessionMenu.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute("data-act"))).toEqual(["not-priority"]);
    await act(async () => { document.activeElement?.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await act(async () => { el.querySelector("h1")!.dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true })); });
    expect(el.querySelector("[data-rename-input]")).toBeNull();
    await act(async () => { el.querySelector('[data-priority-menu="pri-60"]')!.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute("data-act"))).toEqual(["copy-link"]);
  } finally {
    await page.unmount();
    answers["priorities:show"] = DETAIL;
  }
});

test("a refusal drops the cached detail: the page and the pill read not found", async () => {
  let page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
  await page.unmount();
  expect((useInboxStore.getState() as any).priorityDetails[DETAIL._id]).toBeDefined();
  answers["priorities:show"] = null;
  try {
    page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
    await page.waitFor(() => page.text().includes("No priority"));
    expect(page.text()).toContain("No priority pri-60 you can see");
    expect(page.container.querySelector("[data-priority-page]")).toBeNull();
    expect((useInboxStore.getState() as any).priorityDetails[DETAIL._id]).toBeUndefined();
    await page.unmount();
    page = await inRouter(<p>See <EntityIdPill shortId="pri-60" /> and</p>);
    expect(page.container.querySelector("[data-priority-pill]")).toBeNull();
    expect(page.text()).not.toContain("Priorities for Union");
    await page.unmount();
  } finally {
    answers["priorities:show"] = DETAIL;
  }
});

test("the render gallery's priority shows its Needs you, and the real server's refusal leaves its client-keyed row", async () => {
  const records = renderGalleryRecords(NOW, VIEWER_ID, `team:${TEAM_ID}`, fixtureId("galleryconv"));
  // Its asking session, as the sidebar files it under Needs You.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [GALLERY_PRIORITY.asking]: { _id: GALLERY_PRIORITY.asking, title: "Priorities feature build", ...asking } } }));
  useInboxStore.getState().syncTable("priorityDetails", records.priorityDetails as any, { isDelta: true });
  answers["priorities:show"] = null;
  try {
    const page = await inRouter(<EntityObjectCard refId={GALLERY_PRIORITY.short} count={1} />);
    await page.waitFor(() => !!page.container.querySelector('[data-entity-card="priority"]'));
    const card = page.container.querySelector('[data-entity-card="priority"]')!;
    expect(card.querySelector('[data-state-action="needs_you"]')?.getAttribute("href")).toBe(`/conversation/${GALLERY_PRIORITY.asking}`);
    // The owner's face (no picture, so their initial) and the rank badge.
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("7");
    expect(card.querySelector("[data-owner-face]")?.textContent).toBe("D");
    await page.unmount();
  } finally {
    answers["priorities:show"] = DETAIL;
  }
});

test("the page without corrections has no Corrections section; a priority the viewer cannot read says so", async () => {
  answers["priorities:show"] = { ...DETAIL, corrections: [], correction_pending: false };
  let page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    expect(page.container.querySelector("[data-corrections]")).toBeNull();
  } finally {
    await page.unmount();
  }
  useInboxStore.setState({ priorityDetails: {} } as any);
  answers["priorities:show"] = null;
  page = await inRouter(<PriorityPage id="pri-61" />, "/priorities/pri-61");
  try {
    await page.waitFor(() => page.text().includes("No priority"));
    expect(page.text()).toContain("No priority pri-61 you can see");
  } finally {
    await page.unmount();
    answers["priorities:show"] = DETAIL;
  }
});
