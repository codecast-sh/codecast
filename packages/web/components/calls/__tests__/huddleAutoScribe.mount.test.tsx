import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// "Invite Scribe to every huddle": seated in a huddle of a workspace where it
// is on, this client asks for Scribe once per call, as an automatic invite
// (the server refuses one after a removal: transcripts.scribe.test), and
// never where it is off, in a recording, or as a guest.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let live: any = null;
const invite = mock((_opts?: { auto?: boolean }) => {});
const realQuery = { ...(await import("../../../hooks/useQueryNoThrow")) };
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: (_q: unknown, args: unknown) => ({ data: args === "skip" ? undefined : live }) }));
const realScribe = { ...(await import("../useScribe")) };
mock.module("../useScribe", () => ({ ...realScribe, useScribe: () => ({ present: false, status: "absent", invite, remove: () => {} }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { HuddleAutoScribe } = await import("../HuddleAutoScribe");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const seat = (roomKey: string | null) =>
  useInboxStore.setState((s: any) => ({ call: { ...s.call, roomKey, phase: roomKey ? "connected" : "idle" } }));
const liveCall = (id: string, team = "t1") => ({ transcript_id: id, team_id: team, routes: [], scribe_claim: null });

test("invites once per call where the workspace asks for it, and not elsewhere", async () => {
  useInboxStore.setState((s: any) => ({ currentUser: { _id: "u1" }, clientState: { ...s.clientState, ui: { huddleAutoScribe: { "team:t1": true, "team:t2": false } } } }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(() => root.render(<HuddleAutoScribe />));

  seat("channel:a");
  live = liveCall("call-1");
  await render();
  expect(invite).toHaveBeenCalledTimes(1);
  expect(invite.mock.calls[0][0]).toEqual({ auto: true });
  // The same call, rendered again and rejoined: no second invite.
  await render();
  seat(null);
  await render();
  seat("channel:a");
  await render();
  expect(invite).toHaveBeenCalledTimes(1);

  // A new call in the same room: one more.
  live = liveCall("call-2");
  await render();
  expect(invite).toHaveBeenCalledTimes(2);

  // A huddle in a workspace where it is off: none.
  seat("channel:b");
  live = liveCall("call-3", "t2");
  await render();
  expect(invite).toHaveBeenCalledTimes(2);

  // Turned on mid-call: that call gets its invite.
  await act(() => useInboxStore.getState().updateClientUI({ huddleAutoScribe: { "team:t1": true, "team:t2": true } }));
  expect(invite).toHaveBeenCalledTimes(3);

  // A recording is no huddle: nothing, whatever its transcript says.
  seat("rec:abcdef123456");
  live = liveCall("call-rec");
  await render();
  seat("meet:abcdef123456");
  live = liveCall("call-meet");
  await render();
  expect(invite).toHaveBeenCalledTimes(3);

  // A solo huddle bills to a team it borrowed, but asks by the person's own
  // setting: the team's says nothing about it.
  seat("dm:u1");
  live = { ...liveCall("call-solo", "t1"), personal: true };
  await act(() => useInboxStore.getState().updateClientUI({ huddleAutoScribe: { "team:t1": false, "user:u1": true } }));
  await render();
  expect(invite).toHaveBeenCalledTimes(4);
  seat("dm:u1");
  live = { ...liveCall("call-solo-2", "t1"), personal: true };
  await act(() => useInboxStore.getState().updateClientUI({ huddleAutoScribe: { "team:t1": true, "user:u1": false } }));
  await render();
  expect(invite).toHaveBeenCalledTimes(4);

  // Nor does a guest's seat ask.
  useInboxStore.setState({ currentUser: { _id: "guest:g1" } } as any);
  seat("channel:c");
  live = liveCall("call-guest");
  await render();
  expect(invite).toHaveBeenCalledTimes(4);
  await act(() => root.unmount());
});
