// The inbox's first run, as the three surfaces that read it see it: the card
// shows only once an empty cache is known to be the truth, an unsent
// composer stub is not a conversation, and a first message to the hosted
// assistant from there moves the person to hosted mode.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { inboxCrawlWsKey } from "../../hooks/useSyncInboxSessions";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { useInboxStore } from "../../store/inboxStore";
import { firstRun } from "../firstRun";
import { startHostedConversation } from "../startHostedConversation";

const REAL_ID = "k".repeat(32);
const floor = { [syncMetaKey("sessions", inboxCrawlWsKey("u_me"))]: { backfilledAt: 1 } };
const base = { currentUser: { _id: "u_me" }, sessions: {}, pendingSessionCreates: {}, syncMeta: floor };

describe("firstRun", () => {
  test("unknown until the user doc has synced", () => {
    expect(firstRun({ ...base, currentUser: undefined })).toBe("unknown");
  });

  test("a machine that has ever checked in ends it", () => {
    expect(firstRun({ ...base, currentUser: { _id: "u_me", cli_version: "1.2.0" } })).toBe("no");
  });

  test("an empty cold cache is unknown until the sessions floor is cut", () => {
    expect(firstRun({ ...base, syncMeta: {} })).toBe("unknown");
    expect(firstRun(base)).toBe("yes");
  });

  test("another account's floor does not stand in", () => {
    expect(firstRun({ ...base, currentUser: { _id: "u_other" } })).toBe("unknown");
  });

  test("a conversation ends it, floor or no floor", () => {
    expect(firstRun({ ...base, syncMeta: {}, sessions: { [REAL_ID]: {} } })).toBe("no");
  });

  test("a composer's unsent stub is not a conversation; one being created is", () => {
    const sessions = { "stub-1": {} };
    expect(firstRun({ ...base, sessions })).toBe("yes");
    expect(firstRun({ ...base, sessions, pendingSessionCreates: { "stub-1": Promise.resolve(REAL_ID) } })).toBe("no");
  });
});

// The join lives in the store's createSessionFromStub, the one create every
// way in reaches, so these go through real entry points, not a helper.
describe("a first hosted conversation joins hosted mode", () => {
  const owner = {};
  beforeAll(() => useInboxStore.getState()._setDispatch(async (action) => (action === "createSession" ? REAL_ID : null), { owner }));
  afterAll(() => useInboxStore.getState()._clearDispatch(owner));

  const lane = () => (useInboxStore.getState().clientState as any).ui?.lane;
  const seed = (over: Record<string, unknown> = {}) => {
    const cs = useInboxStore.getState().clientState as any;
    useInboxStore.setState({ ...base, clientState: { ...cs, ui: { ...cs.ui, lane: undefined } }, ...over } as any);
  };

  test("from a surface that holds only the text (the palette, the context composer)", () => {
    seed();
    startHostedConversation("What's on tomorrow?");
    expect(lane()).toBe("simple");
  });

  test("from a stub created directly (Ctrl+N, the composer, the self-heal)", () => {
    seed({ sessions: { "stub-hosted": { _id: "stub-hosted", agent_type: HOSTED_AGENT_TYPE } } });
    void useInboxStore.getState().createSessionFromStub("stub-hosted");
    expect(lane()).toBe("simple");
  });

  test("someone past the first run stays where they are", () => {
    seed({ sessions: { [REAL_ID]: {} } });
    startHostedConversation("And the day after?");
    expect(lane()).toBeUndefined();
  });

  test("someone with a machine stays where they are", () => {
    seed({ currentUser: { _id: "u_me", cli_version: "1.2.0" } });
    startHostedConversation("Anything urgent?");
    expect(lane()).toBeUndefined();
  });
});
