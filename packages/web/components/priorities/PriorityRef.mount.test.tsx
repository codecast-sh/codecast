// A priority as an object, mounted in jsdom over a convex transport that
// answers by name (test-helpers/missingBackend.tsx) with priorities.show's
// contract. Proves: `pri-N` in a message is a pill (owner's face, rank badge,
// title, critical meter, n/m) that opens /priorities/pri-N; hovering it shows
// the card (face, rank, title, meter, plan, each open critical milestone with
// its box, pri-N, Share and Open); on a touch screen a tap opens the same card
// as a bottom sheet; alone on a line it is the card; and the page at /priorities/pri-N draws its rank
// once with its provenance, the ten days with landing marks, Next and what
// else waits, the summary folded, both milestone lists with their chips,
// everything linked, the corrections, and Share in its header.
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
    // The owner's face (their initial, with no picture), then the rank badge, then the title.
    const face = pill.querySelector("[data-owner-face]")!;
    expect(face.getAttribute("title")).toBe("You");
    expect(face.textContent).toBe("Y");
    expect(pill.querySelector("[data-rank-mark]")?.textContent).toBe("7");
    expect([...pill.children].map((c) => (c.hasAttribute("data-owner-face") ? "face" : c.hasAttribute("data-rank-mark") ? "rank" : c.hasAttribute("data-critical-meter") ? "meter" : "title"))).toEqual(["face", "rank", "title", "meter"]);
    // Not in a wide row: the title truncates.
    expect(pill.className).toContain("inline-flex");
    // The row went through the store, as every surface reads it.
    expect(Object.values((useInboxStore.getState() as any).priorityDetails).map((r: any) => r.short_id)).toEqual(["pri-60"]);
  } finally {
    await page.unmount();
  }
});

test("hovering the pill shows the card: face, rank, title, meter, plan, the open critical milestones with their toggles, pri-N, Share and Open", async () => {
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
    const text = card.textContent!;
    expect(text).toContain("Priorities for Union");
    expect(text).toContain("pri-60");
    expect(card.querySelector("[data-owner-face]")?.getAttribute("title")).toBe("You");
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("7");
    expect(card.querySelector("[data-critical-meter]")?.textContent).toBe("2/4");
    expect(card.querySelector('[data-chip="plan"]')?.textContent).toContain(PLAN.title);
    // The open critical milestones, each a toggle for the owner; done and polish ones stay off the card.
    const milestones = [...card.querySelectorAll("[data-priority-milestones] li")];
    expect(milestones.map((li) => li.getAttribute("data-milestone"))).toEqual(["s2", "s4"]);
    expect(milestones.map((li) => li.querySelector("[data-milestone-toggle]")?.getAttribute("data-milestone-toggle"))).toEqual(["s2", "s4"]);
    // No Next box, no summary.
    expect(card.querySelector("[data-priority-next]")).toBeNull();
    expect(text).not.toContain("session mapping sits around 0.65");
    expect(card.querySelector("[data-priority-share]")).not.toBeNull();
    expect(card.querySelector("[data-priority-open]")?.getAttribute("href")).toBe("/priorities/pri-60");
  } finally {
    await page.unmount();
  }
});

test("a teammate's card: their face and real rank, each open milestone a box they alone can tick", async () => {
  answers["priorities:show"] = { ...DETAIL, mine: false, user_id: fixtureId("mate"), owner: "Sam Teammate", owner_image: null, rank: 3, person_pos: 3, rank_source: "person" };
  const page = await inRouter(<EntityObjectCard refId="pri-60" count={1} />);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-card]"));
    const card = page.container.querySelector("[data-priority-card]")!;
    expect(card.querySelector("[data-owner-face]")?.getAttribute("title")).toBe("Sam Teammate");
    expect(card.querySelector("[data-owner-face]")?.textContent).toBe("S");
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("3");
    expect(card.querySelectorAll("[data-priority-milestones] li")).toHaveLength(2);
    expect(card.querySelector("[data-milestone-toggle]")).toBeNull();
  } finally {
    await page.unmount();
    answers["priorities:show"] = DETAIL;
  }
});

