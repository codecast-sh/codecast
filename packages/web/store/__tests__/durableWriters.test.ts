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
    store.saveView({ name: "Mine", filters: { scope: "mine" } } as any);
    const savedViewId = useInboxStore.getState().clientState.ui?.saved_views?.[0]?.id;
    store.deleteView(savedViewId);
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
      "saveView",
      "deleteView",
      "updateClientLayout",
      "persistClientTips",
      "clearDraftFinal",
    ]);

    const ui = calls[0].patches?.client_state?._?.ui;
    expect(ui.inbox_scope).toBe("team");
    expect(ui["inbox_scope:ts"]).toBeTypeOf("number");
    expect(calls[0].result).toEqual(ui);

    expect(calls[1].patches?.client_state?._?.ui?.saved_views).toHaveLength(1);
    expect(calls[1].result).toEqual(calls[1].patches?.client_state?._?.ui?.saved_views);
    expect(calls[2].patches?.client_state?._?.ui?.saved_views).toEqual([]);
    expect(calls[2].result).toEqual([]);
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
