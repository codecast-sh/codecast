import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// What the server hands back for a row the store lacks: undefined while
// loading, null when unavailable, a row when found.
let fetched: unknown = undefined;
mock.module("../../../hooks/useMissingSessionRow", () => ({
  useMissingSessionRow: (id: string | null) => (id ? fetched : undefined),
}));
mock.module("../../GlobalSessionPanel", () => ({
  InboxConversation: ({ sessionId }: { sessionId: string }) => <div data-conversation={sessionId} />,
}));
mock.module("../../ConversationPlaceholder", () => ({
  ConversationPlaceholder: ({ id }: { id: string }) => <div data-placeholder={id} />,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionPane } = await import("../../stage/SessionPane");
const { useInboxStore } = await import("../../../store/inboxStore");

const root = createRoot(document.getElementById("root")!);
const text = () => document.getElementById("root")!.textContent ?? "";
const q = (sel: string) => document.querySelector(sel);
const row = (id: string) => ({ _id: id, session_id: id, title: "Teammate session", updated_at: 1, agent_type: "claude_code", message_count: 3, is_idle: true, has_pending: false });
let n = 0;
const mount = async (id: string) => {
  await act(async () => { root.render(<SessionPane key={n++} sessionId={id} onClose={() => {}} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

useInboxStore.setState({ sessions: {}, pending: {} } as any);

// Loading: the conversation's placeholder, never the "gone" note.
fetched = undefined;
await mount("teammate1");
assert.ok(q('[data-placeholder="teammate1"]'), "loading shows the placeholder");
assert.ok(!text().includes("no longer available"));

// Found: the row lands in the store and the conversation renders from it.
fetched = row("teammate1");
await mount("teammate1");
assert.equal((useInboxStore.getState().sessions as any).teammate1?.title, "Teammate session", "the fetched row is seeded");
assert.ok(q('[data-conversation="teammate1"]'), "the conversation renders once seeded");
assert.equal(useInboxStore.getState().currentSessionId ?? null, null, "seeding never moves the view");

// Unavailable: the honest note.
fetched = null;
await mount("gone1");
assert.ok(text().includes("no longer available"), "a row the server withholds reads as unavailable");

// Killed locally: stays out even though the server still has it.
useInboxStore.setState({ pending: { "sessions:killed1": { type: "exclude" } } } as any);
fetched = row("killed1");
await mount("killed1");
assert.ok(!(useInboxStore.getState().sessions as any).killed1, "a locally killed session is not seeded back");
assert.ok(text().includes("no longer available"));

await act(async () => root.unmount());
console.log("session pane missing row verified");
process.exit(0);
