// A call that reached many sessions keeps a one-line header: the newest few
// as chips, every one (and every excerpt each was sent) in the menu behind
// "+N". mock.module is process global, so the mocked module is spread from
// the real one and put back in afterAll.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push() {}, replace() {} }) }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { CallSessionChips } = await import("../CallSessionChips");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
  mock.module("next/navigation", () => realNav);
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return container;
}

const session = (i: number, over: Partial<any> = {}) => ({
  conversation_id: `conv${i}`,
  short_id: `conv${i}`,
  title: `Session ${i}`,
  agent_type: "claude_code",
  name: `Agent ${i}`,
  character_avatar: null,
  character_name: null,
  live: true,
  excerpts: [],
  ...over,
});

test("a call with many sessions shows three chips and a +N menu", async () => {
  useInboxStore.setState({ sessions: {} } as any);
  const c = await render(<CallSessionChips callId="t1" sessions={[1, 2, 3, 4, 5, 6].map((i) => session(i))} />);
  const chips = [...c.querySelectorAll("button")].map((b) => b.textContent);
  expect(chips.slice(0, 3)).toEqual(["Agent 1", "Agent 2", "Agent 3"]);
  expect(chips[3]).toBe("+3");
  expect(chips).toHaveLength(4);
});

test("a few sessions with no excerpts need no menu", async () => {
  useInboxStore.setState({ sessions: {} } as any);
  const c = await render(<CallSessionChips callId="t1" sessions={[session(1), session(2)]} />);
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Agent 1", "Agent 2"]);
});

test("an excerpt makes the menu reachable even when every session fits", async () => {
  useInboxStore.setState({ sessions: {} } as any);
  const c = await render(
    <CallSessionChips
      callId="t1"
      sessions={[session(1, { live: false, excerpts: [{ from_seq: 2, to_seq: 6, at: 1 }] })]}
    />,
  );
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Agent 1", "excerpts"]);
});

test("a session the thread's head already shows is not a chip again, and the rest read as where the call was sent", async () => {
  useInboxStore.setState({ sessions: {} } as any);
  const c = await render(<CallSessionChips callId="t1" sessions={[session(1), session(2)]} inThread={new Set([session(1).conversation_id])} />);
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Agent 2"]);
  expect(c.textContent).toContain("sent to");
  const none = await render(<CallSessionChips callId="t1" sessions={[session(1)]} inThread={new Set([session(1).conversation_id])} />);
  expect(none.querySelectorAll("button")).toHaveLength(0);
});
