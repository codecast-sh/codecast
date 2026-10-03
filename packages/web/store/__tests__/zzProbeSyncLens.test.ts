// TEMPORARY probe (validation round 3, sync lens). Deleted after the run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

const s = () => useInboxStore.getState() as any;
const CONV = "c".repeat(32);
const REAL = "a".repeat(32);
const USER = "u".repeat(32);
let calls: Array<[string, unknown[]]> = [];
const owner = {};

beforeAll(() => {
  s()._setDispatch(async (action: string, args: unknown[]) => {
    calls.push([action, args]);
    return null;
  }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  calls = [];
});

describe("bucket filing undo after the server row superseded the stub", () => {
  it("undo after echo, then later server pushes for the row", () => {
    useInboxStore.setState({ bucketAssignments: {}, pending: {} } as any);
    s().assignSessionToBucket(CONV, "bkt_a");
    console.log("after forward", JSON.stringify(s().bucketAssignments), JSON.stringify(Object.fromEntries(Object.entries(s().pending).filter(([k]) => k.startsWith("bucketAssignments")))));
    // The server's echo: the real row supersedes the stub.
    s().syncTable("bucketAssignments", [{ _id: REAL, user_id: USER, conversation_id: CONV, bucket_id: "bkt_a", updated_at: 5 }]);
    console.log("after echo", JSON.stringify(s().bucketAssignments), JSON.stringify(Object.fromEntries(Object.entries(s().pending).filter(([k]) => k.startsWith("bucketAssignments")))));
    calls = [];
    const did = performUndo();
    console.log("undo returned", did, "calls", JSON.stringify(calls));
    console.log("after undo", JSON.stringify(s().bucketAssignments), JSON.stringify(Object.fromEntries(Object.entries(s().pending).filter(([k]) => k.startsWith("bucketAssignments")))));
    // The server's echo of the unfile: the row stays, bucket_id unset.
    s().syncTable("bucketAssignments", [{ _id: REAL, user_id: USER, conversation_id: CONV, updated_at: 6 }]);
    console.log("after unfile echo", JSON.stringify(s().bucketAssignments), JSON.stringify(Object.fromEntries(Object.entries(s().pending).filter(([k]) => k.startsWith("bucketAssignments")))));
    // Later the session is labeled from another device (or the CLI).
    s().syncTable("bucketAssignments", [{ _id: REAL, user_id: USER, conversation_id: CONV, bucket_id: "bkt_e", updated_at: 7 }]);
    console.log("after remote relabel", JSON.stringify(s().bucketAssignments), JSON.stringify(Object.fromEntries(Object.entries(s().pending).filter(([k]) => k.startsWith("bucketAssignments")))));
    expect(s().bucketAssignments[REAL]?.bucket_id).toBe("bkt_e");
  });
});

describe("unpin undo after the server echo omits the cleared stamp", () => {
  it("undo of an unpin after the echo", () => {
    const ID = "p".repeat(32);
    const PINNED_AT = 1700000000000;
    useInboxStore.setState({
      pending: {},
      currentUser: { _id: USER } as any,
      sessions: { [ID]: { _id: ID, user_id: USER, title: "Pinned one", updated_at: 1, is_pinned: true, inbox_pinned_at: PINNED_AT } } as any,
      conversations: { [ID]: { _id: ID, user_id: USER, title: "Pinned one", inbox_pinned_at: PINNED_AT } } as any,
    } as any);
    s().pinSession(ID); // toggles off
    console.log("after unpin", JSON.stringify(s().sessions[ID]), JSON.stringify(s().conversations[ID]));
    // Convex omits a cleared optional stamp: the echo has no inbox_pinned_at.
    s().syncTable("sessions", [{ _id: ID, user_id: USER, title: "Pinned one", updated_at: 2, is_pinned: false }]);
    s().syncTable("conversations", [{ _id: ID, user_id: USER, title: "Pinned one" }]);
    console.log("after echo", JSON.stringify(s().sessions[ID]), JSON.stringify(s().conversations[ID]), JSON.stringify(Object.keys(s().pending).filter((k) => k.includes(ID))));
    const { getUndoHistory } = require("@platform/engine");
    performUndo();
    const it0: any = getUndoHistory().items[0];
    console.log("undo status", it0.status, it0.label);
    console.log("after undo", JSON.stringify(s().sessions[ID]), JSON.stringify(s().conversations[ID]));
    expect(s().conversations[ID].inbox_pinned_at).toBe(PINNED_AT);
  });
});
