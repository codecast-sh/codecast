import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "./inboxStore";

const STUB_ID = "contextstubpersisted";
const REAL_ID = "jx7000000000000000000000000link";
const LINKED_DOC = { type: "doc", id: "docs_context" };

describe("ContextChat linked create intent", () => {
  beforeEach(() => {
    const store = useInboxStore.getState() as any;
    store._clearRuntimeBindings();
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      pending: {},
      currentConversation: {},
    } as any);
    store._setDispatch(() => Promise.resolve(REAL_ID));
  });

  afterEach(() => {
    (useInboxStore.getState() as any)._clearRuntimeBindings();
  });

  test("persists linked_object on a refreshed stub and forwards it during heal", async () => {
    const store = useInboxStore.getState();

    await store.createSession({
      agent_type: "claude_code",
      project_path: "/repo",
      session_id: STUB_ID,
      linked_object: LINKED_DOC,
    });
    expect(useInboxStore.getState().sessions[STUB_ID]?._linkedObject).toEqual(LINKED_DOC);

    // A subsequent optimistic refresh must not erase the local-only intent.
    await useInboxStore.getState().createSession({
      agent_type: "claude_code",
      project_path: "/repo",
      session_id: STUB_ID,
    });
    expect(useInboxStore.getState().sessions[STUB_ID]?._linkedObject).toEqual(LINKED_DOC);

    const originalCreate = useInboxStore.getState().createSession;
    let healedOpts: Record<string, any> | undefined;
    useInboxStore.setState({
      createSession: ((opts: Record<string, any>) => {
        healedOpts = opts;
        return Promise.resolve(REAL_ID);
      }) as any,
    });
    try {
      await useInboxStore.getState().createSessionFromStub(STUB_ID);
    } finally {
      useInboxStore.setState({ createSession: originalCreate });
    }

    expect(healedOpts?.linked_object).toEqual(LINKED_DOC);
  });
});
