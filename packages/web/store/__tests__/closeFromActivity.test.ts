import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, mountedPathname } from "../inboxStore";
import { isInboxSessionView } from "../../lib/inboxRouting";
import { ACTIVITY_TAB_PATH } from "../../components/activity/activityView";

// ct-102149: a conversation opened from Activity was still treated as an inbox
// view, because currentConversation.source kept the "inbox" the queue page had
// written before the person left it. The triage bar's Close then ran the inbox
// advance (sessionPastRemoved) and dropped the person into the next queue
// session instead of back where they came from.
//
// The test drives the store the way the app does: the inbox publishes its
// conversation, then each in-app navigation records the new path on the active
// tab (DashboardLayout/TabContent → updateTab). The predicate the triage bar
// and the chords use must then say the conversation page is NOT an inbox view.

function onInboxSessionView(): boolean {
  const s = useInboxStore.getState();
  return isInboxSessionView(mountedPathname(s), s.currentConversation?.source);
}

describe("Close on a session opened from Activity (ct-102149)", () => {
  beforeEach(() => {
    useInboxStore.setState({
      ...useInboxStore.getInitialState(),
      tabs: [{ id: "tab1", title: "Inbox", path: "/inbox?s=convA" }],
      activeTabId: "tab1",
    } as any);
  });

  it("a conversation page reached from Activity after the inbox is not an inbox view", () => {
    const store = useInboxStore.getState();
    // The queue page publishes the session it shows (QueuePageClient).
    store.setCurrentConversation({ conversationId: "convA", source: "inbox" });
    expect(onInboxSessionView()).toBe(true);

    // The person leaves for Activity, then opens a session from it.
    store.updateTab("tab1", { path: ACTIVITY_TAB_PATH.activity, title: "Activity" });
    store.updateTab("tab1", { path: "/conversation/convB", title: "Conversation" });

    expect(mountedPathname(useInboxStore.getState())).toBe("/conversation/convB");
    // Inbox classification here is what makes Close advance to the next queue session.
    expect(onInboxSessionView()).toBe(false);
  });
});