test("a priority with no rank shows the target in the badge's place; a wide pill wraps as prose", async () => {
  answers["priorities:show"] = { ...DETAIL, status: "set_aside", rank: null, ai_rank: null };
  const page = await inRouter(<p><EntityIdPill shortId="pri-60" wide /></p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    const pill = page.container.querySelector("[data-priority-pill]") as HTMLElement;
    expect(pill.querySelector('[data-rank-mark="none"]')?.tagName.toLowerCase()).toBe("svg");
    expect(pill.className).not.toContain("inline-flex");
    expect(pill.className).toContain("[box-decoration-break:clone]");
    expect(pill.querySelector(".truncate")).toBeNull();
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
    expect(sheet.querySelector('[data-milestone-toggle="s2"]')).not.toBeNull();
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
    expect(card.querySelector('[data-milestone-toggle="s2"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});

test("a page line's secondary Answer names a session other than the one Next already answers, as the list does; a phone's actions start at one x", async () => {
  const both = [sess("build", "Priorities feature build", "needs_you", 3), sess("evalmap", "Session mapping eval", "needs_you", 7)];
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "s4" ? { ...l, sessions: both } : l)) };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector('[data-critical-path] [data-milestone="s4"] [data-answer="secondary"]'));
    // Next answers the build session (on s2); s4 names the other asking session, not the build again.
    expect(page.container.querySelector("[data-priority-next] [data-action=answer]")!.getAttribute("href")).toBe(`/conversation/${fixtureId("build")}`);
    expect(page.container.querySelector('[data-critical-path] [data-milestone="s4"] [data-answer="secondary"]')!.getAttribute("href")).toBe(`/conversation/${fixtureId("evalmap")}`);
    // On a phone each row's chips take a line of their own under the title, from one x.
    for (const chips of page.container.querySelectorAll("[data-critical-path] [data-line-chips]")) {
      expect(chips.className).toContain("max-sm:order-last");
      expect(chips.className).toContain("max-sm:ml-[24px]");
      expect(chips.className).toContain("max-sm:justify-start");
    }
  } finally {
    answers["priorities:show"] = DETAIL;
    await page.unmount();
  }
}, 60_000);

test("the page's Also waiting names an ask on Next's own milestone by its session; the title shows whole and Next's milestone wraps", async () => {
  const s2 = [sess("build", "Priorities feature build", "needs_you", 3), sess("other", "Scorer calibration", "needs_you", 5)];
  answers["priorities:show"] = { ...DETAIL, links: DETAIL.links.map((l: any) => (l.key === "s2" ? { ...l, sessions: s2 } : l)) };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector(`[data-also-waiting] [data-waiting-item="${fixtureId("other")}"]`));
    const waiting = page.container.querySelector("[data-also-waiting]")!;
    // Next is "Calibrate goal finding…": the other ask on it reads by its session, not the milestone again.
    expect(waiting.querySelector(`[data-waiting-item="${fixtureId("other")}"]`)!.textContent).toContain("Scorer calibration");
    expect(waiting.querySelector(`[data-waiting-item="${fixtureId("other")}"]`)!.textContent).not.toContain("Calibrate goal finding");
    // An ask on another milestone keeps the milestone's name.
    expect(waiting.querySelector(`[data-waiting-item="${fixtureId("polish")}"]`)!.textContent).toContain("Priorities page redesign");
    // The priority's own page never clamps its title, and Next's milestone wraps rather than truncating.
    const h1 = page.container.querySelector("h1[data-priority-title]") as HTMLElement;
    expect(h1.className).not.toContain("line-clamp");
    expect(h1.hasAttribute("aria-expanded")).toBe(false);
    const next = page.container.querySelector("[data-next-title]") as HTMLElement;
    expect(next.textContent).toBe("Calibrate goal finding and session mapping");
    expect(next.className).not.toContain("truncate");
    expect(next.className).toContain("break-words");
  } finally {
    answers["priorities:show"] = DETAIL;
    await page.unmount();
  }
}, 60_000);

