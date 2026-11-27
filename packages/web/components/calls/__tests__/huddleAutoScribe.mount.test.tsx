import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// "Invite Scribe to every huddle": seated in a huddle of a workspace where it
// is on, this client invites Scribe once per call, and never where it is off.

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
const invite = mock(() => {});
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
  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { huddleAutoScribe: { "team:t1": true, "team:t2": false } } } }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(() => root.render(<HuddleAutoScribe />));

  seat("channel:a");
  live = liveCall("call-1");
  await render();
  expect(invite).toHaveBeenCalledTimes(1);
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
  await act(() => root.unmount());
});
