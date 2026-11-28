// The call's Scribe in the room thread: one of the agent chips, joining
// and seated (roomThread.test.tsx holds the rest of the thread's mounts, and
// the same module mocks, spread from the real ones and put back in afterAll).
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
const rung: Array<[string, string[]]> = [];
mock.module("../../../lib/calls/callManager", () => ({
  ...realCallManager,
  getRoom: () => null,
  ringInto: async (room: string, ids: string[]) => void rung.push([room, ids]),
}));
const realConvexReact = { ...(await import("convex/react")) };
const mutated: unknown[] = [];
const convexMutated: unknown[] = [];
mock.module("convex/react", () => ({
  ...realConvexReact,
  useQueries: () => ({}),
  useQuery: () => undefined,
  useMutation: () => async (args: unknown) => void mutated.push(args),
  useConvex: () => ({ mutation: async (_fn: unknown, args: unknown) => void convexMutated.push(args) }),
}));
// The live call the thread's Scribe row reads (transcripts.getLive, tail 1); every other read is the real hook.
let scribeLive: any = undefined;
const realNoThrow = { ...(await import("../../../hooks/useQueryNoThrow")) };
mock.module("../../../hooks/useQueryNoThrow", () => ({
  ...realNoThrow,
  useQueryNoThrow: (q: any, args: any) => {
    const real = realNoThrow.useQueryNoThrow(q, args);
    return args !== "skip" && args?.tail === 1 && args?.room_key ? { ...real, data: scribeLive } : real;
  },
}));
const { useInboxStore } = await import("../../../store/inboxStore");
const { RoomThread } = await import("../RoomThread");

// Names and faces here are characters, which need Characters on (off by default).
beforeEach(async () => { (await import("../../../test-helpers/characters")).setCharacters(true); });

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
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
  MutationObserver: dom.window.MutationObserver,
  // useFrameTheme posts the theme to a framed page on the next frame.
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
  mock.module("../../../hooks/useQueryNoThrow", () => realNoThrow);
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

const ROOM = "session:conv_room";
const START = 1_700_000_000_000;
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

test("the call's Scribe is one of the agent chips: named Scribe, no face switch, out of the working tail, and its × takes it off at once", async () => {
  const now = Date.now();
  const working = (id: string) => ({ _id: id, title: id, agent_type: "claude_code", agent_status: "working", updated_at: now, last_heartbeat: now });
  useInboxStore.setState({
    currentUser: { _id: "u-me" },
    liveRooms: [],
    sessions: { conv_other: working("conv_other"), conv_scribe: working("conv_scribe") },
    teams: [{ _id: "team1", name: "Team", features: { agent_faces: true } }],
  } as any);
  const routes = [
    { kind: "session", target: "conv_other", mode: "live", added_by: "u-me" },
    { kind: "session", target: "conv_scribe", mode: "live", added_by: "u-me", role: "scribe", face: false },
  ];
  scribeLive = { transcript_id: "t1", team_id: "team1", routes: routes.slice(1), scribe_claim: null };
  const r = await render(
    <RoomThread roomKey={ROOM} call={call({ routes, team_id: "team1" })} rows={[]} liveTranscriptId="t1" surface="stage" seated />,
  );
  const chips = [...r.container.querySelectorAll<HTMLElement>(".rt-chip")];
  const scribeChip = chips.find((c) => c.textContent?.includes("Scribe"))!;
  expect(scribeChip).toBeTruthy();
  expect(scribeChip.querySelector("button[aria-pressed]")).toBeNull();
  expect(chips.find((c) => c !== scribeChip)!.querySelector("button[aria-pressed]")).not.toBeNull();
  const tail = [...r.container.querySelectorAll(".rt-working")].map((e) => e.textContent).join(" ");
  expect(tail).toContain("is working");
  expect(tail).not.toContain("Scribe");
  // Scribe's own store action, and the chip goes in the same frame, before any answer.
  const dispatched: unknown[] = [];
  (useInboxStore.getState() as any)._setDispatch(() => new Promise((res) => void dispatched.push(res)));
  convexMutated.length = 0;
  await act(async () => scribeChip.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click());
  expect(dispatched.length).toBe(1);
  expect(convexMutated).toEqual([]);
  expect([...r.container.querySelectorAll(".rt-chip")].some((c) => c.textContent?.includes("Scribe"))).toBe(false);
  await r.unmount();
  useInboxStore.getState().noteScribePress(ROOM, null);
  scribeLive = undefined;
});

test("a reader outside the call takes Scribe out through its route", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [], sessions: {}, teams: [] } as any);
  const routes = [{ kind: "session", target: "conv_scribe", mode: "live", added_by: "u-me", role: "scribe", face: false }];
  const r = await render(<RoomThread roomKey={ROOM} call={call({ routes })} rows={[]} liveTranscriptId="t1" surface="stage" seated={false} />);
  const chip = [...r.container.querySelectorAll<HTMLElement>(".rt-chip")].find((c) => c.textContent?.includes("Scribe"))!;
  convexMutated.length = 0;
  await act(async () => chip.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click());
  expect(convexMutated).toEqual([{ transcript_id: "t1", kind: "session", target: "conv_scribe" }]);
  await r.unmount();
});

test("a joining Scribe shows as a joining agent chip, and its remove gives the claim back", async () => {
  useInboxStore.setState({ currentUser: { _id: "u-me" }, liveRooms: [], sessions: {}, teams: [] } as any);
  const at = Date.now();
  scribeLive = { transcript_id: "t1", team_id: "team1", routes: [], scribe_claim: { by: "u-me", at } };
  const r = await render(<RoomThread roomKey={ROOM} call={call({ routes: [] })} rows={[]} liveTranscriptId="t1" surface="stage" seated />);
  const chip = [...r.container.querySelectorAll<HTMLElement>(".rt-chip")].find((c) => c.textContent?.includes("Scribe"))!;
  expect(chip).toBeTruthy();
  const dispatched: unknown[] = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: unknown[]) => void dispatched.push([action, args]));
  await act(async () => chip.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click());
  expect(dispatched).toContainEqual(["removeScribe", [ROOM, { claim: at }]]);
  await r.unmount();
  scribeLive = undefined;
});
