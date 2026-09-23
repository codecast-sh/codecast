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
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";
import { clip } from "../roomThreadModel";
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

const roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>();
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.set(container, root);
  await act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}
/** The root a render made, to render the same tree again with new props. */
const root = (r: { container: HTMLElement }) => roots.get(r.container)!;

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
  expect(card.textContent).toContain("Add an agent to the room. It hears the room and answers here.");
  const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(buttons).toEqual(["Add an agent", "Transcribe without one"]);
  // The card is the one call to add an agent: the header's own button steps
  // aside while it is on screen. The composer is there.
  expect(r.container.querySelector(".rt-head .rt-add")).toBeNull();
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the room");
  // Every button of the thread's own has a title (the composer is team chat's).
  for (const b of r.container.querySelectorAll("button")) {
    if (b.closest(".rt-foot")) continue;
    expect(b.getAttribute("title") ?? b.getAttribute("aria-label")).toBeTruthy();
  }
  await r.unmount();
});

const eventTexts = (root: Element) =>
  [...root.querySelectorAll(".rt-event")].map((e) => e.textContent?.replace(/\d{1,2}:\d{2}(\s?[AP]M)?$/, "").trim());

test("an event row names who did what, explains an agent once, and the room's own agent is simply in the room", async () => {
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
  const events = eventTexts(r.container);
  expect(events[0]).toBe("Room agent is in the room · it hears the room and answers here");
  expect(events[1]).toBe("Ann added Team huddle");
  expect(events[2]).toBe("You switched transcription off");
  // Event rows are not chat lines and never group with one.
  expect(r.container.querySelectorAll(".rt-line").length).toBe(0);
  // Events alone do not make a room busy: the empty card still leads, and
  // the events sit under it.
  const card = r.container.querySelector(".rt-empty")!;
  expect(card).not.toBeNull();
  expect(card.compareDocumentPosition(r.container.querySelector(".rt-event")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await r.unmount();
});

test("on the stage before transcription starts, an earlier call's events do not show", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const own = { conversation_id: "conv_room", short_id: "jx7room", title: "Room agent", agent_type: "claude_code" };
  const rows = [
    { _id: "old-ev", user_id: "u-ann", user_name: "Ann Lee", text: "", at: START - 3_600_000, mine: false, agent: own, event: "agent_joined" },
    { _id: "old-off", user_id: "u-ann", user_name: "Ann Lee", text: "", at: START - 3_500_000, mine: false, agent: null, event: "transcribe_off" },
    { _id: "old", user_id: "u-ann", user_name: "Ann Lee", text: "see the notes before we start", at: START - 3_400_000, mine: false, agent: null },
  ];
  const r = await render(
    <RoomThread roomKey={ROOM} call={null} rows={rows as any} liveTranscriptId={null} surface="stage" seated />,
  );
  // No call anchors the log, so no came and went line reads as happening now;
  // the typed line stays, with no divider to set it apart from nothing.
  expect(r.container.querySelectorAll(".rt-event").length).toBe(0);
  expect(r.container.querySelector(".rt-line")?.textContent).toContain("see the notes before we start");
  expect(r.container.querySelector(".rt-divider")).toBeNull();
  await r.unmount();
});

test("after the call an agent's event reads in the past, typed lines from other calls are set apart, and other calls' events are gone", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const own = { conversation_id: "conv_room", short_id: "jx7room", title: "Room agent", agent_type: "claude_code" };
  const END = START + 120_000;
  const rows = [
    // An earlier call's event is that call's log, not this room's content.
    { _id: "old-ev", user_id: "u-ann", user_name: "Ann Lee", text: "", at: START - 3_600_000, mine: false, agent: own, event: "agent_joined" },
    { _id: "old", user_id: "u-ann", user_name: "Ann Lee", text: "see https://example.com/notes before we start", at: START - 3_500_000, mine: false, agent: null },
    { _id: "e0", user_id: "u-me", user_name: "Ashot P", text: "", at: START + 100, mine: false, agent: own, event: "agent_joined" },
    { _id: "e1", user_id: "u-me", user_name: "Ashot P", text: "", at: END - 100, mine: false, agent: null, event: "transcribe_off" },
    // The next call in this room: its events are its own, its typed line is "later".
    { _id: "next-ev", user_id: "u-me", user_name: "Ashot P", text: "", at: END + 180_000, mine: false, agent: own, event: "agent_joined" },
    { _id: "next", user_id: "u-ann", user_name: "Ann Lee", text: "picking this up again", at: END + 200_000, mine: false, agent: null },
  ];
  const r = await render(
    <RoomThread
      roomKey={ROOM}
      call={call({ status: "ended", ended_at: END })}
      rows={rows as any}
      liveTranscriptId={null}
      surface="page"
      seated={false}
    />,
  );
  // Past tense, and no present tense promise about what the agent does.
  expect(eventTexts(r.container)).toEqual(["Room agent was in the room", "You switched transcription off"]);
  const dividers = [...r.container.querySelectorAll(".rt-divider")].map((d) => d.textContent);
  expect(dividers).toEqual(["Earlier in this room", "This call", "Later in this room"]);
  // Typed lines only, no spoken words: nothing a summary would cover, so no note about one.
  expect(r.container.querySelector(".rt-note:not(.rt-divider)")).toBeNull();
  // A link a person typed is a link, the same as one an agent wrote.
  const link = r.container.querySelector<HTMLAnchorElement>(".rt-line a");
  expect(link?.getAttribute("href")).toBe("https://example.com/notes");
  await r.unmount();
});

