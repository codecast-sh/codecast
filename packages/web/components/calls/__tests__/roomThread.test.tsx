// Mounts the room thread in jsdom and checks what the reader sees: the empty
// room as one card with its two ways forward, an event line naming who did
// what, a passage folded to its preview that opens on click, and the
// composer's placeholder naming the one agent in the room.
//
// `bun test components/calls` runs this file in ONE process with the other
// mount tests, and mock.module is process global and permanent, so every
// module mocked here is spread from the real one and put back in afterAll,
// the way followInCall does for callManager.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
mock.module("../../../lib/calls/callManager", () => ({ ...realCallManager, getRoom: () => null }));
const realConvexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvexReact,
  useQueries: () => ({}),
  useQuery: () => undefined,
  useMutation: () => async () => {},
  useConvex: () => ({ mutation: async () => {} }),
}));
const { useInboxStore } = await import("../../../store/inboxStore");
const { RoomThread } = await import("../RoomThread");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh" });
// The composer measures its own row; jsdom has no observer to do it with.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom.window as any).ResizeObserver = TestResizeObserver;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: TestResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here, after the globals above, not as a static import.
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
  mock.module("../../../lib/calls/callManager", () => realCallManager);
  mock.module("convex/react", () => realConvexReact);
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

const ROOM = "session:conv_room";
const START = 1_700_000_000_000;
const seg = (seq: number, speaker: string, text: string, t0: number) => ({
  seq,
  speaker_id: speaker.toLowerCase(),
  speaker_name: speaker,
  text,
  t0,
  t1: t0 + 2000,
  at: START + t0,
});
const call = (over: Partial<any> = {}) => ({
  _id: "t1",
  status: "live",
  started_at: START,
  segments: [],
  summary: null,
  action_items: [],
  routes: [],
  ...over,
});

test("the empty room is one card with the two ways forward", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const r = await render(
    <RoomThread roomKey={ROOM} call={null} rows={[]} liveTranscriptId={null} surface="stage" seated />,
  );
  const card = r.container.querySelector(".rt-empty")!;
  expect(card.textContent).toContain("Add an agent to the room. It hears what is said and answers in this thread.");
  const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(buttons).toEqual(["Add an agent", "Transcribe without one"]);
  // The header offers the same first act, and the composer is there.
  expect(r.container.querySelector(".rt-add")?.textContent?.trim()).toBe("Add an agent");
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the room");
  // Every button of the thread's own has a title (the composer is team chat's).
  for (const b of r.container.querySelectorAll("button")) {
    if (b.closest(".rt-foot")) continue;
    expect(b.getAttribute("title") ?? b.getAttribute("aria-label")).toBeTruthy();
  }
  await r.unmount();
});

test("an event row names who did what, and the room's own agent is simply in the room", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const agent = { conversation_id: "conv_other", short_id: "jx7other", title: "Team huddle", agent_type: "claude_code" };
  const own = { conversation_id: "conv_room", short_id: "jx7room", title: "Room agent", agent_type: "claude_code" };
  const rows = [
    { _id: "e0", user_id: "u-me", user_name: "Ashot P", text: "", at: START + 100, mine: false, agent: own, event: "agent_joined" },
    { _id: "e1", user_id: "u-ann", user_name: "Ann Lee", text: "", at: START + 500, mine: false, agent, event: "agent_joined" },
    { _id: "e2", user_id: "u-me", user_name: "Ashot P", text: "", at: START + 900, mine: false, agent: null, event: "transcribe_off" },
  ];
  const r = await render(
    <RoomThread roomKey={ROOM} call={call()} rows={rows as any} liveTranscriptId="t1" surface="stage" seated />,
  );
  const events = [...r.container.querySelectorAll(".rt-event")].map((e) => e.textContent?.replace(/\d{1,2}:\d{2}(\s?[AP]M)?$/, "").trim());
  expect(events[0]).toBe("Room agent is in the room · it hears everything and answers here");
  expect(events[1]).toBe("Ann added Team huddle · it hears the room and answers here");
  expect(events[2]).toBe("You switched transcription off");
  // Event rows are not chat lines and never group with one.
  expect(r.container.querySelectorAll(".rt-line").length).toBe(0);
  await r.unmount();
});

