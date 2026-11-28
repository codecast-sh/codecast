import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

// A new session opened from outside the inbox lands on `/inbox?s=<stub>`.
// The first send swaps the stub for its server id; the address still names
// the stub, which only this store knew. The inbox must follow the swap onto
// the real id, never hand the stub to the conversation route, whose resolver
// has never heard of it and says "This conversation isn't available".
const stub = "k3j9x2stubabc0q7m1";
const real = "r".repeat(32);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `http://localhost/inbox?s=${stub}` });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const replaced: string[] = [];
const router = { replace: (href: string) => { replaced.push(href); }, push: (href: string) => { replaced.push(href); }, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
mock.module("../../../hooks/useMissingSessionRow", () => ({
  useMissingSessionRow: () => undefined,
  useMissingSessionLookup: () => ({ row: undefined, failed: false }),
}));
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({ ...navigation, useRouter: () => router, useSearchParams: () => new URLSearchParams({ s: stub }) }));
const shortcuts = await import("../../../shortcuts");
mock.module("../../../shortcuts", () => ({ ...shortcuts, useShortcutContext: () => {} }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useMutation: () => async () => {}, useQuery: () => undefined, useQueries: () => ({}) }));
mock.module("../../../hooks/useConversationMessages", () => ({ useConversationMessages: (id: string) => ({ conversation: { _id: id, messages: [], is_own: true } }) }));
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
const render = async () => { await act(async () => root.render(<MemoryRouter><QueuePageClient /></MemoryRouter>)); };
const row = (_id: string) => ({ _id, session_id: stub, title: "New session", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: false, has_pending: false });
declareViewNav("gesture");
useInboxStore.setState({ sessions: { [stub]: row(stub) }, conversations: {}, pending: {}, clientStateInitialized: true, currentSessionId: stub, showMySessions: false, currentUser: { _id: "viewer", cli_version: "test" }, clientState: { ui: { inbox_home: "feed" } } } as any);
await render();
assert.equal(useInboxStore.getState().currentSessionId, stub, "the stub opens in place");
// The first send: the server answers with the real id and the stub rekeys.
await act(async () => useInboxStore.getState().resolveSessionId(stub, real));
await render();
await render();
assert.ok(!replaced.includes(`/conversation/${stub}`), `the rekeyed stub is not handed to the resolver (router went to ${JSON.stringify(replaced)})`);
assert.deepEqual(replaced, [`/conversation/${real}`], "the address follows the stub to its real id");
assert.equal(useInboxStore.getState().currentSessionId, real, "the inbox stays on the session, under its real id");
assert.equal(document.querySelector("[data-unavailable]"), null, "no unavailable note");
await act(async () => root.unmount());
await Bun.write(process.argv[2] ?? Bun.stdout, "rekeyed stub param verified\n");
process.exit(0);
