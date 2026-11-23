// A session its role drives waits on the role, not on a person (shared
// roleDrives / personWorkState): the inbox files it Working, "With <role>",
// and nothing else in the client may put it on a person. The chime, the
// project counts, a card drawn with no section, the palette, a worker's
// "needs you" on its parent row, the state mods read, the fleet board and
// the decision queue all agree.
import { describe, expect, it } from "bun:test";
import { railRowPlacement, sessionPlacement, type InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";
import { shouldPlayWaitingSound, waitingSoundKey } from "../../hooks/useSyncInboxSessions";
import { countsDigest } from "../../hooks/useProjectSessionCounts";
import { sessionStatusOf } from "../../lib/sessionStatus";
import { sessionStanding, standingMark } from "../../lib/instantSessionSearch";
import { present } from "../../lib/mods/collectionQuery";
import { fleetBandFor } from "../../components/fleetBands";
import { buildDecisionQueue } from "../../hooks/useDecisionQueue";

const T0 = Date.now();
const ME = "u1000000000000000000000000000001";
const ID = "r1z2000000000000000000000000000a";
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id, session_id: `sess-${id}`, agent_type: "claude_code", agent_status: "idle", is_idle: true,
  has_pending: false, message_count: 3, updated_at: T0 - 60_000, agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false, title: id, ...(over as any),
});
// Settled on its last turn, filed under a role nobody took over.
const driven = row(ID, { user_id: ME, owner_user_id: ME, owned_by_me: true, org_role_id: "org_roles_infra", project_id: "proj1" } as any);
// The same session with the role paused: a person drives, so it is theirs.
const paused = { ...driven, driver_user_id: ME } as InboxSession;
const asking = (s: InboxSession) => ({ ...s, awaiting_input: true }) as InboxSession;

describe("a role-driven wait never reaches a person", () => {
  it("the inbox files it Working", () => {
    const placed = placeSections({ [ID]: driven }, new Set(), undefined, { currentUser: { _id: ME } });
    expect(placed.needsInput).toEqual([]);
    expect(placed.working.map((s) => s._id)).toEqual([ID]);
  });

  it("no chime; a paused role's wait chimes", () => {
    expect(waitingSoundKey(driven, new Set())).toBeNull();
    expect(shouldPlayWaitingSound([driven], new Set(), new Map([[ID, false]]), new Map()).play).toBe(false);
    expect(waitingSoundKey(paused, new Set())).toBe(`${ID}:3:idle`);
  });

  it("project counts read it working", () => {
    const digest = (s: InboxSession) => countsDigest({ sessions: { [ID]: s }, sessionProjects: {} } as any, "*", null, T0, { current: null });
    expect(digest(driven)).toBe("proj1=working:1");
    expect(digest(paused)).toBe("proj1=needs_input:1");
  });

  it("a card with no section shows its ask as Working", () => {
    const a = asking(driven);
    expect(sessionStatusOf({ row: a as any, section: null, placement: railRowPlacement(a, T0), now: T0, live: { asking: true } })).toBe("working");
    expect(sessionStatusOf({ row: a as any, section: null, placement: null, now: T0, live: { asking: true } })).not.toBe("needs_you");
    const p = asking(paused);
    expect(sessionStatusOf({ row: p as any, section: null, placement: railRowPlacement(p, T0), now: T0, live: { asking: true } })).toBe("needs_you");
  });

  it("the palette neither lifts nor marks it", () => {
    expect(standingMark(sessionStanding(driven as any, ME, driven))).toBe("working");
    expect(standingMark(sessionStanding(driven as any, ME, sessionPlacement(driven, T0)))).toBe("working");
    expect(standingMark(sessionStanding(paused as any, ME, paused))).toBe("needs_input");
  });

  it("a mod reads it working", () => {
    expect(present("sessions", driven).state).toBe("working");
    expect(present("sessions", paused).state).toBe("needs_input");
  });

  it("a role-driven workflow sub does not name itself on its host row", () => {
    const host = row("host1", { agent_status: "working", is_idle: false, workflow_run_id: "run1" } as any);
    const sub = row("sub1", { workflow_run_id: "run1", is_workflow_sub: true, awaiting_input: true, org_role_id: "org_roles_infra" } as any);
    const placed = placeSections({ host1: host, sub1: sub }, new Set(), new Set(), { modern: true });
    expect(placed.workersNeedingYouByParent.has("host1")).toBe(false);
    const theirs = row("sub1", { workflow_run_id: "run1", is_workflow_sub: true, awaiting_input: true } as any);
    expect([...(placeSections({ host1: host, sub1: theirs }, new Set(), new Set(), { modern: true }).workersNeedingYouByParent.get("host1") ?? [])].map((s) => s._id)).toEqual(["sub1"]);
  });

  it("the fleet board files it running", () => {
    const opts = { queued: new Set<string>(), pendingSendIds: new Set<string>(), now: T0 };
    expect(fleetBandFor(asking(driven), opts)).toBe("running");
    expect(fleetBandFor(asking(paused), opts)).toBe("needsYou");
  });

  it("the decision queue leaves its ask to the role", () => {
    const queue = (s: InboxSession) => buildDecisionQueue({}, { [ID]: asking(s) }, undefined, ME).map((i) => i.conversationId);
    expect(queue(driven)).toEqual([]);
    expect(queue(paused)).toEqual([ID]);
  });
});
