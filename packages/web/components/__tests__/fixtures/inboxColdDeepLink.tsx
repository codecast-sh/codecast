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
mock.module("../../../hooks/useMissingSessionRow", () => ({ useMissingSessionRow: (id: string | null) => id ? fetched : undefined }));
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
mock.module("../../ConversationPlaceholder", () => ({ ConversationPlaceholder: ({ id }: any) => <div data-placeholder={id} /> }));
mock.module("../../FleetBoard", () => ({ FleetBoard: () => <div data-home />, InboxHomeToggle: () => null }));
mock.module("../../ActivityFeed", () => ({ ActivityFeed: () => <div data-home /> }));
for (const name of ["SharePopover", "PlanContextPanel", "WorkflowContextPanel", "TriggerContextPanel", "EmptyState"]) {
  mock.module(`../../${name}`, () => ({ [name]: () => null }));
}
mock.module("../../SessionErrorBanner", () => ({ SessionErrorBanner: () => null, SessionResumeBanner: () => null }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { QueuePageClient } = await import("../../../app/inbox/QueuePageClient");
const root = createRoot(document.getElementById("root")!);
const q = (selector: string) => document.querySelector(selector);
const render = async () => { await act(async () => root.render(<QueuePageClient />)); };
useInboxStore.setState({ sessions: {}, conversations: {}, pending: {}, clientStateInitialized: true, currentSessionId: null, showMySessions: true, currentUser: { _id: "viewer", cli_version: "test" }, clientState: { ui: { inbox_home: "feed" } } } as any);
await render();
assert.ok(q(`[data-placeholder="${id}"]`), "a cold deep link shows its loading target instead of the inbox home");
assert.equal(q("[data-home]"), null);
assert.ok(messageSubscriptions.has(id), "messages start loading before the session record arrives");
fetched = { _id: id, session_id: id, title: "Cold target", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false };
await render();
assert.ok(q(`[data-conversation="${id}"]`), "the fetched target paints without another navigation");
await act(async () => useInboxStore.getState().setShowMySessions(true));
assert.ok(q("[data-home]"), "an explicit Back action stays on the inbox home");
await act(async () => root.unmount());
await Bun.write(process.argv[2] ?? Bun.stdout, "cold inbox deep link verified\n");
process.exit(0);