test("a recording renders every passage open, whatever the page's stored density", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  window.localStorage.setItem("codecast.roomThread.words.page", "folded");
  const segments = [seg(0, "Ada", "first passage", 0), seg(1, "Ada", "second passage", 60_000)];
  const r = await render(
    <RoomThread
      roomKey="rec:5f0b7c1e-2a4d-4c8e-9b3a-1d2e3f4a5b6c"
      call={call({ status: "ended", segments })}
      rows={[]}
      liveTranscriptId={null}
      surface="page"
      seated={false}
    />,
  );
  window.localStorage.removeItem("codecast.roomThread.words.page");
  const heads = r.container.querySelectorAll<HTMLButtonElement>(".rt-passage-head");
  expect(heads.length).toBe(2);
  expect([...heads].map((h) => h.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
  expect(r.container.querySelectorAll(".rt-passage-body").length).toBe(2);
  // No density control on a recording: nothing to unfold with.
  expect(r.container.querySelector('[role="radiogroup"]')).toBeNull();
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
  expect(heads[0].querySelector(".rt-when")?.textContent).toBe("0:00 · 5s · 2 turns");
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
  // The density control is a radiogroup with three positions, and the arrow
  // keys move the check the radio way: one tab stop, Right opens every word.
  const group = r.container.querySelector('[role="radiogroup"]')!;
  expect(group.querySelectorAll('[role="radio"]').length).toBe(3);
  const checked = group.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')!;
  expect(checked.getAttribute("aria-label")).toBe("Spoken words folded");
  expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  await act(() => {
    checked.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(group.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("aria-label")).toBe("Spoken words full");
  expect(r.container.querySelectorAll(".rt-passage-body").length).toBe(2);
  window.localStorage.removeItem("codecast.roomThread.words.stage");
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
    <RoomThread roomKey={ROOM} call={call({ routes })} rows={[]} liveTranscriptId="t1" surface="page" seated />,
  );
  // An agent in the room goes by its character, the name people say to
  // address it: the hash default here, since nobody chose one.
  const name = characterOf({ _id: "conv_other" }).name;
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe(`Message the room · ${name} hears you`);
  // The chip carries that name and breathes while the agent works; the foot
  // says so in words.
  expect(r.container.querySelector(".rt-chip")?.textContent).toContain(name);
  expect(r.container.querySelector(".rt-chip .ch-typing-dots")).not.toBeNull();
  expect(r.container.querySelector(".rt-working")?.textContent).toContain(`${name} is working`);
  // With an agent in and no words yet, the room is listening, not empty.
  expect(r.container.querySelector(".rt-empty")).toBeNull();
  expect(r.container.querySelector(".rt-note")?.textContent).toBe("Listening. Words show up here.");
  await r.unmount();
});

test("the pinned listening line stays while no words have arrived, whatever was typed earlier", async () => {
  useInboxStore.setState({
    currentUser: { _id: "u-me" },
    liveRooms: [],
    sessions: { conv_other: { _id: "conv_other", title: "Team huddle", agent_type: "claude_code", agent_status: "idle" } },
  } as any);
  const routes = [{ kind: "session", target: "conv_other", mode: "live", added_by: "u-me" }];
  const rows = [{ _id: "m1", user_id: "u-me", user_name: "Ashot P", text: "hello room", at: START + 100, mine: true, agent: null }];
  const r = await render(
    <RoomThread roomKey={ROOM} call={call({ routes })} rows={rows as any} liveTranscriptId="t1" surface="stage" seated />,
  );
  // The line is about the silence since transcription started, not about
  // the room's history: a typed line from earlier does not say the room is
  // being listened to now.
  // On the stage the line is the first member of the controls' group at
  // the header's right, not a pinned paragraph under it, so it costs the
  // list no height; the switch beside it already says the room is live, so
  // it is short, with the long form on the title.
  const line = r.container.querySelector<HTMLElement>(".rt-head .rt-head-right .rt-listening")!;
  expect(line.textContent).toBe("Nothing said yet");
  expect(line.getAttribute("title")).toBe("Listening. Words show up here.");
  expect(r.container.querySelector(".rt-note")).toBeNull();
  expect(r.container.querySelector(".rt-line")?.textContent).toContain("hello room");
  expect(r.container.querySelector('[role="switch"]')).not.toBeNull();
  await r.unmount();
});

test("the stage keeps the call's events after transcription is switched off", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const own = { conversation_id: "conv_room", short_id: "jx7room", title: "Room agent", agent_type: "claude_code" };
  const rows = [
    { _id: "e0", user_id: "u-me", user_name: "Ashot P", text: "", at: START + 100, mine: false, agent: own, event: "agent_joined" },
  ];
  const r = await render(
    <RoomThread roomKey={ROOM} call={call()} rows={rows as any} liveTranscriptId="t1" surface="stage" seated />,
  );
  expect(eventTexts(r.container)).toEqual(["Room agent is in the room · it hears the room and answers here"]);
  // The stage hands the thread no call once nothing is live; the rows the
  // switch just wrote are still this call's story, read in the past.
  const after = [...rows, { _id: "e1", user_id: "u-me", user_name: "Ashot P", text: "", at: START + 5_000, mine: false, agent: null, event: "transcribe_off" }];
  await act(() => {
    root(r).render(<RoomThread roomKey={ROOM} call={null} rows={after as any} liveTranscriptId={null} surface="stage" seated />);
  });
  expect(eventTexts(r.container)).toEqual(["Room agent was in the room", "You switched transcription off"]);
  await r.unmount();
});

test("a page link typed on a line of its own is a pill in the rail and a card on the page", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const rows = [
    { _id: "m1", user_id: "u-ann", user_name: "Ann Lee", text: "https://codecast.sh/a/abcdefgh12", at: START + 100, mine: false, agent: null },
  ];
  const rail = await render(
    <RoomThread roomKey={ROOM} call={call()} rows={rows as any} liveTranscriptId="t1" surface="stage" seated />,
  );
  // The rail is 340px wide: the 420px card would fill it from header to composer.
  expect(rail.container.querySelector(".rt-line iframe")).toBeNull();
  expect(rail.container.querySelector<HTMLAnchorElement>(".rt-line a")?.getAttribute("href")).toBe("https://codecast.sh/a/abcdefgh12");
  await rail.unmount();
  const page = await render(
    <RoomThread roomKey={ROOM} call={call()} rows={rows as any} liveTranscriptId="t1" surface="page" seated />,
  );
  expect(page.container.querySelector(".rt-line iframe")).not.toBeNull();
  await page.unmount();
});

