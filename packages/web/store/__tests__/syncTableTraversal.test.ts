import { afterEach, expect, it } from "bun:test";
import { isDraft } from "mutative";
import { useInboxStore } from "../inboxStore";

const initial = useInboxStore.getState();
afterEach(() => useInboxStore.setState(initial, true));

it("does not walk unchanged row contents and still accepts later draft edits", () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  let walks = 0;
  const untouched = new Proxy({ _id: b, title: "untouched", message_count: 2 }, {
    ownKeys(target) { walks++; return Reflect.ownKeys(target); },
  });
  useInboxStore.setState({
    sessions: { [a]: { _id: a, title: "before" }, [b]: untouched },
    conversations: { [a]: { _id: a }, [b]: { _id: b } },
    pending: {}, pendingMessages: {}, messages: {}, clientStateInitialized: false,
  } as any);
  useInboxStore.getState().syncTable("sessions", [{ _id: a, title: "after" }]);
  const synced = useInboxStore.getState().sessions;
  expect(walks).toBe(0);
  expect(synced[b]).toBe(untouched);
  expect(synced[a].title).toBe("after");
  useInboxStore.getState().syncOverlay("sessions", { [a]: { title: "later" } });
  expect(useInboxStore.getState().sessions[a].title).toBe("later");
  expect(synced[a].title).toBe("after");
  useInboxStore.getState().syncTable("sessions", [{ _id: a, title: "later" }]);
  expect(useInboxStore.getState().sessions[b]).toBe(untouched);
});

it("compares unchanged singleton and list payloads without traversing drafts", () => {
  let draftReads = 0;
  const row = {
    _id: "row",
    get title() {
      if (isDraft(this)) draftReads++;
      return "same";
    },
  };
  const conversations = { row };
  const teams = [row];
  useInboxStore.setState({ conversations, teams } as any);
  useInboxStore.getState().syncTable("conversations", { row: { _id: "row", title: "same" } }, { kind: "singleton" });
  useInboxStore.getState().syncTable("teams", [{ _id: "row", title: "same" }]);
  expect(draftReads).toBe(0);
  expect(useInboxStore.getState().conversations).toBe(conversations);
  expect(useInboxStore.getState().teams).toBe(teams);
  useInboxStore.getState().syncTable("conversations", { row: { _id: "row", title: "changed" } }, { kind: "singleton" });
  expect(useInboxStore.getState().conversations.row.title).toBe("changed");
});
