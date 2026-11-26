// A priority as an object, mounted in jsdom over a convex transport that
// answers by name (test-helpers/missingBackend.tsx) with priorities.show's
// contract. Proves: `pri-N` in a message is a pill (title, critical meter,
// n/m) that opens /priorities/pri-N; hovering it shows the card (owner, rank
// and who placed it, Next with the list's one action, summary, Share and
// Open); on a touch screen a tap opens the same card as a bottom sheet; alone
// on a line it is the card; and the page at /priorities/pri-N draws its rank
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
  status: "active", rank: 7, rank_set_by: "pass", status_set_by: "pass", serves: null,
  steps: [
    step("s1", "Priorities live behind a flag", "critical", true, { done_at: NOW - 2 * HOUR }),
    step("s2", "Calibrate goal finding and session mapping", "critical"),
    step("s3", "Turn on for the Union team", "critical", true, { done_at: NOW - DAY }),
    step("s4", "Session mapping reaches 0.75", "critical"),
    step("p1", "Priorities page redesign", "polish"),
  ],
  counts: { critical_done: 2, critical_total: 4 },
  workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", mine: true,
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

test("pri-N in a message is a pill: target, title, critical meter, and it opens the priority's page", async () => {
  const page = await inRouter(<p>Can you pick up <EntityIdPill shortId="pri-60" /> next?</p>);
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-priority-pill]"));
    expect(describeFailures(page)).toBe("");
    const pill = page.container.querySelector("[data-priority-pill]") as HTMLAnchorElement;
    expect(pill.getAttribute("href")).toBe("/priorities/pri-60");
    expect(pill.textContent).toContain("Priorities for Union");
    expect(pill.querySelector("[data-critical-meter]")?.textContent).toBe("2/4");
    expect(pill.querySelector("svg")).not.toBeNull();
    // The row went through the store, as every surface reads it.
    expect(Object.values((useInboxStore.getState() as any).priorityDetails).map((r: any) => r.short_id)).toEqual(["pri-60"]);
  } finally {
    await page.unmount();
  }
});

test("hovering the pill shows the card: owner, rank and who placed it, Next with its Answer, summary, Share and Open", async () => {
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
    expect(text).toContain("You");
    expect(text).toContain("#7");
    expect(text).toContain("ranked by AI");
    // Next is the list's rule: the most recent ask is answered first.
    const next = card.querySelector("[data-priority-next]")!;
    expect(next.textContent).toContain("Calibrate goal finding and session mapping");
    expect(next.querySelector('[data-action="answer"]')?.getAttribute("href")).toBe(`/conversation/${fixtureId("build")}`);
    expect(text).toContain("session mapping sits around 0.65");
    expect(card.querySelector("[data-priority-share]")).not.toBeNull();
    expect(card.querySelector("[data-priority-open]")?.getAttribute("href")).toBe("/priorities/pri-60");
  } finally {
    await page.unmount();
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
    expect(sheet.querySelector('[data-action="answer"]')).not.toBeNull();
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
    expect(card.querySelector('[data-action="answer"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});

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
