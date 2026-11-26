import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, bootLandingSession, sortSessions, type InboxSession } from "../inboxStore";
import { _resetViewNavForTests } from "../viewNav";

// ct-101806: a cold open of the inbox (feed home, nothing named in the address,
// no position of this client's own) adopted whatever session sorted first. When
// that was a teammate's summary-only session, a new customer needed Activity →
// Mine → row → Open (four steps, 45s) to reach their own session. A cold open
// should land on the viewer's own top session when they have one.

const ME = "user_me";
const TEAMMATE = "user_teammate";

const session = (id: string, fields: Partial<InboxSession>): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  ...fields,
} as InboxSession);

// Sorts first: most recent, someone else's, shared to the team as summary only.
const teammateSummary = session("convTeammate", {
  updated_at: 100,
  user_id: TEAMMATE,
  author_name: "Teammate",
  team_id: "team_1",
  team_visibility: "summary",
});
const mine = session("convMine", { updated_at: 50, user_id: ME });

beforeEach(() => {
  _resetViewNavForTests();
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    clientState: { ui: { inbox_home: "feed" } },
    clientStateInitialized: true,
    currentUser: { _id: ME, name: "Me" } as any,
    currentSessionId: null,
    lastFocusedConversationId: null,
    pendingNavigateId: null,
    viewingDismissedId: null,
    showMySessions: false,
    pending: {},
  } as any);
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("inbox cold open picks the viewer's own session (ct-101806)", () => {
  it("opens the viewer's own session, not a teammate's summary-only one sorted above it", () => {
    useInboxStore.getState().syncTable("sessions", [teammateSummary, mine]);
    expect(useInboxStore.getState().currentSessionId).toBe("convMine");
  });

  it("guard: a viewer with no sessions of their own still opens the top row", () => {
    useInboxStore.getState().syncTable("sessions", [teammateSummary]);
    expect(useInboxStore.getState().currentSessionId).toBe("convTeammate");
  });

  it("guard: a link to the teammate's session still opens it", () => {
    (globalThis as any).window = { location: { pathname: "/inbox", search: "?s=convTeammate" } };
    useInboxStore.getState().syncTable("sessions", [teammateSummary, mine]);
    expect(useInboxStore.getState().currentSessionId).toBe("convTeammate");
  });

  it("guard: board home shows the fleet and adopts nothing", () => {
    useInboxStore.setState({ clientState: { ui: { inbox_home: "board" } } } as any);
    useInboxStore.getState().syncTable("sessions", [teammateSummary, mine]);
    expect(useInboxStore.getState().currentSessionId).toBeNull();
    expect(useInboxStore.getState().showMySessions).toBe(true);
  });

  it("guard: a teammate's session sorting to the top after the first view does not move it", () => {
    useInboxStore.getState().syncTable("sessions", [mine]);
    expect(useInboxStore.getState().currentSessionId).toBe("convMine");
    useInboxStore.getState().syncTable("sessions", [{ ...teammateSummary, updated_at: 500 }]);
    expect(useInboxStore.getState().currentSessionId).toBe("convMine");
  });
});

// QueuePageClient's adopt effect calls the same helper over its sorted list.
describe("bootLandingSession", () => {
  const sorted = sortSessions({ convTeammate: teammateSummary, convMine: mine });

  it("picks the viewer's own top row over someone else's above it", () => {
    expect(sorted[0]._id).toBe("convTeammate");
    expect(bootLandingSession(sorted, ME)?._id).toBe("convMine");
  });

  it("falls back to the top row when the viewer has none of their own", () => {
    expect(bootLandingSession([teammateSummary], ME)?._id).toBe("convTeammate");
  });

  it("takes the top row when the viewer is unknown", () => {
    expect(bootLandingSession(sorted, null)?._id).toBe("convTeammate");
  });

  it("counts a session the viewer co-owns as theirs", () => {
    const coOwned = { ...teammateSummary, _id: "convCoOwned", owned_by_me: true } as InboxSession;
    expect(bootLandingSession([coOwned, mine], ME)?._id).toBe("convCoOwned");
  });
});
