import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performRedo, performUndo, undoEntry } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

// Each work spec with an inverse names its server half explicitly. These
// check that the undo of each gesture dispatches the right action with the
// prior value, and that the gestures no verb can take back record nothing.
const CONV = "c".repeat(32);
const ME = "u".repeat(32);
const SAM = "s".repeat(32);
const KIM = "k".repeat(32);
const TEAM = "t".repeat(32);

const s = () => useInboxStore.getState() as any;
let calls: Array<[string, unknown[]]> = [];
const owner = {};

beforeAll(() => {
  // Receipt actions (editComment) expect their command acknowledged.
  s()._setDispatch(async (action: string, args: unknown[], _patches: unknown, result: any) => {
    calls.push([action, args]);
    return result?.receiptActionVersion ? { commandId: result.commandId, status: "acknowledged", result: null } : null;
  }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  calls = [];
  useInboxStore.setState({ pending: {}, currentUser: { _id: ME, name: "Me" } } as any);
});

/** Run the gesture, then its undo (by the toast's id, so confirm specs undo too); return what the undo dispatched. */
function undoOf(gesture: () => void): Array<[string, unknown[]]> {
  gesture();
  const entry = getUndoHistory().items[0];
  expect(entry?.status).toBe("done");
  calls = [];
  expect(undoEntry(entry!.id)).toBe(true);
  return calls;
}

const label = () => getUndoHistory().items[0]?.label;

describe("conversation inverses", () => {
  const seed = (fields: Record<string, unknown>) =>
    useInboxStore.setState({
      sessions: { [CONV]: { _id: CONV, title: "Auth fix", ...fields } },
      conversations: { [CONV]: { _id: CONV, title: "Auth fix", ...fields } },
    } as any);

  it("switchProject goes back to the prior path", () => {
    seed({ project_path: "/src/a", git_root: "/src/a" });
    expect(undoOf(() => s().switchProject(CONV, "/src/b"))).toEqual([["switchProject", [CONV, "/src/a"]]]);
    expect(s().conversations[CONV].project_path).toBe("/src/a");
  });

  it("switchProject undo writes git_root as the server will, so the echo of a subdirectory session retires every lock", () => {
    seed({ project_path: "/src/repo/sub", git_root: "/src/repo" });
    expect(undoOf(() => s().switchProject(CONV, "/src/b"))).toEqual([["switchProject", [CONV, "/src/repo/sub"]]]);
    // The server's switchProject stores git_root = path.
    expect(s().conversations[CONV]).toMatchObject({ project_path: "/src/repo/sub", git_root: "/src/repo/sub" });
    for (const store of ["conversations", "sessions"]) {
      s().syncTable(store, [{ ...s()[store][CONV], project_path: "/src/repo/sub", git_root: "/src/repo/sub" }], { isDelta: true });
      expect(s()[store][CONV].git_root).toBe("/src/repo/sub");
    }
    expect(Object.keys(s().pending).filter((k) => k.includes(CONV))).toEqual([]);
  });

  it("switchProject undo of a session with no git_root also stores the server's spelling", () => {
    seed({ project_path: "/tmp/scratch" });
    undoOf(() => s().switchProject(CONV, "/src/b"));
    expect(s().conversations[CONV].git_root).toBe("/tmp/scratch");
  });

  it("making a shared session private is undone by sharing it at its prior level, and blind undo stops at it", () => {
    seed({ is_private: false, team_visibility: "summary", team_id: TEAM });
    s().setPrivacy(CONV, true);
    expect(label()).toBe("Made “Auth fix” private");
    // confirm: a blind keypress names the entry and does not widen access.
    calls = [];
    performUndo();
    expect(s().conversations[CONV].is_private).toBe(true);
    expect(calls).toEqual([]);
    calls = [];
    undoEntry(getUndoHistory().items[0]!.id);
    expect(calls).toEqual([["setTeamVisibility", [CONV, "summary"]]]);
    expect(s().conversations[CONV]).toMatchObject({ is_private: false, team_visibility: "summary" });
  });

  it("an accidental share is taken back by blind undo, which makes the session private again", () => {
    seed({ is_private: true, team_visibility: "private" });
    s().setPrivacy(CONV, false);
    expect(getUndoHistory().items[0]?.confirm).toBeUndefined();
    calls = [];
    performUndo();
    expect(calls).toEqual([["setPrivacy", [CONV, true]]]);
    expect(s().conversations[CONV].is_private).toBe(true);
  });

  it("setTeamVisibility goes back to the prior level, or to private", () => {
    seed({ is_private: false, team_visibility: "summary", team_id: TEAM });
    expect(undoOf(() => s().setTeamVisibility(CONV, "full"))).toEqual([["setTeamVisibility", [CONV, "summary"]]]);
    _resetUndoStacks();
    seed({ is_private: true, team_visibility: "private" });
    expect(undoOf(() => s().setTeamVisibility(CONV, "full"))).toEqual([["setPrivacy", [CONV, true]]]);
  });

  it("unsharing a session born private leaves no lock its echo cannot retire", () => {
    // The server creates private sessions with no team_visibility; its
    // setPrivacy(true) then stores "private".
    for (const share of [() => s().setTeamVisibility(CONV, "full"), () => s().setPrivacy(CONV, false)]) {
      _resetUndoStacks();
      useInboxStore.setState({ pending: {} } as any);
      seed({ is_private: true });
      expect(undoOf(share)).toEqual([["setPrivacy", [CONV, true]]]);
      for (const store of ["conversations", "sessions"]) {
        s().syncTable(store, [{ ...s()[store][CONV], is_private: true, team_visibility: "private" }], { isDelta: true });
        expect(s()[store][CONV]).toMatchObject({ is_private: true, team_visibility: "private" });
      }
      expect(Object.keys(s().pending).filter((k) => k.includes(CONV))).toEqual([]);
    }
  });

  // Undo of these returns through setTeamVisibility, which assigns a team to a
  // conversation that has none: wider than the state being restored.
  it("records nothing when the prior audience cannot be restored", () => {
    const recorded = (fields: Record<string, unknown>, gesture: () => void) => {
      _resetUndoStacks();
      seed(fields);
      gesture();
      return getUndoHistory().items.length;
    };
    // Prior is_private unknown on both store copies.
    expect(recorded({}, () => s().setPrivacy(CONV, true))).toBe(0);
    expect(recorded({ team_id: TEAM }, () => s().setTeamVisibility(CONV, "full"))).toBe(0);
    // Shared with no team: sharing again would pick one.
    expect(recorded({ is_private: false }, () => s().setPrivacy(CONV, true))).toBe(0);
    expect(recorded({ is_private: false }, () => s().setTeamVisibility(CONV, "summary"))).toBe(0);
    // Known on one copy is known.
    _resetUndoStacks();
    useInboxStore.setState({
      sessions: { [CONV]: { _id: CONV, title: "Auth fix", is_private: false, team_id: TEAM } },
      conversations: {},
    } as any);
    s().setPrivacy(CONV, true);
    expect(label()).toBe("Made “Auth fix” private");
  });

  it("setTeamVisibility confirms only an undo that would widen the audience", () => {
    const confirmOf = (from: Record<string, unknown>, to: "summary" | "full" | null) => {
      _resetUndoStacks();
      seed({ ...from, team_id: TEAM });
      s().setTeamVisibility(CONV, to);
      return getUndoHistory().items[0]?.confirm === true;
    };
    expect(confirmOf({ is_private: false, team_visibility: "full" }, "summary")).toBe(true);
    expect(confirmOf({ is_private: false, team_visibility: "summary" }, "full")).toBe(false);
    expect(confirmOf({ is_private: true, team_visibility: "private" }, "summary")).toBe(false);
    // The member default cannot be ordered against a level, so either way confirms.
    expect(confirmOf({ is_private: false }, "summary")).toBe(true);
    expect(confirmOf({ is_private: false, team_visibility: "summary" }, null)).toBe(true);
  });

  // An inbox row never opened in this window has no conversations row: the
  // gesture writes a thin one. These inverses set the field back on the
  // server (they do not clear it), so the undo must write and lock the inbox
  // row's prior value on the thin row, never an absent one.
  describe("on an inbox row with no conversations meta", () => {
    const inboxOnly = (fields: Record<string, unknown>) =>
      useInboxStore.setState({ sessions: { [CONV]: { _id: CONV, title: "Auth fix", ...fields } }, conversations: {} } as any);
    const convLocks = () => Object.keys(s().pending).filter((k) => k.startsWith(`conversations:${CONV}`));
    const echo = (fields: Record<string, unknown>) => {
      // The lock layer retires a lock on the second sight of its value.
      for (let i = 0; i < 2; i++) s().syncTable("conversations", [{ _id: CONV, title: "Auth fix", ...fields }], { isDelta: true });
    };

    it("setPrivacy undo restores the prior audience, and the meta's echo retires every lock", () => {
      const prior = { is_private: false, team_visibility: "full", team_id: TEAM };
      inboxOnly(prior);
      expect(undoOf(() => s().setPrivacy(CONV, true))).toEqual([["setTeamVisibility", [CONV, "full"]]]);
      expect(s().conversations[CONV]).toMatchObject({ is_private: false, team_visibility: "full" });
      echo(prior);
      expect(s().conversations[CONV]).toMatchObject(prior);
      expect(convLocks()).toEqual([]);
    });

    it("setTeamVisibility undo back to private does the same", () => {
      inboxOnly({ is_private: true });
      expect(undoOf(() => s().setTeamVisibility(CONV, "full"))).toEqual([["setPrivacy", [CONV, true]]]);
      echo({ is_private: true, team_visibility: "private" });
      expect(s().conversations[CONV]).toMatchObject({ is_private: true, team_visibility: "private" });
      expect(convLocks()).toEqual([]);
    });

    it("switchProject undo does the same for the path and its git_root", () => {
      inboxOnly({ project_path: "/src/a", git_root: "/src/a" });
      expect(undoOf(() => s().switchProject(CONV, "/src/b"))).toEqual([["switchProject", [CONV, "/src/a"]]]);
      expect(s().conversations[CONV]).toMatchObject({ project_path: "/src/a", git_root: "/src/a" });
      echo({ project_path: "/src/a", git_root: "/src/a" });
      expect(s().conversations[CONV]).toMatchObject({ project_path: "/src/a", git_root: "/src/a" });
      expect(convLocks()).toEqual([]);
    });

    it("a field the inbox row does not carry is left unlocked", () => {
      // No git_root on the inbox row: the undo spells it as the server will.
      inboxOnly({ project_path: "/tmp/scratch" });
      undoOf(() => s().switchProject(CONV, "/src/b"));
      echo({ project_path: "/tmp/scratch", git_root: "/tmp/scratch" });
      expect(s().conversations[CONV]).toMatchObject({ project_path: "/tmp/scratch", git_root: "/tmp/scratch" });
      expect(convLocks()).toEqual([]);
    });

    it("redo after the undo makes the session private again", () => {
      inboxOnly({ is_private: false, team_visibility: "full", team_id: TEAM });
      undoOf(() => s().setPrivacy(CONV, true));
      expect(performRedo()).toBe(true);
      expect(s().conversations[CONV]).toMatchObject({ is_private: true, team_visibility: "private" });
    });
  });

  // An older or filed session opened by link or search: its meta is loaded
  // and no inbox row stands behind it. A field with no prior value was really
  // unset there, so the undo clears it, as the inverse does on the server.
  describe("on a loaded conversation with no inbox row", () => {
    const loaded = (fields: Record<string, unknown>) => ({ _id: CONV, title: "Auth fix", message_count: 3, _creationTime: 5, ...fields });
    const metaOnly = (fields: Record<string, unknown>) =>
      useInboxStore.setState({ sessions: {}, conversations: { [CONV]: loaded(fields) } } as any);
    const convLocks = () => Object.keys(s().pending).filter((k) => k.startsWith(`conversations:${CONV}`));
    const echo = (fields: Record<string, unknown>) => {
      for (let i = 0; i < 2; i++) s().syncTable("conversations", [loaded(fields)], { isDelta: true });
    };

    it("setTeamVisibility from the member default is undone by clearing the level", () => {
      const prior = { is_private: false, team_id: TEAM };
      metaOnly(prior);
      expect(undoOf(() => s().setTeamVisibility(CONV, "full"))).toEqual([["setTeamVisibility", [CONV, null]]]);
      expect(getUndoHistory().items[0]?.status).toBe("undone");
      expect(s().conversations[CONV].team_visibility ?? null).toBe(null);
      echo(prior);
      expect(s().conversations[CONV].team_visibility ?? null).toBe(null);
      expect(s().conversations[CONV].is_private).toBe(false);
      expect(convLocks()).toEqual([]);
    });

    it("setPrivacy undo takes the stamped level off the row at once", () => {
      const prior = { is_private: false, team_id: TEAM };
      metaOnly(prior);
      expect(undoOf(() => s().setPrivacy(CONV, true))).toEqual([["setTeamVisibility", [CONV, null]]]);
      expect(s().conversations[CONV].is_private).toBe(false);
      expect(s().conversations[CONV].team_visibility ?? null).toBe(null);
      echo(prior);
      expect(s().conversations[CONV].team_visibility ?? null).toBe(null);
      expect(convLocks()).toEqual([]);
    });

    it("switchProject undo of a row with no git_root writes the server's spelling at once", () => {
      metaOnly({ project_path: "/tmp/scratch" });
      expect(undoOf(() => s().switchProject(CONV, "/src/b"))).toEqual([["switchProject", [CONV, "/tmp/scratch"]]]);
      expect(s().conversations[CONV]).toMatchObject({ project_path: "/tmp/scratch", git_root: "/tmp/scratch" });
      echo({ project_path: "/tmp/scratch", git_root: "/tmp/scratch" });
      expect(s().conversations[CONV]).toMatchObject({ project_path: "/tmp/scratch", git_root: "/tmp/scratch" });
      expect(convLocks()).toEqual([]);
    });
  });
});

describe("initiatives owned by a role", () => {
  const INIT = "in_1";
  const ROLE = "role_1";
  const role = (projectIds: string[]) => ({ _id: ROLE, name: "Growth lead", status: "active", scope: { project_ids: projectIds, plan_ids: [] }, scope_names: { projects: [], plans: [] } });
  const seed = (initiative: Record<string, unknown>, tree: { roles: unknown[] } | null) =>
    useInboxStore.setState({
      initiatives: { [INIT]: { _id: INIT, short_id: "in-1", title: "Launch", status: "active", project_ids: [], updated_at: 1, ...initiative } },
      orgTree: tree,
      orgIntents: [],
    } as any);
  const scope = () => s().orgTree.roles[0].scope.project_ids;
  const owner = { kind: "role", role_id: ROLE };

  // The server widens the role's scope in the write's own transaction and no
  // initiative verb takes it back, so these are not undoable from here; the
  // local tree is never rewound.
  it("naming a role owner that gains the initiative's projects records nothing", () => {
    seed({ project_ids: ["proj_1"] }, { roles: [role(["proj_0"])] });
    s().updateInitiative(INIT, { owner });
    expect(scope()).toEqual(["proj_0", "proj_1"]);
    expect(getUndoHistory().items).toEqual([]);
    expect(performUndo()).toBe(false);
    expect(scope()).toEqual(["proj_0", "proj_1"]);
    expect(s().orgIntents).toHaveLength(1);
  });

  it("adding or setting projects that widen the owner role's scope records nothing", () => {
    for (const gesture of [() => s().addInitiativeProject(INIT, "proj_1"), () => s().setInitiativeProjects(INIT, ["proj_1"])]) {
      seed({ owner }, { roles: [role(["proj_0"])] });
      gesture();
      expect(scope()).toEqual(["proj_0", "proj_1"]);
      expect(getUndoHistory().items).toEqual([]);
    }
  });

  it("with no org tree loaded, a write that could widen a role's scope records nothing", () => {
    seed({ project_ids: ["proj_1"] }, null);
    s().updateInitiative(INIT, { owner });
    seed({ owner }, null);
    s().addInitiativeProject(INIT, "proj_1");
    expect(getUndoHistory().items).toEqual([]);
  });

  it("edits that leave the role's scope alone stay ordinary undos", () => {
    // The role already lists the project; a rename and a removal never widen.
    seed({ owner, project_ids: ["proj_0"] }, { roles: [role(["proj_0", "proj_1"])] });
    expect(undoOf(() => s().addInitiativeProject(INIT, "proj_1"))).toEqual([["setInitiativeProjects", [INIT, ["proj_0"]]]]);
    expect(undoOf(() => s().removeInitiativeProject(INIT, "proj_0"))).toEqual([["setInitiativeProjects", [INIT, ["proj_0"]]]]);
    expect(undoOf(() => s().updateInitiative(INIT, { title: "Relaunch" }))).toEqual([["updateInitiative", [INIT, { title: "Launch" }]]]);
    expect(scope()).toEqual(["proj_0", "proj_1"]);
    expect(s().orgIntents).toEqual([]);
    // A person as owner has no scope to widen.
    seed({ project_ids: ["proj_1"] }, null);
    expect(undoOf(() => s().updateInitiative(INIT, { owner: { kind: "user", user_id: SAM } }))).toEqual([["updateInitiative", [INIT, { owner: null }]]]);
  });
});

describe("bookmarks, saved views, comments", () => {
  it("toggleBookmark is undone by the same toggle", () => {
    useInboxStore.setState({ bookmarks: [] } as any);
    expect(undoOf(() => s().toggleBookmark(CONV, "msg_1"))).toEqual([["toggleBookmark", [CONV, "msg_1"]]]);
    expect(s().bookmarks).toEqual([]);
  });

  it("updateSavedView sends the prior fields", () => {
    const V = "v".repeat(32);
    useInboxStore.setState({ savedViews: { [V]: { _id: V, name: "Mine", icon: "star", updated_at: 1 } } } as any);
    expect(undoOf(() => s().updateSavedView(V, { name: "Ours", icon: "bolt" }))).toEqual([["updateSavedView", [V, { name: "Mine", icon: "star" }]]]);
    expect(s().savedViews[V]).toMatchObject({ name: "Mine", icon: "star" });
  });

  // savedViews.webUpdate cannot unset a field, so the undo of an edit that
  // gave the view a field it lacked would restore it here and send nothing.
  it("updateSavedView records nothing when a changed field had no prior value", () => {
    const V = "v".repeat(32);
    useInboxStore.setState({ savedViews: { [V]: { _id: V, name: "Mine", updated_at: 1 } } } as any);
    s().updateSavedView(V, { icon: "bolt" });
    s().updateSavedView(V, { name: "Ours", team_id: TEAM });
    expect(getUndoHistory().items).toEqual([]);
    expect(calls.map(([a]) => a)).toEqual(["updateSavedView", "updateSavedView"]);
    s().updateSavedView(V, { name: "Theirs" });
    expect(label()).toBe("Edited view “Ours”");
  });

  it("resolving a thread is undone by reopening it; reopening records nothing", () => {
    const C1 = "1".repeat(32);
    const C2 = "2".repeat(32);
    useInboxStore.setState({
      comments: {
        [C1]: { _id: C1, conversation_id: CONV, message_id: "m1", content: "a", user_id: ME, created_at: 1 },
        [C2]: { _id: C2, conversation_id: CONV, message_id: "m1", content: "b", user_id: ME, created_at: 2 },
      },
    } as any);
    expect(undoOf(() => s().resolveCommentThread(CONV, { messageId: "m1" }, true))).toEqual([
      ["resolveCommentThread", [CONV, { messageId: "m1" }, false]],
    ]);
    expect(s().comments[C1].resolved_at).toBeUndefined();
    _resetUndoStacks();
    useInboxStore.setState({ comments: { [C1]: { ...s().comments[C1], resolved_at: 5, resolved_by: ME } } } as any);
    s().resolveCommentThread(CONV, { messageId: "m1" }, false);
    expect(getUndoHistory().items).toHaveLength(0);
  });

  it("resolving a thread that holds an older resolved comment records nothing", () => {
    // The server's reopen would clear the older stamp too, so an undo could
    // never put it back and its lock would never retire.
    const C1 = "1".repeat(32);
    const C2 = "2".repeat(32);
    useInboxStore.setState({
      comments: {
        [C1]: { _id: C1, conversation_id: CONV, message_id: "m1", content: "a", user_id: ME, created_at: 1, resolved_at: 5, resolved_by: ME },
        [C2]: { _id: C2, conversation_id: CONV, message_id: "m1", content: "b", user_id: ME, created_at: 2 },
      },
    } as any);
    s().resolveCommentThread(CONV, { messageId: "m1" }, true);
    expect(getUndoHistory().items).toHaveLength(0);
  });

  it("editComment sends the prior content", () => {
    const C1 = "1".repeat(32);
    useInboxStore.setState({ comments: { [C1]: { _id: C1, conversation_id: CONV, content: "first", user_id: ME, created_at: 1 } } } as any);
    const sent = undoOf(() => void s().editComment(C1, "second"));
    expect(sent.map(([a, args]) => [a, args.slice(0, 2)])).toEqual([["editComment", [C1, "first"]]]);
    expect(s().comments[C1].content).toBe("first");
  });
});

describe("decision stacks", () => {
  const STACK = "q".repeat(32);
  beforeEach(() => {
    useInboxStore.setState({
      decisionStacks: { [STACK]: { _id: STACK, title: "Launch", decision_ids: ["d1", "d2", "d3"], policy: { due_at: 50 }, total: 3, pending: 3 } },
    } as any);
  });

  it("reorderStack goes back to the prior order", () => {
    expect(undoOf(() => s().reorderStack(STACK, ["d3", "d1", "d2"]))).toEqual([["reorderStack", [STACK, ["d1", "d2", "d3"]]]]);
    expect(s().decisionStacks[STACK].decision_ids).toEqual(["d1", "d2", "d3"]);
  });

  it("setStackPolicy sends back each moved key, clearing the ones that were unset", () => {
    const sent = undoOf(() => void s().setStackPolicy(STACK, { auto_default_after_ms: 60_000, clear_due: true }));
    expect(sent).toEqual([["setStackPolicy", [STACK, { clear_auto_default: true, due_at: 50 }]]]);
    expect(s().decisionStacks[STACK].policy).toEqual({ due_at: 50 });
  });
});

describe("triggers", () => {
  const TR = "r".repeat(32);
  const seed = (status: string) =>
    useInboxStore.setState({
      agentTasks: { [TR]: { _id: TR, title: "Nightly digest", status, schedule_type: "recurring", interval_ms: 3_600_000, run_at: 10 } },
      foreignTriggers: {},
    } as any);

  it("pause and resume go back through the opposite verb", () => {
    seed("scheduled");
    expect(undoOf(() => s().triggerAction(TR, "pause"))).toEqual([["triggerAction", [TR, "resume"]]]);
    expect(s().agentTasks[TR].status).toBe("scheduled");
    _resetUndoStacks();
    seed("paused");
    expect(undoOf(() => s().triggerAction(TR, "resume"))).toEqual([["triggerAction", [TR, "pause"]]]);
  });

  it("run now, cancel and reactivate record nothing", () => {
    seed("scheduled");
    s().triggerAction(TR, "runNow");
    seed("scheduled");
    s().triggerAction(TR, "cancel");
    seed("paused");
    s().triggerAction(TR, "cancel");
    seed("completed");
    s().triggerAction(TR, "reactivate");
    expect(getUndoHistory().items).toHaveLength(0);
  });

  it("setTriggerInterval goes back to the prior interval", () => {
    seed("scheduled");
    expect(undoOf(() => s().setTriggerInterval(TR, 7_200_000))).toEqual([["setTriggerInterval", [TR, 3_600_000]]]);
    expect(label()).toBe("Set “Nightly digest” to every 2h");
    expect(s().agentTasks[TR].interval_ms).toBe(3_600_000);
  });
});

describe("chat", () => {
  const CH = "h".repeat(32);
  const MSG = "m".repeat(32);
  beforeEach(() => {
    useInboxStore.setState({
      chatChannels: { [CH]: { _id: CH, name: "general", topic: "hi", updated_at: 1 } },
      chatRail: [{ channel_id: CH, member_ids: [ME, SAM] }],
      chatMessages: { [MSG]: { _id: MSG, channel_id: CH, content: "helo" } },
    } as any);
  });

  it("updateChatChannel sends the prior name", () => {
    expect(undoOf(() => s().updateChatChannel(CH, { name: "random" }))).toEqual([["updateChatChannel", [CH, { name: "general" }]]]);
    expect(s().chatChannels[CH].name).toBe("general");
  });

  it("archiveChatChannel is undone by unarchiving", () => {
    expect(undoOf(() => s().archiveChatChannel(CH, true))).toEqual([["archiveChatChannel", [CH, false]]]);
    expect(label()).toBe("Archived #general");
    expect(s().chatChannels[CH].archived_at ?? null).toBeNull();
  });

  it("adding members is undone by removing each one added", () => {
    expect(undoOf(() => s().addChatChannelMembers(CH, [SAM, KIM]))).toEqual([["removeChatChannelMember", [CH, KIM]]]);
  });

  it("removing someone is undone by adding them back; leaving yourself records nothing", () => {
    expect(undoOf(() => s().removeChatChannelMember(CH, SAM))).toEqual([["addChatChannelMembers", [CH, [SAM]]]]);
    _resetUndoStacks();
    s().removeChatChannelMember(CH, ME);
    expect(getUndoHistory().items).toHaveLength(0);
  });

  it("dispatchChatEdit sends the prior content", () => {
    expect(undoOf(() => s().dispatchChatEdit(MSG, "hello"))).toEqual([["dispatchChatEdit", [MSG, "helo"]]]);
    expect(s().chatMessages[MSG].content).toBe("helo");
  });
});

describe("org verbs", () => {
  it("record a display-only history item that undo steps past", () => {
    s().withdrawOrgProposal("prop_1");
    const [item] = getUndoHistory().items;
    expect(item).toMatchObject({ status: "external", external: "org", label: "Withdrew an org proposal" });
    calls = [];
    expect(performUndo()).toBe(false);
    expect(calls).toEqual([]);
  });
});
