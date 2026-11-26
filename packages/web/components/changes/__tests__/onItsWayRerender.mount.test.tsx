// The Deploys page's "On its way" grid (ct-101825) froze for up to 2.4s while live
// data arrived: one pull request moving in the store rebuilt every change as a
// new object (useRepoChanges re-assembles the whole repository, OnItsWay copies
// each change into a new row), so every memoized Row in ChangeBoard drew again,
// 350+ of them on a real repository. This mounts the real OnItsWay over the real
// store, with only the network feeders stubbed, lands 40 open pull requests, then
// moves ONE of them the way a live push does, and counts the Rows that drew.
// Only the row whose pull request moved should draw again.
// Run: bun test components/changes/__tests__/onItsWayRerender.mount.test.tsx
import { afterAll, describe, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// Count Row draws: ChangeBoard's Row draws its vehicle glyph from VEHICLE_GLYPH on
// every render, and a Row its memo skips draws none.
let glyphDraws = 0;
const realGlyphs = { ...(await import("../../../lib/changes/vehicleGlyph")) };
const Counting = () => { glyphDraws++; return null; };
mock.module("../../../lib/changes/vehicleGlyph", () => ({
  ...realGlyphs,
  VEHICLE_GLYPH: { branch: Counting, pr: Counting, commit: Counting, pass: Counting },
}));

// Feeders talk to Convex; here the test lands rows in the store itself.
const realSync = { ...(await import("../../../hooks/useSyncCollection")) };
mock.module("../../../hooks/useSyncCollection", () => ({
  ...realSync,
  useSyncCollection: () => ({ ready: true, error: null, refused: false }),
}));

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { OnItsWay } = await import("../OnItsWay");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const client = offlineConvexClient();
const { MemoryRouter } = await import("react-router");

afterAll(() => closeDomWindow(dom));

const REPO = "acme/app";
const N = 40;
const now = Date.now();
const prRow = (n: number, over: Record<string, unknown> = {}) => ({
  _id: `pr${String(n).padStart(29, "0")}`, repository: REPO, number: n, state: "open", title: `PR ${n}`, head_ref: `feat/${n}`, head_sha: `sha${n}`,
  author: "someone", created_at: now - 60 * 60_000, updated_at: now - 30 * 60_000, files_synced_at: now - 30 * 60_000,
  checks_state: "pending", review_decision: null, linked_session_ids: [], ...over,
});
const rowsDrawn = () => document.querySelectorAll("[data-change-row]").length;

describe("OnItsWay under live data", () => {
  test("one pull request moving draws only its own row again", async () => {
    const sync = (rows: any[]) => act(async () => { (useInboxStore.getState() as any).syncTable("pullRequests", rows); await new Promise((r) => setTimeout(r, 50)); });
    await sync(Array.from({ length: N }, (_, i) => prRow(i + 1)));

    const root = createRoot(document.getElementById("root")!);
    const me = { userId: "me", handle: "me" } as any;
    await act(async () => root.render(
      React.createElement(MemoryRouter, null, React.createElement(ConvexProvider, { client },
        React.createElement(OnItsWay, { repository: REPO, filters: { mine: false, group: null } as any, onFilters: () => {}, me, focus: null }))),
    ));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const shown = rowsDrawn();
    expect(shown).toBe(N);
    const perRow = glyphDraws / shown;
    expect(perRow).toBeGreaterThan(0);

    // A live push: PR 7's checks finish. The other 39 changes carry the same facts.
    glyphDraws = 0;
    await sync(Array.from({ length: N }, (_, i) => prRow(i + 1, i + 1 === 7 ? { checks_state: "success" } : {})));
    const redrawn = glyphDraws / perRow;
    expect({ rowsRedrawn: redrawn }).toEqual({ rowsRedrawn: 1 });

    await act(async () => root.unmount());
  });
});
