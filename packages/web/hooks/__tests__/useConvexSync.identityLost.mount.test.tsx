// A window whose server identity is lost after it was confirmed applies
// nothing it receives until the identity is back.
//
// When a token refresh fails, Convex clears the socket's identity, reports
// isAuthenticated false and gives up, while the local token keeps the window
// mounted. Every live query re-runs as an anonymous caller. teams.getUserTeams
// answers a stranger with `[]`, so the desktop voice window came to hold no
// teams: calls read as switched off (a face card in a huddle offered Message
// and no Join), and five seconds later the teams repair moved the window to
// the personal workspace, a write that reached the account (2026-09-29).

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

mock.restore();

let authenticated = true;
let teamsAnswer: any[] | undefined;
const switched: Array<string | null> = [];

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: authenticated, isLoading: false }),
  useQuery: (_q: unknown, args: unknown) => (args === "skip" ? undefined : teamsAnswer),
  // useQueryNoThrow's transport (useSyncTeams subscribes through it).
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, teamsAnswer])),
  useMutation: () => async () => {},
}));
const realSwitch = await import("../useSwitchWorkspace");
mock.module("../useSwitchWorkspace", () => ({
  ...realSwitch,
  useSwitchWorkspace: () => async (id: string | null) => { switched.push(id); },
}));
const realRole = await import("../useSyncRole");
mock.module("../useSyncRole", () => ({ ...realRole, useIsSyncHost: () => true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useConvexSync } = await import(`${import.meta.dir}/../useConvexSync.ts?fresh-lost`);
const { useSyncTeams } = await import(`${import.meta.dir}/../useSyncTeams.ts?fresh-lost`);
const { useInboxStore } = await import("../../store/inboxStore");

afterAll(() => {
  mock.module("convex/react", () => convexReact);
  mock.module("../useSwitchWorkspace", () => realSwitch);
  mock.module("../useSyncRole", () => realRole);
  closeDomWindow(dom);
  restoreGlobals();
});

let root: Root;
beforeEach(() => {
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
});

describe("useConvexSync while the server identity is lost", () => {
  test("applies nothing between the loss and the re-authenticated answer", async () => {
    const applied: unknown[] = [];
    let data: unknown;
    function Probe() {
      useConvexSync(data, (d: unknown) => applied.push(d));
      return null;
    }
    const step = async (auth: boolean, next: unknown) => {
      authenticated = auth;
      data = next;
      await act(async () => root.render(<Probe />));
    };
    const strangers: unknown[] = [];
    await step(true, ["mine"]);
    await step(false, strangers);
    // The flip back renders once with the stranger's answer still in hand
    // before the real one lands; that render must not apply it either.
    await step(true, strangers);
    await step(true, ["mine", "new"]);
    expect(applied).toEqual([["mine"], ["mine", "new"]]);
    await act(async () => root.unmount());
  });

  test("a caller the server never confirmed (a guest) applies as before", async () => {
    const applied: unknown[] = [];
    authenticated = false;
    function Probe() {
      useConvexSync(["public"], (d: unknown) => applied.push(d));
      return null;
    }
    await act(async () => root.render(<Probe />));
    expect(applied).toEqual([["public"]]);
    await act(async () => root.unmount());
  });
});

describe("useSyncTeams while the server identity is lost", () => {
  test("keeps the teams it knew and never repairs the active team", async () => {
    const TEAM = "k97cc9y1a48swe3kfnwcs44a857wmxj2";
    switched.length = 0;
    useInboxStore.getState().syncTable("teams", []);
    useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, active_team_id: TEAM } } }));
    function Probe() {
      useSyncTeams();
      return null;
    }
    authenticated = true;
    teamsAnswer = [{ _id: TEAM, name: "Union", features: { calls: true } }];
    await act(async () => root.render(<Probe />));
    expect(useInboxStore.getState().teams.map((t: any) => t._id)).toEqual([TEAM]);

    // The repair waits 5s before it switches; record every timer armed while
    // the stranger's answer is in hand.
    const armed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
      armed.push(ms ?? 0);
      return (realSetTimeout as any)(fn, ms, ...rest);
    };
    try {
      authenticated = false;
      teamsAnswer = [];
      await act(async () => root.render(<Probe />));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(armed.filter((ms) => ms >= 5000)).toEqual([]);
    expect(useInboxStore.getState().teams.map((t: any) => t._id)).toEqual([TEAM]);
    expect(switched).toEqual([]);
    await act(async () => root.unmount());
  });
});
