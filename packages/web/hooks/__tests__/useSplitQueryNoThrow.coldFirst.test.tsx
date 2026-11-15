import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { splitRows } from "@codecast/shared/contracts/inboxSplit";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// A web launch holds no split rows, so a split value cannot be rebuilt: the
// feeder used to answer it with a second, whole query, and a cold inbox waited
// a full server round trip for it. The first subscription now asks for the
// whole result and seeds the held rows; the split form follows.

const now = Date.now();
const rows: Array<[string, any]> = [
  ["a", { _id: "a", title: "hot", updated_at: now }],
  ["b", { _id: "b", title: "cold", updated_at: now - 86_400_000 }],
];
const whole = { sessions: rows.map(([, r]) => r), hidden_count: 0, truncated: false };
const wire = splitRows(rows, now);
const split = { split: true, ids: wire.ids, hot: wire.hot.map(([, r]) => r), cold_hash: wire.cold_hash, hidden_count: 0, truncated: false };

const subscribed: any[] = [];
const answers = new Map<string, any>();
const realQueryNoThrow = { ...(await import("../useQueryNoThrow")) };
mock.module("../useQueryNoThrow", () => ({
  ...realQueryNoThrow,
  useQueryNoThrow: (_q: unknown, args: any) => {
    subscribed.push(args);
    return { data: args === "skip" ? undefined : answers.get(args.split ? "split" : "whole"), error: undefined };
  },
}));
const wholeFetches: any[] = [];
const client = { query: async (_q: unknown, args: any) => { wholeFetches.push(args); return whole; } };
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvex,
  useConvex: () => client,
}));

const { useSplitQueryNoThrow } = await import("../useSplitQuery");
const { api } = await import("@codecast/convex/convex/_generated/api");

test("with nothing held, the first answer is the whole result and no second fetch follows", async () => {
  const seen: any[] = [];
  function Probe() {
    seen.push(useSplitQueryNoThrow(api.conversations.listInboxSessions, { show_all: false }, "list").data);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
  expect(subscribed[0]).toEqual({ show_all: false });

  answers.set("whole", whole);
  act(() => root.render(<Probe />));
  expect(seen.at(-1)).toEqual(whole);
  expect(subscribed.at(-1)).toEqual({ show_all: false, split: true });

  answers.set("split", split);
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)?.sessions.map((r: any) => r._id)).toEqual(["a", "b"]);
  expect(wholeFetches).toEqual([]);
  act(() => root.unmount());
});
