import { test, expect, describe, mock } from "bun:test";

/**
 * The boot ordering contract: a feeder does not send its query until the
 * server has confirmed the caller.
 *
 * AuthGuard releases the app on the LOCAL auth signal so a warm cache paints
 * offline, which means every feeder in the shell mounts while the websocket is
 * still unauthenticated. Before this gate, externalEvents:listForTeam and
 * agentDefinitions:list fired in that window, their requireUser/requireCaller
 * threw UNAUTHENTICATED, and useFeederError reported it as a production error
 * on every load of /inbox (Sentry JAVASCRIPT-REACT-5Q and -5P). A guest on a
 * public share link threw the same way and never recovered.
 *
 * Rendered for real through react-dom/server with only the transport and the
 * auth signal faked, so a regression shows up as a query that was actually
 * sent.
 */

// Same two hazards as useQueryNoThrow's test: earlier test files stub these
// modules and cache the hook against their stubs, so restore the registry and
// import a fresh copy bound to the transport installed here.
mock.restore();

const { makeFunctionReference } = await import("convex/server");
const TEAM_EVENTS = makeFunctionReference<"query">("externalEvents:listForTeam");

let authenticated = false;
let authThrows = false;
let sent: Record<string, unknown> = {};

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => {
    // Convex's own behaviour when no auth provider is an ancestor.
    if (authThrows) throw new Error("Could not find `ConvexProviderWithAuth` as an ancestor component.");
    return { isAuthenticated: authenticated, isLoading: !authenticated };
  },
  useQueries: (queries: Record<string, unknown>) => {
    sent = queries;
    return {};
  },
}));

const { useSyncCollection } = await import(`${import.meta.dir}/../useSyncCollection.ts?fresh`);
const { authSettledLatch } = await import(`${import.meta.dir}/../useServerAuthSettled.ts?fresh`);
const { renderToStaticMarkup } = await import("react-dom/server");

function renderFeeder() {
  sent = {};
  function Probe() {
    const { ready } = useSyncCollection("externalEvents", TEAM_EVENTS, { limit: 200 });
    return <span data-ready={ready ? "yes" : "no"} />;
  }
  renderToStaticMarkup(<Probe />);
  return Object.keys(sent).length > 0;
}

describe("useSyncCollection — the authenticated-feeder gate", () => {
  test("sends nothing while the server has not confirmed the caller", () => {
    authenticated = false;
    expect(renderFeeder()).toBe(false);
  });

  test("sends the query once the server has confirmed the caller", () => {
    authenticated = true;
    expect(renderFeeder()).toBe(true);
  });

  test("subscribes as before when there is no auth provider at all", () => {
    // useConvexAuth THROWS without a ConvexProviderWithAuth ancestor instead
    // of reporting "not authenticated", so a tree that mounts a feeder under a
    // plain ConvexProvider (the hibernation harness, _chatpage, an embed) would
    // crash on render rather than degrade — trading a noisy report for a dead
    // surface. No auth handshake means no race to gate on.
    const threw = authThrows;
    authThrows = true;
    try {
      expect(renderFeeder()).toBe(true);
    } finally {
      authThrows = threw;
    }
  });
});

describe("authSettledLatch", () => {
  test("opens on the first confirmation", () => {
    expect(authSettledLatch(false, false)).toBe(false);
    expect(authSettledLatch(false, true)).toBe(true);
  });

  test("stays open through a token refresh dropping the signal", () => {
    // Un-latching would unsubscribe every feeder and re-push every collection
    // into the store when the refreshed token landed.
    expect(authSettledLatch(true, false)).toBe(true);
  });
});
