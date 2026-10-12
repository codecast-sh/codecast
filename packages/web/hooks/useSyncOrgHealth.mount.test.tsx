// Mounts the org health feeder (org-staffing.md S3) against a stubbed action
// and a small store and checks that it reads the fanned path the CLI reads
// (orgHealth.healthReport), hands the answer to the store's orgHealth
// singleton, keys the read on the active workspace pointer, and reports a
// failing action as a feeder error while the cached snapshot stays. Several
// consumers on one workspace share a single read: one ask on mount, one
// interval, one ask per tick, and one error state.
// Run: bun test hooks/useSyncOrgHealth.mount.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../components/__tests__/mockInboxStore";

restoreInboxStoreAfterAll();

const okAnswer = (args: any) => ({ workspace: args.team_id ? { kind: "team", id: args.team_id } : { kind: "user", id: "me" }, roles: [{ role_id: "r1", short_id: "or-1", handle: "growth", load: { items_per_day: 2, decisions_per_day: 0, live_hands: 0, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 }, ledger: { open_tasks: 3, in_flight: 1, active_plans: 1 }, flags: [{ code: "wide_ledger", severity: "info", detail: "x" }] }], people: [], company: { unowned_projects: [], unfiled_tasks: 0, plans_without_goal: [], projects_without_charter: [], flags: [] }, generated_at: 1 });

type Harness = Awaited<ReturnType<typeof build>>;
let harness: Promise<Harness> | null = null;

async function build() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { create } = await import("zustand");
  // The store: the two fields the feeder reads and the one sync it writes.
  const useInboxStore: any = create((set: any) => ({
    clientState: { ui: {} },
    orgHealth: null,
    syncTable: (key: string, rows: unknown) => set({ [key]: rows }),
  }));
  mock.module("../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, isConvexId: (s: string) => /^[a-z0-9]{32}$/.test(s) }));
  const feederErrors: string[] = [];
  // Spread the real modules: a substitution is process-global, so a stub that
  // drops its other exports breaks every file that loads it afterwards.
  const realSyncCollection = { ...(await import("./useSyncCollection")) };
  mock.module("./useSyncCollection", () => ({ ...realSyncCollection, useFeederError: (feeder: string, error?: Error) => { if (error) feederErrors.push(`${feeder}: ${error.message}`); }, useSyncCollection: () => ({ ready: false }) }));
  const realOrgTree = { ...(await import("./useSyncOrgTree")) };
  mock.module("./useSyncOrgTree", () => ({ ...realOrgTree, isMissingFunctionError: (error?: Error) => !!error && /Could not find public function/i.test(error.message ?? "") }));
  const state = {
    calls: [] as any[],
    answer: (async (args: any) => okAnswer(args)) as (args: any) => Promise<any>,
    actionRef: null as any,
  };
  const realConvexReact = await import("convex/react");
  mock.module("convex/react", () => ({ ...realConvexReact, useAction: (ref: any) => { state.actionRef = ref; return (args: any) => { state.calls.push(args); return state.answer(args); }; } }));
  const { getFunctionName } = await import("convex/server");
  const { useSyncOrgHealth } = await import("./useSyncOrgHealth");
  const { createRoot } = await import("react-dom/client");
  const { act } = React;
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { React, act, createRoot, flush, useInboxStore, useSyncOrgHealth, getFunctionName, feederErrors, state };
}
const setup = () => (harness ??= build());

