// "Where your messages went" mounted in jsdom with fixed answers per workspace:
// one row per workspace with messages, busiest first, its total by the name,
// each day a stack of 1–3, 4+ and no priority, and a segment's hover card.
// Run: cd packages/web && bun test --isolate components/priorities/MessagesByWorkspace.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import type { PriorityHistory, PriorityHistoryLane } from "@codecast/shared/contracts/priorities";
import { fixtureId, installDom } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;

const VIEWER = fixtureId("breakdownviewer");
const BUSY = fixtureId("busyteam");
const QUIET = fixtureId("quietteam");
const SILENT = fixtureId("silentteam");
const DARK = fixtureId("darkteam");
const DAYS = ["2026-11-24", "2026-11-25", "2026-11-26"];

const lane = (short_id: string | null, counts: number[], owner?: string): PriorityHistoryLane => ({
  key: short_id ?? "unassigned", short_id, title: short_id ?? "Unassigned", status: short_id ? "active" : null, counts, total: counts.reduce((a, b) => a + b, 0), ...(owner ? { owner } : {}),
});
const HISTORY: Record<string, PriorityHistory> = {
  [`team:${BUSY}`]: { days: DAYS, lanes: [lane("pri-1", [2, 0, 6]), lane("pri-5", [0, 0, 2]), lane(null, [0, 0, 2]), lane("pri-9", [9, 9, 9], "Sam")] },
  [`team:${QUIET}`]: { days: DAYS, lanes: [lane(null, [1, 0, 0])] },
  [`team:${SILENT}`]: { days: DAYS, lanes: [] },
  // Priorities off there: its typing is never read.
  [`team:${DARK}`]: { days: DAYS, lanes: [lane(null, [50, 50, 50])] },
};
/** What each render asked the server for, by function and workspace. */
const asked: string[] = [];

const { getFunctionName } = await import("convex/server");
const convexReact = { ...(await import("convex/react")) };
afterAll(() => mock.module("convex/react", () => convexReact));
mock.module("convex/react", () => ({
  ...convexReact,
  useQueries: (queries: Record<string, { query: unknown; args: { workspace: string } }>) =>
    Object.fromEntries(Object.entries(queries).map(([key, q]) => {
      const name = getFunctionName(q.query as any);
      asked.push(`${name}${q.args?.workspace ? ` ${q.args.workspace}` : ""}`);
      // The ranks come from the store (seeded below), not this answer.
      if (name !== "priorities:history") return [key, undefined];
      // The personal workspace's reads fail: it draws as no messages.
      if (q.args.workspace.startsWith("user:")) return [key, new Error(`Could not find public function for '${name}'`)];
      return [key, HISTORY[q.args.workspace]];
    })),
}));

const React = await import("react");
const { act } = React as any;
const { useInboxStore } = await import("../../store/inboxStore");
const { MessagesByWorkspace } = await import("./MessagesByWorkspace");

const ON = { priorities: true };
/** The viewer, their teams, and their priorities' ranks in every workspace (priorityRanks.mine), none of them the active one. */
function seed(teams: { _id: string; name: string; features?: Record<string, boolean> }[]) {
  useInboxStore.setState({ currentUser: { _id: VIEWER, name: "Dana" } } as any);
  useInboxStore.getState().syncTable("teams", teams as any);
  useInboxStore.getState().syncTable("priorityRanks", [
    { _id: "p1", short_id: "pri-1", workspace: `team:${BUSY}`, rank: 1 },
    { _id: "p5", short_id: "pri-5", workspace: `team:${BUSY}`, rank: 5 },
  ] as any);
  asked.length = 0;
}

