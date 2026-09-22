import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * THE AVATAR BAR SURVIVES ITS ROSTER QUERY FAILING.
 *
 * The reported outage, end to end: on 2026-09-21 a half-saved edit of
 * teams.getTeamMembers reached prod for about a minute (the convex dev watcher
 * pushes every save, and its typecheck reads the disk after the bundle was
 * built), so every subscriber got
 *   Uncaught ReferenceError: feedFilter is not defined
 * The pump inside the bar subscribed with a plain useQuery, which re-throws a
 * terminal server error during render; the ErrorBoundary around the bar
 * latched on it and painted "Failed to load TeamAvatarBar" — and kept painting
 * it for hours after prod had recovered, because a boundary only lets go on a
 * manual retry.
 *
 * The pump is a FEEDER (CLAUDE.md, "Local-first is the law"): the bar paints
 * the teamMembers collection, and the query only refills it. So a failing
 * query may cost the bar freshness and nothing else — the render must not
 * throw, and the cached roster must still be there afterwards.
 *
 * Rendered for real through react-dom/server with only the Convex transport
 * faked, the way useSyncCollection's own tests do, so a regression shows up as
 * the throw it would be in the browser.
 */

// Earlier test files stub these modules and cache the hooks against their
// stubs: restore the registry and import fresh copies bound to the transport
// installed here.
mock.restore();

const serverError = new Error(
  "[CONVEX Q(teams:getTeamMembers)] [Request ID: 0503c315358bdbbd] Server Error\n" +
    "Uncaught ReferenceError: feedFilter is not defined\n    at <anonymous> (../convex/teams.ts:481:15)",
);

const convexReact = await import("convex/react");
afterAll(() => mock.module("convex/react", () => convexReact));
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  // Convex's own contract: useQueries hands a terminal error back as the
  // value, and useQuery is useQueries plus a re-throw of exactly that value.
  useQueries: () => ({ value: serverError }),
  useQuery: () => {
    throw serverError;
  },
}));

const { TeamMembersPump } = await import(`${import.meta.dir}/../TeamAvatarBar.tsx?fresh`);
const { useInboxStore } = await import("../../store/inboxStore");
const { renderToStaticMarkup } = await import("react-dom/server");

const TEAM_ID = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg" as any;
const CACHED_ROSTER = [
  { _id: "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7", name: "Alexander Green", email: "alex@genos.dev", role: "admin", presence_state: "active" },
  { _id: "kd78n5cgr6n8cps77ry3d9hn3h8evvwe", name: "Krithik Suvarna", email: "krithik@littlebird.ai", role: "member", presence_state: "offline" },
];

describe("TeamMembersPump — a terminal server error degrades to the cached roster", () => {
  test("the pump renders through the error instead of throwing into the bar's boundary", () => {
    useInboxStore.getState().syncTable("teamMembers", CACHED_ROSTER);
    expect(() => renderToStaticMarkup(<TeamMembersPump teamId={TEAM_ID} />)).not.toThrow();
    const names = useInboxStore.getState().teamMembers.map((m: any) => m.name);
    expect(names).toEqual(["Alexander Green", "Krithik Suvarna"]);
  });
});
