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
const DAYS = ["2026-11-24", "2026-11-25", "2026-11-26"];

const lane = (short_id: string | null, counts: number[], owner?: string): PriorityHistoryLane => ({
  key: short_id ?? "unassigned", short_id, title: short_id ?? "Unassigned", status: short_id ? "active" : null, counts, total: counts.reduce((a, b) => a + b, 0), ...(owner ? { owner } : {}),
});
const row = (short_id: string, rank: number) => ({ short_id, rank, mine: true, status: "active" });
const HISTORY: Record<string, PriorityHistory> = {
  [`team:${BUSY}`]: { days: DAYS, lanes: [lane("pri-1", [2, 0, 6]), lane("pri-5", [0, 0, 2]), lane(null, [0, 0, 2]), lane("pri-9", [9, 9, 9], "Sam")] },
  [`team:${QUIET}`]: { days: DAYS, lanes: [lane(null, [1, 0, 0])] },
  [`team:${SILENT}`]: { days: DAYS, lanes: [] },
};
const LIST: Record<string, unknown> = {
  [`team:${BUSY}`]: { priorities: [row("pri-1", 1), row("pri-5", 5)] },
  [`team:${QUIET}`]: { priorities: [] },
  [`team:${SILENT}`]: { priorities: [] },
};

const { getFunctionName } = await import("convex/server");
const convexReact = { ...(await import("convex/react")) };
afterAll(() => mock.module("convex/react", () => convexReact));
mock.module("convex/react", () => ({
  ...convexReact,
  useQueries: (queries: Record<string, { query: unknown; args: { workspace: string } }>) =>
    Object.fromEntries(Object.entries(queries).map(([key, q]) => {
      const name = getFunctionName(q.query as any);
      // The personal workspace's reads fail: it draws as no messages.
      if (q.args.workspace.startsWith("user:")) return [key, new Error(`Could not find public function for '${name}'`)];
      return [key, (name === "priorities:history" ? HISTORY : LIST)[q.args.workspace]];
    })),
}));

const React = await import("react");
const { act } = React as any;
const { useInboxStore } = await import("../../store/inboxStore");
const { MessagesByWorkspace } = await import("./MessagesByWorkspace");

function seed(teams: { _id: string; name: string }[]) {
  useInboxStore.setState({ currentUser: { _id: VIEWER, name: "Dana" } } as any);
  useInboxStore.getState().syncTable("teams", teams as any);
}

test("one row per workspace with messages, busiest first, each day stacked 1–3 / 4+ / none, teammates' typing left out", async () => {
  seed([{ _id: QUIET, name: "Quiet Co" }, { _id: BUSY, name: "Busy Co" }, { _id: SILENT, name: "Silent Co" }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    const rows = [...page.container.querySelectorAll("[data-workspace]")];
    expect(rows.map((r) => r.getAttribute("data-workspace"))).toEqual([`team:${BUSY}`, `team:${QUIET}`]);
    expect(rows.map((r) => r.querySelector("[data-workspace-total]")!.textContent)).toEqual(["12", "1"]);
    const busyDays = [...rows[0].querySelectorAll("[data-day]")];
    expect(busyDays).toHaveLength(3);
    const tiers = (d: Element) => [...d.querySelectorAll("[data-tier]")].map((t) => t.getAttribute("data-tier"));
    expect(busyDays.map(tiers)).toEqual([["top"], [], ["none", "rest", "top"]]);
    expect(busyDays.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Tue, Nov 24: 2 messages, 1–3 2, 4+ 0, no priority 0",
      "Wed, Nov 25: 0 messages, 1–3 0, 4+ 0, no priority 0",
      "Today: 10 messages, 1–3 6, 4+ 2, no priority 2",
    ]);
  } finally {
    await page.unmount();
  }
}, 30_000);

test("hovering a segment shows its tier, workspace, date and shares", async () => {
  seed([{ _id: QUIET, name: "Quiet Co" }, { _id: BUSY, name: "Busy Co" }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    const top = page.container.querySelector(`[data-workspace="team:${BUSY}"]`)!.querySelectorAll("[data-day]")[2].querySelector('[data-tier="top"]')!;
    await act(async () => { top.parentElement!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
    await page.waitFor(() => document.body.textContent!.includes("Priorities 1–3"), 2_000);
    const text = document.body.textContent!;
    expect(text).toContain("Busy Co · Today");
    // 6 of Busy Co's 10 today, and of the 10 typed anywhere today.
    expect(text).toContain("Messages6");
    expect(text).toContain("Of Busy Co that day60%");
    expect(text).toContain("Of all that day60%");
  } finally {
    await page.unmount();
  }
}, 30_000);

test("renders nothing when no workspace has messages", async () => {
  seed([{ _id: SILENT, name: "Silent Co" }]);
  const page = await mountSurface(<MessagesByWorkspace days={DAYS} todayIndex={2} />);
  try {
    expect(page.container.innerHTML).toBe("");
  } finally {
    await page.unmount();
  }
}, 30_000);