test("one row per workspace with messages, busiest first, each day stacked 1–3 / 4+ / none, teammates' typing left out", async () => {
  seed([{ _id: QUIET, name: "Quiet Co", features: ON }, { _id: BUSY, name: "Busy Co", features: ON }, { _id: SILENT, name: "Silent Co", features: ON }, { _id: DARK, name: "Dark Co" }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    const rows = [...page.container.querySelectorAll("[data-workspace]")];
    expect(rows.map((r) => r.getAttribute("data-workspace"))).toEqual([`team:${BUSY}`, `team:${QUIET}`]);
    // One history read per workspace with Priorities on (the personal one borrows it from the viewer's teams, as the
    // server does), none for Dark Co, and no list read: the ranks are the store's.
    expect([...new Set(asked.filter((a) => a.startsWith("priorities:")))].sort()).toEqual([
      `priorities:history team:${BUSY}`, `priorities:history team:${QUIET}`, `priorities:history team:${SILENT}`, `priorities:history user:${VIEWER}`,
    ].sort());
    // Ranks come from the store; the sync host feeds them (DashboardLayout HostFeeders, useSyncPriorityRanks).
    expect(rows.map((r) => r.querySelector("[data-workspace-total]")!.textContent)).toEqual(["12", "1"]);
    const busyDays = [...rows[0].querySelectorAll("[data-day]")];
    expect(busyDays).toHaveLength(3);
    const tiers = (d: Element) => [...d.querySelectorAll("[data-tier]")].map((t) => t.getAttribute("data-tier"));
    expect(busyDays.map(tiers)).toEqual([["top"], [], ["none", "rest", "top"]]);
    expect(busyDays.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Tue, Nov 24: 2 messages, 1–3 2, 4+ 0, no priority 0",
      "Wed, Nov 25: 0 messages, 1–3 0, 4+ 0, no priority 0",
      "Thu, Nov 26: 10 messages, 1–3 6, 4+ 2, no priority 2",
    ]);
  } finally {
    await page.unmount();
  }
}, 30_000);

test("hovering a segment shows its tier, workspace, date and shares", async () => {
  seed([{ _id: QUIET, name: "Quiet Co", features: ON }, { _id: BUSY, name: "Busy Co", features: ON }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    const top = page.container.querySelector(`[data-workspace="team:${BUSY}"]`)!.querySelectorAll("[data-day]")[2].querySelector('[data-tier="top"]')!;
    await act(async () => { top.parentElement!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
    await page.waitFor(() => document.body.textContent!.includes("Priorities 1–3"), 2_000);
    const text = document.body.textContent!;
    // Today's card names its date, as every other day's does.
    expect(text).toContain("Busy Co · Thu, Nov 26");
    expect(text).not.toContain("Today");
    // 6 of Busy Co's 10 today, and of the 10 typed anywhere today.
    expect(text).toContain("Messages6");
    expect(text).toContain("Of Busy Co that day60%");
    expect(text).toContain("Of all that day60%");
  } finally {
    await page.unmount();
  }
}, 30_000);

test("a tap on a segment (focus, as a touch screen gives it) opens the same card; the segment is no Tab stop", async () => {
  seed([{ _id: QUIET, name: "Quiet Co", features: ON }, { _id: BUSY, name: "Busy Co", features: ON }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    const rest = page.container.querySelector(`[data-workspace="team:${BUSY}"]`)!.querySelectorAll("[data-day]")[2].querySelector('[data-tier="rest"]') as HTMLElement;
    expect(rest.getAttribute("tabindex")).toBe("-1");
    await act(async () => { rest.focus(); });
    await page.waitFor(() => document.body.textContent!.includes("Priorities 4+"), 2_000);
    expect(document.body.textContent).toContain("Busy Co · Thu, Nov 26");
  } finally {
    await page.unmount();
  }
}, 30_000);

test("renders nothing when no workspace has messages, or none has Priorities on", async () => {
  seed([{ _id: SILENT, name: "Silent Co", features: ON }, { _id: DARK, name: "Dark Co" }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    expect(page.container.innerHTML).toBe("");
  } finally {
    await page.unmount();
  }
}, 30_000);
