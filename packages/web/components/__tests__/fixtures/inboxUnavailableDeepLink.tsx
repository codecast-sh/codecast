import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const id = "j".repeat(32);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `http://localhost/inbox?s=${id}` });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let fetched: unknown = undefined;
const messageSubscriptions = new Set<string>();
const target = id;
mock.module("../../../hooks/useMissingSessionRow", () => ({
  useMissingSessionRow: (id: string | null) => id ? fetched : undefined,
  useMissingSessionLookup: (id: string | null) => ({ row: id ? fetched : undefined, failed: false }),
}));
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({ ...navigation, useSearchParams: () => new URLSearchParams(target ? { s: target } : {}) }));
const shortcuts = await import("../../../shortcuts");
mock.module("../../../shortcuts", () => ({ ...shortcuts, useShortcutContext: () => {} }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useMutation: () => async () => {}, useQuery: () => undefined }));
mock.module("../../../hooks/useConversationMessages", () => ({ useConversationMessages: (id: string) => {
  messageSubscriptions.add(id);
  return { conversation: { _id: id, messages: [], is_own: false } };
} }));
mock.module("../../anchor/AnchorConversation", () => ({ useSeedOwnership: () => {} }));
mock.module("../../DashboardLayout", () => ({ DashboardLayout: ({ children }: any) => children }));
mock.module("../../ConversationDiffLayout", () => ({ ConversationDiffLayout: ({ conversation }: any) => <div data-conversation={conversation._id} /> }));
mock.module("../../ConversationUnavailable", () => ({ ConversationUnavailable: () => <div data-unavailable /> }));
mock.module("../../ConversationPlaceholder", () => ({ ConversationPlaceholder: ({ id }: any) => <div data-placeholder={id} /> }));
mock.module("../../FleetBoard", () => ({ FleetBoard: () => <div data-home />, InboxHomeToggle: () => null }));
mock.module("../../ActivityFeed", () => ({ ActivityFeed: () => <div data-home /> }));
for (const name of ["SharePopover", "PlanContextPanel", "WorkflowContextPanel", "TriggerContextPanel", "EmptyState"]) {
  mock.module(`../../${name}`, () => ({ [name]: () => null }));
}
mock.module("../../SessionErrorBanner", () => ({ SessionErrorBanner: () => null, SessionResumeBanner: () => null }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../../store/inboxStore");
const { declareViewNav } = await import("../../../store/viewNav");
const { QueuePageClient } = await import("../../../app/inbox/QueuePageClient");
const root = createRoot(document.getElementById("root")!);
const q = (selector: string) => document.querySelector(selector);
const render = async () => { await act(async () => root.render(<MemoryRouter><QueuePageClient /></MemoryRouter>)); };
// The viewer was on another session when they opened a link to one they
// cannot read. The old session must never paint in its place.
const other = "a".repeat(32);
const row = (_id: string, title: string) => ({ _id, session_id: _id, title, updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false });
declareViewNav("gesture");
useInboxStore.setState({ sessions: { [other]: row(other, "Previous") }, conversations: {}, pending: {}, clientStateInitialized: true, currentSessionId: other, showMySessions: false, currentUser: { _id: "viewer", cli_version: "test" }, clientState: { ui: { inbox_home: "feed" } } } as any);
await render();
assert.ok(q(`[data-placeholder="${id}"]`), "the link shows its loading target first");
fetched = null;
await render();
await render();
assert.ok(q("[data-unavailable]"), "a denied link says so");
assert.equal(q(`[data-conversation="${other}"]`), null, "the previous session does not paint over the note");
assert.notEqual(window.location.pathname, `/conversation/${other}`, "the address bar is not rewritten to another session");
fetched = row(id, "Shared later");
await render();
await render();
assert.ok(q(`[data-conversation="${id}"]`), "a link that becomes readable opens on its own");
assert.equal(q("[data-unavailable]"), null);
// Same rule over a stashed session's peek, and for an in-app link (the path
// desktop deep links take): the peek must not paint over the refused target.
const denied = "d".repeat(32);
fetched = null;
declareViewNav("gesture");
await act(async () => useInboxStore.setState({ viewingDismissedId: other, currentSessionId: null } as any));
await act(async () => useInboxStore.getState().requestNavigate(denied));
await render();
await render();
assert.ok(q("[data-unavailable]"), "an in-app link to a denied session says so");
assert.equal(q(`[data-conversation="${other}"]`), null, "the stashed peek does not paint over the note");
assert.equal(window.location.pathname, `/conversation/${denied}`, "the address bar names the refused link, so a reload asks for it again");
await act(async () => root.unmount());
await Bun.write(process.argv[2] ?? Bun.stdout, "unavailable inbox deep link verified\n");
process.exit(0);
