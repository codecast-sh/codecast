import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

type DispatchCall = {
  action: string;
  args: unknown[];
  patches?: Record<string, any>;
  result?: unknown;
};

describe("named durable store writers", () => {
  const owner = {};
  let calls: DispatchCall[];

  beforeEach(() => {
    calls = [];
    useInboxStore.setState({
      clientState: {},
      drafts: {},
      pending: {},
    });
    useInboxStore.getState()._setDispatch(async (action, args, patches, result) => {
      calls.push({ action, args, patches, result });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  test("UI, saved-view, layout, tips, and draft writes use their named action paths", () => {
    const store = useInboxStore.getState();

    store.updateClientUI({ inbox_scope: "team" });
    // Saved views moved out of the client_state bag into their own server
    // collection so they can be shared; they still dispatch by name.
    store.createSavedView({ name: "Mine", page: "tasks", prefs: { status: "open" } } as any);
    const savedViewId = Object.keys(useInboxStore.getState().savedViews)[0];
    store.deleteSavedView(savedViewId);
    store.updateClientLayout("sidebar" as any, { width: 288 });
    store.updateClientTips({ seen: ["first"], _inlineSuppressed: true });

    useInboxStore.setState({
      drafts: { conversation: { draft_message: "hello" } },
      clientState: {
        ...useInboxStore.getState().clientState,
        drafts: { conversation: { draft_message: "hello" } },
      },
    });
    useInboxStore.getState().clearDraftFinal("conversation");

    expect(calls.map((call) => call.action)).toEqual([
      "updateClientUI",
      "createSavedView",
      "deleteSavedView",
      "updateClientLayout",
      "persistClientTips",
      "clearDraftFinal",
    ]);

    const ui = calls[0].patches?.client_state?._?.ui;
    expect(ui.inbox_scope).toBe("team");
    expect(ui["inbox_scope:ts"]).toBeTypeOf("number");
    expect(calls[0].result).toEqual(ui);

    // The create carries a minted client_key so the server row supersedes the
    // optimistic stub instead of landing beside it.
    expect(calls[1].args?.[0]?.name).toBe("Mine");
    expect(calls[1].result?.client_key).toBeTypeOf("string");
    expect(calls[2].args).toEqual([savedViewId]);
    expect(calls[3].patches?.client_state?._?.layouts?.sidebar).toEqual({ width: 288 });
    expect(calls[4].args).toEqual([{ seen: ["first"] }]);
    expect(calls[4].patches).toBeUndefined();
    expect(useInboxStore.getState().clientState.tips?._inlineSuppressed).toBe(true);
    expect(calls[5].patches?.client_state?._?.drafts?.conversation).toBeNull();
  });

  test("explicit undo patches ride a named durable action without mutating local state", () => {
    const patches = {
      conversations: {
        conversation: {
          inbox_dismissed_at: null,
          inbox_stashed_at: 123,
        },
      },
    };
    const before = useInboxStore.getState();

    useInboxStore.getState().applyUndoPatches(patches);

    expect(calls).toContainEqual({
      action: "applyUndoPatches",
      args: [patches],
      patches: undefined,
      result: null,
    });
    expect(useInboxStore.getState()).toBe(before);
  });

  test("named writers retain their explicit payload when the local value is already equal", () => {
    const originalStamp = 123;
    useInboxStore.setState({
      clientState: {
        ui: {
          inbox_scope: "team",
          "inbox_scope:ts": originalStamp,
        } as any,
        layouts: { sidebar: { width: 288 } } as any,
        drafts: { conversation: null },
      },
      drafts: {},
    });

    const store = useInboxStore.getState();
    store.updateClientUI({
      inbox_scope: "team",
      "inbox_scope:ts": originalStamp,
    } as any);
    store.updateClientLayout("sidebar" as any, useInboxStore.getState().clientState.layouts?.sidebar);
    store.clearDraftFinal("conversation");

    expect(calls[0]).toMatchObject({
      action: "updateClientUI",
      args: [{ inbox_scope: "team", "inbox_scope:ts": originalStamp }],
      result: { inbox_scope: "team", "inbox_scope:ts": originalStamp },
    });
    expect(calls[1]).toMatchObject({
      action: "updateClientLayout",
      args: ["sidebar", { width: 288 }],
    });
    expect(calls[2]).toMatchObject({
      action: "clearDraftFinal",
      args: ["conversation"],
    });
  });
});