test("the page opens at the milestone its address names (the list's \"+N older sessions\"), and at none otherwise", async () => {
  const at = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60?milestone=s4");
  try {
    await at.waitFor(() => !!at.container.querySelector("[data-critical-path]"));
    const open = [...at.container.querySelectorAll("[data-critical-path] li[data-milestone]")].filter((li) => li.querySelector("[data-milestone-detail]"));
    expect(open.map((li) => li.getAttribute("data-milestone"))).toEqual(["s4"]);
  } finally {
    await at.unmount();
  }
  const plain = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await plain.waitFor(() => !!plain.container.querySelector("[data-critical-path]"));
    expect(plain.container.querySelector("[data-milestone-detail]")).toBeNull();
  } finally {
    await plain.unmount();
  }
}, 60_000);

test("the page: rank once with its provenance, ten days with landings, Next and what else waits, summary folded, milestones, Linked, corrections, Share", async () => {
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    expect(describeFailures(page)).toBe("");
    const el = page.container;
    const meta = el.querySelector("[data-priority-meta]")!;
    expect(el.querySelector("h1")?.textContent).toBe("Priorities for Union");
    expect(meta.querySelectorAll("[data-rank]")).toHaveLength(1);
    expect(meta.querySelector("[data-rank]")?.textContent).toBe("#7");
    expect(meta.querySelector("[data-rank-by]")?.textContent).toBe("ranked by AI");
    expect(meta.textContent).toContain("pri-60");
    // Share in the header (the guard checks the source; this checks it renders).
    expect(el.querySelector("header [data-share-trigger]")?.getAttribute("aria-label")).toBe("Share priority");
    // On a phone the actions take a row of their own above the title, which gets the whole width.
    const actions = el.querySelector("header [data-priority-actions]")!;
    expect(actions.querySelector("[data-share-trigger]")).not.toBeNull();
    expect(actions.className).toContain("max-sm:order-first");
    expect(actions.parentElement!.className).toContain("max-sm:flex-col");
    expect(el.querySelector("h1")!.parentElement!.className).toContain("max-sm:self-stretch");

    // Ten days, today last, with a landing mark on each day a critical milestone landed.
    const ten = el.querySelector("[data-ten-days]")!;
    expect(ten.querySelectorAll("[data-day]")).toHaveLength(10);
    expect(ten.textContent).toContain("2 landed");
    expect(ten.textContent).toContain("Today");
    expect(ten.textContent).toContain("1 message today");
    expect(ten.querySelectorAll("[data-landed]").length).toBeGreaterThanOrEqual(1);

    // Next is the one action; the other ask is under Also waiting on you.
    const next = el.querySelector("[data-priority-next]")!;
    expect(next.querySelector('[data-action="answer"]')?.getAttribute("href")).toBe(`/conversation/${fixtureId("build")}`);
    const waiting = next.querySelector("[data-also-waiting]")!;
    expect(waiting.textContent).toContain("Priorities page redesign");
    expect(waiting.querySelector(`[data-waiting-item="${fixtureId("polish")}"]`)).not.toBeNull();

    // The summary is folded away.
    const summary = el.querySelector("details[data-ai-summary]") as HTMLDetailsElement;
    expect(summary.open).toBe(false);

    // Critical path: every critical milestone, done ones with their landing date, open ones with chips.
    const critical = el.querySelector("[data-critical-path]")!;
    expect(critical.querySelectorAll("[data-milestone]")).toHaveLength(4);
    expect(critical.querySelector('[data-milestone="s1"]')?.textContent).toContain("Landed");
    expect(critical.querySelector('[data-milestone="s2"] [data-action="answer"]')).not.toBeNull();
    expect(critical.querySelector('[data-milestone="s2"] [data-more-sessions]')?.textContent).toBe("+1 session");
    expect(critical.querySelector('[data-milestone="s4"] [data-correction-pending]')).not.toBeNull();
    expect(el.querySelector('[data-polish-list] [data-milestone="p1"] [data-answer="secondary"]')).not.toBeNull();

    // A milestone opens in place to its sessions and links.
    await act(async () => (critical.querySelector('[data-milestone="s2"] [role="button"]') as HTMLElement).click());
    expect(critical.querySelector('[data-milestone="s2"] [data-milestone-detail]')).not.toBeNull();

    // Linked: sessions with state and age, people's first and runs folded; the plan.
    const linked = el.querySelector("[data-linked]")!;
    expect(linked.querySelectorAll("[data-session-row]")).toHaveLength(2);
    expect(linked.querySelector("[data-runs]")?.textContent).toContain("1 review");
    expect(linked.querySelector('[data-chip="plan"]')?.textContent).toContain(PLAN.title);

    // Corrections, with the milestone each is about.
    const corrections = el.querySelector("[data-corrections]")!;
    expect(corrections.textContent).toContain("Session mapping reaches 0.75: Calibration scorer belongs here");
  } finally {
    await page.unmount();
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
    // Every field the list row carries is read from it, the rank live from its place.
    expect(el.querySelector("h1")?.textContent).toBe("Priorities for Union, as listed");
    expect(el.querySelector("[data-rank]")?.textContent).toBe("#2");
    expect(el.querySelector("[data-rank-by]")?.textContent).toBe("ranked by AI");
    // What only show has is laid on.
    expect(el.querySelector("[data-corrections]")?.textContent).toContain("Calibration scorer belongs here");
    // The detail row is not a second copy of the priority.
    const detail = (useInboxStore.getState() as any).priorityDetails[DETAIL._id];
    expect(Object.keys(detail).sort()).toEqual(["_cachedAt", "_id", "corrections", "other_sessions", "short_id"]);
    // Pinned while the page shows it.
    expect(isDetailPinned("priorityDetails", DETAIL._id)).toBe(true);
    // A move paints through the list row, before any server push.
    await act(async () => { void useInboxStore.getState().movePriority("pri-60", 1).catch(() => {}); });
    await page.waitFor(() => el.querySelector("[data-rank]")?.textContent === "#1");
    expect(el.querySelector("[data-rank]")?.textContent).toBe("#1");
    expect(el.querySelector("[data-rank-by]")?.textContent).toBe("you placed it");
  } finally {
    await page.unmount();
    useInboxStore.getState().syncTable("priorities", [] as any);
  }
  expect(isDetailPinned("priorityDetails", DETAIL._id)).toBe(false);
});

