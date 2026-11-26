import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import { ownerFactsOf } from "../sessionOwnersSlice";
import { applySessionOwnersRead } from "../../hooks/useSyncSessionOwners";
import { adoptChange } from "../../lib/adoptDrop";

// A card dropped on another session (adopt_parent), painted on the press: the
// row leaves the viewer's inbox (its stamps), the owners read names the new
// parent, one change is sent, and undo
// detaches it from the parent and puts the viewer's row back.
const S = "s".repeat(32);
const LEAD = "l".repeat(32);
const ME = "u_me";

let sent: Array<{ action: string; args: any[] }> = [];
const owner = {};

const st = () => useInboxStore.getState() as any;

describe("applySessionOwners with adopt_parent", () => {
  beforeEach(() => {
    _resetUndoStacks();
    sent = [];
    useInboxStore.setState({
      currentUser: { _id: ME, name: "Me" } as any,
      pending: {},
      sessions: {
        [S]: { _id: S, session_id: S, short_id: "jxsess1", title: "Fix auth", user_id: ME, owners_model: true, owned_by_me: true, implicit_owner: null, org_role_id: null, owner_session_id: null, updated_at: 1 } as any,
        [LEAD]: { _id: LEAD, session_id: LEAD, short_id: "jxlead1", title: "The lead", user_id: ME, owners_model: true, owned_by_me: true, updated_at: 1 } as any,
      },
      conversations: {},
      sessionOwners: {},
      sessionAgents: { [LEAD]: { _id: LEAD, agents: [] } },
    } as any);
    useInboxStore.getState()._setDispatch(async (action, args) => {
      sent.push({ action, args });
      return null;
    }, { owner });
    applySessionOwnersRead(S, {
      session_owners: true, conversation_id: S,
      people: [{ user_id: ME, name: "Me", email: null, added_by: ME, added_at: 10 }],
      role: null, parent_session: null, implicit_starter: null, starter_id: ME, role_started: false, can_edit: true, owners_changed_at: 1,
    });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("paints the parent, the inbox stamps and the band, and sends one change", async () => {
    const { change, inverse } = adoptChange(ownerFactsOf(st(), S), st().sessionOwners[S], ME, LEAD, () => true);
    useInboxStore.getState().applySessionOwners(S, change, inverse);

    expect(st().sessions[S].owned_by_me).toBe(false);
    expect(st().sessions[S].owner_session_id).toBe(LEAD);
    expect(st().sessionOwners[S].people_ids).toEqual([]);
    expect(st().sessionOwners[S].parent_session).toEqual({ conversation_id: LEAD, short_id: "jxlead1", title: "The lead" });
    // The painted parent is what a drop's loop check reads, so dragging the
    // lead back onto it at once stays dark.
    expect(ownerFactsOf(st(), S)?.parent_conversation_id).toBe(LEAD);
    // The agents band is the server's to fill: nothing is painted there.
    expect(st().sessionAgents[LEAD].agents).toEqual([]);

    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((x) => x.action === "applySessionOwners").map((x) => x.args[1])).toEqual([{ adopt_parent: LEAD }]);
  });

  test("undo detaches it and gives the viewer the session back", async () => {
    const { change, inverse } = adoptChange(ownerFactsOf(st(), S), st().sessionOwners[S], ME, LEAD, () => true);
    useInboxStore.getState().applySessionOwners(S, change, inverse);
    await new Promise((r) => setTimeout(r, 20));
    expect(performUndo()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(st().sessions[S].owned_by_me).toBe(true);
    expect(st().sessions[S].owner_session_id).toBeNull();
    expect(st().sessionOwners[S].people_ids).toEqual([ME]);
    const last = sent.filter((x) => x.action === "applySessionOwners").at(-1)!;
    expect(last.args[1]).toEqual({ detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 10 }] });
  });

  test("someone who does not run it undoes in one step: rejoin, then detach", async () => {
    useInboxStore.setState({ sessions: { ...st().sessions, [S]: { ...st().sessions[S], user_id: "u_runner" } } } as any);
    const { change, inverse } = adoptChange(ownerFactsOf(st(), S), st().sessionOwners[S], ME, LEAD, () => true);
    expect(inverse).toEqual([{ add: [ME] }, { detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 10 }] }]);
    useInboxStore.getState().applySessionOwners(S, change, inverse);
    await new Promise((r) => setTimeout(r, 20));
    expect(st().sessions[S].owned_by_me).toBe(false);
    const before = sent.length;
    expect(performUndo()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.slice(before).filter((x) => x.action === "applySessionOwners").map((x) => x.args[1])).toEqual(inverse!);
    expect(st().sessions[S].owned_by_me).toBe(true);
    expect(st().sessions[S].owner_session_id).toBeNull();
  });
});

