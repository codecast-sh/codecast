import { test, expect, describe, mock } from "bun:test";

/**
 * ct-73205: lineTrial.cards timed out in prod ("Function execution timed out",
 * eg-876). When it fails, the line page must keep painting the cards it
 * already holds rather than fall into its ErrorBoundary: the trialCards
 * feeder (useSyncTrial) hands the failure back as `error` and syncs nothing.
 *
 * Rendered for real through react-dom/server with only the transport and the
 * auth signal faked, so a feeder that re-threw would throw here.
 */

// Earlier test files stub these modules and cache the hooks against their
// stubs: restore the registry and import fresh copies bound to this transport.
mock.restore();

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQueries: (queries: Record<string, { query: unknown }>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(queries)) out[k] = new Error("[CONVEX Q(lineTrial:cards)] Server Error");
    return out;
  },
}));

const { useSyncTrial } = await import(`${import.meta.dir}/../useSyncTrial.ts?fresh`);
const { useInboxStore } = await import("../../store/inboxStore");
const { renderToStaticMarkup } = await import("react-dom/server");

describe("useSyncTrial when lineTrial.cards errors (ct-73205)", () => {
  test("renders, reports the error and keeps the cached cards", () => {
    const cached = { _id: "tc_row_1", workspace: "team:t1", short_id: "tc-1", status: "waiting", created_at: 1, updated_at: 1 };
    useInboxStore.setState({ trialCards: { [cached._id]: cached } } as any);
    let result: { ready: boolean; error?: Error } | null = null;
    function Probe() {
      result = useSyncTrial("team:t1");
      return <span data-ready={result.ready ? "yes" : "no"} />;
    }
    expect(() => renderToStaticMarkup(<Probe />)).not.toThrow();
    expect(result!.ready).toBe(false);
    expect(result!.error?.message).toContain("lineTrial:cards");
    expect((useInboxStore.getState() as any).trialCards[cached._id]).toEqual(cached);
  });
});