test("a teammate's active priority shows the owner's real rank and who placed it, and never Set aside", async () => {
  answers["priorities:show"] = { ...DETAIL, mine: false, user_id: fixtureId("mate"), owner: "Sam Teammate", rank: 3, person_pos: 3, rank_source: "person" };
  const page = await inRouter(<PriorityPage id="pri-60" />, "/priorities/pri-60");
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-page]"));
    const meta = page.container.querySelector("[data-priority-meta]")!;
    expect(meta.querySelector("[data-rank]")?.textContent).toBe("#3");
    expect(meta.querySelector("[data-rank-by]")?.textContent).toBe("Sam Teammate placed it");
    expect(meta.textContent).not.toContain("Set aside");
    expect(meta.textContent).toContain("pri-60");
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

test("the render gallery's priority card lists its open critical milestones, and the real server's refusal leaves its client-keyed row", async () => {
  const records = renderGalleryRecords(NOW, VIEWER_ID, `team:${TEAM_ID}`, fixtureId("galleryconv"));
  useInboxStore.getState().syncTable("priorityDetails", records.priorityDetails as any, { isDelta: true });
  answers["priorities:show"] = null;
  try {
    const page = await inRouter(<EntityObjectCard refId={GALLERY_PRIORITY.short} count={1} />);
    await page.waitFor(() => !!page.container.querySelector('[data-entity-card="priority"]'));
    const card = page.container.querySelector('[data-entity-card="priority"]')!;
    expect([...card.querySelectorAll("[data-priority-milestones] [data-milestone-toggle]")].map((b) => b.getAttribute("data-milestone-toggle"))).toEqual(["s2", "s4"]);
    expect(card.querySelector("[data-rank-mark]")?.textContent).toBe("7");
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
