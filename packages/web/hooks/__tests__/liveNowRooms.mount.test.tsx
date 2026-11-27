import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { resetFaceRow } from "../../lib/faces/faceRow";
import { useLiveNowRooms } from "../useLiveRooms";

// Personal's Live now lists an owner-only session room once its session is
// known to be the viewer's, including when the session row lands after the
// room does.

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
const ROOM = "session:c1";
let shown: string[] = [];
function Probe() {
  shown = useLiveNowRooms().map((r) => r.roomKey);
  return null;
}

let root: Root | null = null;
const before = useInboxStore.getState();
beforeEach(() => {
  resetFaceRow();
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientState: { ...before.clientState, ui: { ...(before.clientState as any)?.ui, active_team_id: null } },
    liveRooms: [{ room_key: ROOM, team_id: "t1", can_join: true, redacted: false, members: [{ user_id: ME }] }],
    callRooms: { [ROOM]: { _id: ROOM, locked: false, private: true, owner_only: true, transcribe_off: false, transcribe_off_at: null } },
    sessions: {},
  } as any);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

test("an owner-only room joins Live now when its session row arrives after it", async () => {
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  expect(shown).toEqual([]);
  await act(async () => {
    useInboxStore.setState({ sessions: { c1: { _id: "c1", user_id: ME } } } as any);
  });
  expect(shown).toEqual([ROOM]);
});

test("a teammate's owner-only room stays off it", async () => {
  useInboxStore.setState({ sessions: { c1: { _id: "c1", user_id: "u-ann" } } } as any);
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  expect(shown).toEqual([]);
});
