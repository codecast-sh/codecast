import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { announceJoin, clearJoinAnnouncement } from "../../lib/calls/joinAnnounce";
import { resetFaceRow, type FaceRow } from "../../lib/faces/faceRow";
import { useFaceRow } from "../useFaceRow";

// THE ROW'S WAKE DISCIPLINE (pl-756 F1). The header bar is mounted for the
// life of the app and the roster re-pushes every few seconds on heartbeat
// counters, so the hook must render its caller only when a face changed:
// once for the store write that moves a face, once for a join announcement,
// and never for a push that changed nothing a face draws.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ME = "u-me";
const ANN = "u-ann";
const member = (id: string, name: string, over: Record<string, unknown> = {}) => ({ _id: id, name, presence_state: "active", ...over });

let renders = 0;
let latest: FaceRow;
function Probe() {
  renders++;
  latest = useFaceRow();
  return null;
}

let root: Root | null = null;
beforeEach(() => {
  renders = 0;
  resetFaceRow();
  clearJoinAnnouncement();
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    teamMembers: [member(ME, "Me"), member(ANN, "Ann")],
    callOccupancy: {},
    liveRooms: [],
    myCalls: { incoming: [], outgoing: [], membership: null },
    followLeaderId: null,
    call: { ...useInboxStore.getState().call, phase: "idle", roomKey: null, muted: true },
  } as any);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  clearJoinAnnouncement();
});
async function mount() {
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  await act(async () => root!.render(<Probe />));
}

test("a heartbeat only roster push renders nobody; a face change renders once", async () => {
  await mount();
  const first = latest;
  expect(first.entries.map((e) => e.id)).toEqual([ANN]);
  const mounted = renders;

  await act(async () => {
    useInboxStore.setState({
      teamMembers: [member(ME, "Me"), member(ANN, "Ann", { presence_input_at: Date.now(), daemon_last_seen: Date.now() })],
    } as any);
  });
  expect(renders).toBe(mounted);
  expect(latest).toBe(first);

  await act(async () => {
    useInboxStore.setState({ followLeaderId: ANN } as any);
  });
  expect(renders).toBe(mounted + 1);
  expect(latest.entries[0]).toMatchObject({ id: ANN, followed: true });
});

test("a join announcement wakes the row through its own subscription", async () => {
  const room = `dm:${ANN}:${ME}`;
  useInboxStore.setState({
    call: { ...useInboxStore.getState().call, phase: "connected", roomKey: room, muted: false },
    callOccupancy: { [room]: [{ user_id: ME }, { user_id: ANN }] },
  } as any);
  await mount();
  expect(latest.card.kind).toBe("live");
  const mounted = renders;
  await act(async () => {
    announceJoin(room, "Ann joined");
  });
  expect(renders).toBe(mounted + 1);
  expect(latest.card).toMatchObject({ kind: "joined-notice", text: "Ann joined" });
  expect(latest.entries.map((e) => e.state)).toEqual(["in-call", "joining"]);
});