describe("useSyncOrgHealth", () => {
  test("feeds the store from the fanned action, re-reads on a workspace switch, and keeps the cache on a failure", async () => {
    const { React, act, createRoot, flush, useInboxStore, useSyncOrgHealth, getFunctionName, feederErrors, state } = await setup();
    let last: any = null;
    function Probe() { last = useSyncOrgHealth(); return React.createElement("div", null, last.ready ? "ready" : "cold"); }
    const root = createRoot(document.getElementById("root")!);

    // Personal workspace: the action is asked with no team, and the answer lands in the store.
    await act(async () => root.render(React.createElement(Probe)));
    await flush();
    expect(getFunctionName(state.actionRef)).toBe("orgHealth:healthReport");
    expect(state.calls).toEqual([{}]);
    expect(useInboxStore.getState().orgHealth?.roles?.[0]?.handle).toBe("growth");
    expect(last.ready).toBe(true);
    expect(last.missing).toBe(false);

    // A workspace switch re-keys the read on the team pointer.
    const team = "k97cxdv2nqef5wfm26jvrxf6fd84a30y";
    await act(async () => { useInboxStore.setState({ clientState: { ui: { active_team_id: team } } }); });
    await flush();
    expect(state.calls).toEqual([{}, { team_id: team }]);
    expect(useInboxStore.getState().orgHealth?.workspace).toEqual({ kind: "team", id: team });

    // A failing action: the cached snapshot stays, the error is reported, and
    // a missing function reads as `missing` for the pane's honest empty state.
    // Back on personal, the earlier personal answer no longer counts as fresh:
    // the store's snapshot belongs to the team now, so the read runs again.
    state.answer = async () => { throw new Error("Could not find public function for 'orgHealth:healthReport'"); };
    await act(async () => { useInboxStore.setState({ clientState: { ui: {} } }); });
    await flush();
    expect(state.calls).toEqual([{}, { team_id: team }, {}]);
    expect(useInboxStore.getState().orgHealth?.workspace).toEqual({ kind: "team", id: team });
    expect(last.missing).toBe(true);
    expect(last.ready).toBe(false);
    expect(feederErrors[0]).toContain("orgHealth.healthReport: Could not find public function");
    await act(async () => root.unmount());
  }, 120_000);

  test("two consumers on one workspace share one read: one ask on mount, one interval, one ask per tick", async () => {
    const { React, act, createRoot, flush, useInboxStore, useSyncOrgHealth, state } = await setup();
    const { ORG_HEALTH_REFRESH_MS } = await import("./useSyncOrgHealth");
    useInboxStore.setState({ clientState: { ui: {} }, orgHealth: null });
    state.calls.length = 0;
    state.answer = async (args: any) => okAnswer(args);

    // Capture the cadence intervals instead of waiting a minute for them.
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const ticks = new Map<number, () => void>();
    let nextId = 1;
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
      if (ms !== ORG_HEALTH_REFRESH_MS) return realSetInterval(fn, ms);
      const id = nextId++;
      ticks.set(id, fn);
      return id;
    };
    (globalThis as any).clearInterval = (id: any) => { if (!ticks.delete(id)) realClearInterval(id); };
    try {
      const seen: Record<string, any> = {};
      function Consumer({ name }: { name: string }) { seen[name] = useSyncOrgHealth(true); return null; }
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      const tickAll = () => act(async () => { for (const fn of ticks.values()) fn(); await new Promise((r) => setTimeout(r, 0)); });

      // The map mounts first; the sheet opens over it while the map's read is
      // still answering, and joins that read instead of asking again.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      state.answer = async (args: any) => { await gate; return okAnswer(args); };
      await act(async () => root.render(React.createElement(Consumer, { name: "map" })));
      await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Consumer, { name: "map" }), React.createElement(Consumer, { name: "sheet" }))));
      expect(state.calls.length).toBe(1);
      release();
      await flush();
      expect(seen.map.ready).toBe(true);
      expect(seen.sheet.ready).toBe(true);
      expect(ticks.size).toBe(1);

      // A third consumer mounted right after a fresh answer asks nothing.
      state.answer = async (args: any) => okAnswer(args);
      await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Consumer, { name: "map" }), React.createElement(Consumer, { name: "sheet" }), React.createElement(Consumer, { name: "third" }))));
      await flush();
      expect(state.calls.length).toBe(1);
      expect(seen.third.ready).toBe(true);
      expect(ticks.size).toBe(1);

      // Each tick is one ask, however many consumers are mounted.
      await tickAll();
      expect(state.calls.length).toBe(2);
      await tickAll();
      expect(state.calls.length).toBe(3);

      // A failure on a tick reaches every consumer, so each one's note is honest.
      state.answer = async () => { throw new Error("boom"); };
      await tickAll();
      expect(state.calls.length).toBe(4);
      for (const name of ["map", "sheet", "third"]) {
        expect(seen[name].error?.message).toBe("boom");
        expect(seen[name].ready).toBe(true);
      }

      // A manual refresh from one consumer is the same shared read.
      state.answer = async (args: any) => okAnswer(args);
      await act(async () => { await Promise.all([seen.sheet.refresh(), seen.map.refresh()]); });
      expect(state.calls.length).toBe(5);
      expect(seen.map.error).toBeUndefined();

      // The sheet closing keeps the map's cadence; the last one out stops it.
      await act(async () => root.render(React.createElement(Consumer, { name: "map" })));
      expect(ticks.size).toBe(1);
      await act(async () => root.unmount());
      expect(ticks.size).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  }, 120_000);
});
