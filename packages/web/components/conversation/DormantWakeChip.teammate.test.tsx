// ct-101316: on a teammate's conversation the header's dormant-wake chip must
// not tell the viewer the session will be "yours" and return to Needs Input
// (it returns to its owner), and the chip must be something the viewer can press.
// Run: bun test components/conversation/DormantWakeChip.teammate.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const realTriggers = { ...(await import("../../hooks/useSyncTriggers")) };
mock.module("../../hooks/useSyncTriggers", () => ({ ...realTriggers, useTriggers: () => ({ tasks: [], ready: true }) }));

const ME = "k57me00000000000000000000000000a";
const OWNER = "k57owner000000000000000000000000";
const SID = "jd7teammate00000000000000000000a";
const now = Date.now();
let dom: any;

const teammateSession = {
  _id: SID, user_id: OWNER, owner_user_id: OWNER, title: "Teammate's session",
  agent_type: "claude_code", status: "active", agent_status: "idle",
  started_at: now - 3_600_000, updated_at: now - 60_000, last_message_at: now - 60_000,
  last_message_role: "assistant", message_count: 4, is_idle: true,
  thread_state: "waiting on a reply",
};

afterAll(() => closeDomWindow(dom));

test("on a teammate's needs-input session the chip names the owner, not 'yours', and can be pressed", async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useInboxStore, placeInboxRows } = await import("../../store/inboxStore");
  const { declareViewNav } = await import("../../store/viewNav");
  const { DormantWakeChip } = await import("./DormantWakeChip");

  useInboxStore.setState({ currentUser: { _id: ME }, sessions: { [SID]: teammateSession } } as never);
  declareViewNav("gesture");
  useInboxStore.setState({ currentSessionId: SID } as never);
  // The setup the report describes: a needs-input session the viewer can't command.
  expect(placeInboxRows(useInboxStore.getState() as never, { focusedId: SID, now }).placements.get(SID)?.bucket).toBe("needs_input");

  const root = createRoot(document.getElementById("root")!);
  React.act(() => { root.render(React.createElement(DormantWakeChip, { conversationId: SID })); });
  const chip = document.querySelector("[data-dormant-wake]") as HTMLElement | null;
  expect(chip).not.toBeNull();
  const said = `${chip!.textContent} | ${chip!.getAttribute("title")}`;
  expect(said).not.toMatch(/\byours\b/);
  expect(said).not.toContain("returns to Needs Input");
  expect(chip!.tagName).toBe("BUTTON");
  React.act(() => root.unmount());
});
