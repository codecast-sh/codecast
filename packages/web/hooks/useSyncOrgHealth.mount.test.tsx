// Mounts the org health feeder (org-staffing.md S3) against a stubbed action
// and a small store and checks that it reads the fanned path the CLI reads
// (orgHealth.healthReport), hands the answer to the store's orgHealth
// singleton, keys the read on the active workspace pointer, and reports a
// failing action as a feeder error while the cached snapshot stays.
// Run: bun test hooks/useSyncOrgHealth.mount.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../components/__tests__/mockInboxStore";

restoreInboxStoreAfterAll();

describe("useSyncOrgHealth", () => {
  test("feeds the store from the fanned action, re-reads on a workspace switch, and keeps the cache on a failure", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
      Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
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
    mock.module("./useSyncCollection", () => ({ useFeederError: (feeder: string, error?: Error) => { if (error) feederErrors.push(`${feeder}: ${error.message}`); }, useSyncCollection: () => ({ ready: false }) }));
    mock.module("./useSyncOrgTree", () => ({ isMissingFunctionError: (error?: Error) => !!error && /Could not find public function/i.test(error.message ?? "") }));
    const calls: any[] = [];
    let answer: (args: any) => Promise<any> = async (args) => { calls.push(args); return { workspace: args.team_id ? { kind: "team", id: args.team_id } : { kind: "user", id: "me" }, roles: [{ role_id: "r1", short_id: "or-1", handle: "growth", load: { items_per_day: 2, decisions_per_day: 0, live_hands: 0, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 }, ledger: { open_tasks: 3, in_flight: 1, active_plans: 1 }, flags: [{ code: "wide_ledger", severity: "info", detail: "x" }] }], people: [], company: { unowned_projects: [], unfiled_tasks: 0, plans_without_goal: [], projects_without_charter: [], flags: [] }, generated_at: 1 }; };
    let actionRef: any = null;
    const realConvexReact = await import("convex/react");
    mock.module("convex/react", () => ({ ...realConvexReact, useAction: (ref: any) => { actionRef = ref; return (args: any) => answer(args); } }));
    const { getFunctionName } = await import("convex/server");
    const { useSyncOrgHealth } = await import("./useSyncOrgHealth");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    let last: any = null;
    function Probe() { last = useSyncOrgHealth(); return React.createElement("div", null, last.ready ? "ready" : "cold"); }
    const root = createRoot(document.getElementById("root")!);
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Personal workspace: the action is asked with no team, and the answer lands in the store.
    await act(async () => root.render(React.createElement(Probe)));
    await flush();
    expect(getFunctionName(actionRef)).toBe("orgHealth:healthReport");
    expect(calls).toEqual([{}]);
    expect(useInboxStore.getState().orgHealth?.roles?.[0]?.handle).toBe("growth");
    expect(last.ready).toBe(true);
    expect(last.missing).toBe(false);

    // A workspace switch re-keys the read on the team pointer.
    const team = "k97cxdv2nqef5wfm26jvrxf6fd84a30y";
    await act(async () => { useInboxStore.setState({ clientState: { ui: { active_team_id: team } } }); });
    await flush();
    expect(calls).toEqual([{}, { team_id: team }]);
    expect(useInboxStore.getState().orgHealth?.workspace).toEqual({ kind: "team", id: team });

    // A failing action: the cached snapshot stays, the error is reported, and
    // a missing function reads as `missing` for the pane's honest empty state.
    answer = async () => { throw new Error("Could not find public function for 'orgHealth:healthReport'"); };
    await act(async () => { useInboxStore.setState({ clientState: { ui: {} } }); });
    await flush();
    expect(useInboxStore.getState().orgHealth?.workspace).toEqual({ kind: "team", id: team });
    expect(last.missing).toBe(true);
    expect(last.ready).toBe(false);
    expect(feederErrors[0]).toContain("orgHealth.healthReport: Could not find public function");
    await act(async () => root.unmount());
  }, 120_000);
});
