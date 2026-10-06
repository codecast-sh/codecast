// The admin's team feed card: it asks once (no subscription), says how many
// people at the domain are outside the team, opens the team in one click,
// snoozes on "Not now", and stays away for members.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/team/activity", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "HTMLInputElement", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

let nudge: any = null;
const queries: string[] = [];
const mutations: Array<[string, any]> = [];
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useConvex: () => ({ query: async (ref: any) => { queries.push(getFunctionName(ref)); return nudge; } }),
  useMutation: (ref: any) => async (args: any) => { mutations.push([getFunctionName(ref), args]); return {}; },
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { TeamFindableNudge } = await import("../team/TeamFindableNudge");

let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = async () => { await act(async () => root.render(<TeamFindableNudge teamId={"t1" as any} teamName="Littlebird" />)); await flush(); };
const text = () => document.body.textContent ?? "";
const click = (label: string) => act(async () => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
});
const setRole = (role: string) => useInboxStore.setState((s: any) => ({ teams: [{ _id: "t1", name: "Littlebird", role }], clientState: { ...s.clientState, dismissed: {} } }));

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  nudge = { domain: "littlebird.ai", coworkers_outside: 7 };
  queries.length = 0;
  mutations.length = 0;
});
afterEach(async () => { await act(async () => root.unmount()); });

test("an admin sees how many coworkers are outside and opens the team in one click", async () => {
  setRole("admin");
  await render();
  expect(queries).toEqual(["teamDiscovery:discoveryNudge"]);
  expect(text()).toContain("7 people with @littlebird.ai addresses use codecast but aren't on Littlebird.");
  await click("Let them find it");
  expect(mutations).toEqual([["teamDiscovery:setDiscoverable", { team_id: "t1", enabled: true }]]);
  expect(text()).toBe("");
});

test("Not now snoozes it", async () => {
  setRole("admin");
  await render();
  await click("Not now");
  expect(useInboxStore.getState().clientState.dismissed?.team_findable_nudge).toBeGreaterThan(0);
});

test("a member never asks", async () => {
  setRole("member");
  await render();
  expect(queries).toEqual([]);
  expect(text()).toBe("");
});