test("a folded passage shows its preview and opens on click", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  // Two passages split by a long silence; the call has ENDED so neither is
  // the live one that stays open by itself.
  const segments = [
    seg(0, "Ada", "we should ship the thread on Friday", 0),
    seg(1, "Bob", "agreed, after the review", 3000),
    seg(2, "Ada", "second passage starts here", 60_000),
  ];
  const r = await render(
    <RoomThread
      roomKey={ROOM}
      call={call({ status: "ended", segments, summary: "Ship Friday. Review first.", action_items: ["Review the thread"] })}
      rows={[]}
      liveTranscriptId={null}
      surface="stage"
      seated={false}
    />,
  );
  const heads = r.container.querySelectorAll<HTMLButtonElement>(".rt-passage-head");
  expect(heads.length).toBe(2);
  expect(heads[0].getAttribute("aria-expanded")).toBe("false");
  expect(heads[0].querySelector(".rt-passage-who")?.textContent).toBe("Ada, Bob");
  expect(heads[0].querySelector(".rt-passage-when")?.textContent).toBe("0:00 · 5 s · 2 turns");
  expect(heads[0].querySelector(".rt-passage-preview")?.textContent).toBe(
    "Ada: we should ship the thread on Friday · Bob: agreed, after the review",
  );
  expect(r.container.querySelector(".rt-passage-body")).toBeNull();
  await act(() => {
    heads[0].click();
  });
  const head = r.container.querySelector<HTMLButtonElement>(".rt-passage-head")!;
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(head.querySelector(".rt-passage-preview")).toBeNull();
  const body = r.container.querySelector(".rt-passage-body")!;
  expect(body.textContent).toContain("we should ship the thread on Friday");
  expect(body.textContent).toContain("agreed, after the review");
  // The recap reads "Summary" after the call, one line closed.
  const recap = r.container.querySelector<HTMLButtonElement>(".rt-recap-head")!;
  expect(recap.textContent).toContain("Summary");
  expect(recap.querySelector(".rt-recap-line")?.textContent).toBe("Ship Friday.");
  await act(() => {
    recap.click();
  });
  expect(r.container.querySelector(".rt-recap-body")?.textContent).toContain("Review the thread");
  // The density control is a radiogroup with three positions.
  const group = r.container.querySelector('[role="radiogroup"]')!;
  expect(group.querySelectorAll('[role="radio"]').length).toBe(3);
  expect(group.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("aria-label")).toBe("Spoken words folded");
  // After the call nothing can be added or switched.
  expect(r.container.querySelector(".rt-add")).toBeNull();
  expect(r.container.querySelector('[role="switch"]')).toBeNull();
  await r.unmount();
});

test("the composer names the one agent in the room", async () => {
  useInboxStore.setState({
    currentUser: { _id: "u-me" },
    liveRooms: [],
    sessions: { conv_other: { _id: "conv_other", title: "Team huddle", agent_type: "claude_code", agent_status: "working" } },
  } as any);
  const routes = [{ kind: "session", target: "conv_other", mode: "live", added_by: "u-me" }];
  const r = await render(
    <RoomThread roomKey={ROOM} call={call({ routes })} rows={[]} liveTranscriptId="t1" surface="stage" seated />,
  );
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the room · Team huddle hears you");
  // The chip breathes while the agent works, and the foot says so.
  expect(r.container.querySelector(".rt-chip .call-chat-dots")).not.toBeNull();
  expect(r.container.querySelector(".rt-working")?.textContent).toContain("Team huddle is working");
  // With an agent in and no words yet, the room is listening, not empty.
  expect(r.container.querySelector(".rt-empty")).toBeNull();
  expect(r.container.querySelector(".rt-note")?.textContent).toBe("Listening. Words appear here as people speak.");
  await r.unmount();
});