test("the stage's placeholder names the agent in a few characters, and the chip and placeholder follow the character that lands later", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [], sessions: {} } as any);
  const routes = [{ kind: "session", target: "conv_other", mode: "live", added_by: "u-me" }];
  const r = await render(
    <RoomThread roomKey={ROOM} call={call({ routes })} rows={[]} liveTranscriptId="t1" surface="stage" seated />,
  );
  // The session has not landed yet, so the room calls it a new agent; the
  // rail's placeholder is short enough for one line at the 272px rail.
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message · new agent hears you");
  expect(r.container.querySelector(".rt-chip")?.textContent).toContain("new agent");
  await act(() => {
    useInboxStore.setState({
      sessions: { conv_other: { _id: "conv_other", title: "Team huddle", agent_type: "claude_code", agent_status: "idle" } },
    } as any);
  });
  const character = characterOf({ _id: "conv_other" }).name;
  expect(r.container.querySelector(".rt-chip")?.textContent).toContain(character);
  expect(r.container.querySelector("textarea")?.getAttribute("placeholder")).toBe(`Message · ${clip(character, 12)} hears you`);
  // A name somebody chose for the session is what the room calls it.
  await act(() => {
    useInboxStore.setState({
      sessions: { conv_other: { _id: "conv_other", title: "Team huddle", agent_type: "claude_code", agent_status: "idle", character_name: "Sage" } },
    } as any);
  });
  expect(r.container.querySelector(".rt-chip")?.textContent).toContain("Sage");
  await r.unmount();
});

test("the recap's closed line is the first sentence, decimals included", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [] } as any);
  const r = await render(
    <RoomThread
      roomKey={ROOM}
      call={call({ status: "ended", summary: "We raised 3.5 million. Then the plan changed.", segments: [seg(0, "Ada", "we raised it", 0)] })}
      rows={[]}
      liveTranscriptId={null}
      surface="page"
      seated={false}
    />,
  );
  expect(r.container.querySelector(".rt-recap-line")?.textContent).toBe("We raised 3.5 million.");
  // With nothing but the density control to show, the page's header is quiet.
  expect(r.container.querySelector(".rt-head")?.classList.contains("rt-head-quiet")).toBe(true);
  await r.unmount();
  // No spoken words, nothing for the density control to act on: no header at all.
  const bare = await render(
    <RoomThread roomKey={ROOM} call={call({ status: "ended" })} rows={[]} liveTranscriptId={null} surface="page" seated={false} />,
  );
  expect(bare.container.querySelector(".rt-head")).toBeNull();
  await bare.unmount();
});
