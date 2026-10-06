// The team feed's share card for a member who shares nothing yet. When
// teammates work in a repo the member also works in, it names that repo and
// shares it from now on in one click (earlier sessions stay private).
// Otherwise it is the generic link into the sharing setup.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/team/activity", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = "team_1";
let suggestions: any = null;
const saves: any[] = [];
const pushes: string[] = [];
const hooks = await import("../../hooks/useTeamWorkspaceSuggestions");
mock.module("../../hooks/useTeamWorkspaceSuggestions", () => ({
  ...hooks,
  useTeamWorkspaceSuggestions: () => ({ suggestions, allProjects: [], teamName: "Littlebird" }),
}));
const saveMod = await import("../../lib/team/saveTeamSetup");
mock.module("../../lib/team/saveTeamSetup", () => ({ ...saveMod, useSaveTeamSetup: () => async (input: any) => { saves.push(input); return { mapped: 1 }; } }));
const nav = await import("next/navigation");
mock.module("next/navigation", () => ({ ...nav, useRouter: () => ({ push: (u: string) => pushes.push(u), replace: (u: string) => pushes.push(u) }), useSearchParams: () => new URLSearchParams() }));

const { TeamShareNudge } = await import("../ActivityFeed");
const { pickShareSuggestion } = hooks;

const repo = (path: string, members: number, sessions: number, current: string | null = null) => ({
  path, git_remote_url: null, session_count: sessions, last_active: 1, matched_member_count: members, match_type: "github", match_reason: "", current_team_id: current,
});

let root: Root;
const render = () => act(async () => root.render(<TeamShareNudge teamId={TEAM} />));
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  saves.length = 0;
  pushes.length = 0;
});
afterEach(async () => { await act(async () => root.unmount()); });

test("the picker takes the repo with the most teammates, then the most own sessions", () => {
  const pick = pickShareSuggestion([repo("/a/small", 1, 50), repo("/a/app", 4, 3), repo("/a/api", 4, 9)], TEAM);
  expect(pick?.path).toBe("/a/api");
});

test("the picker skips repos already shared with this team, empty ones and agent scratch checkouts", () => {
  expect(pickShareSuggestion([repo("/a/app", 3, 9, TEAM), repo("/a/none", 2, 0), repo("/w/wf_ab12/x", 5, 9), repo("/r/.codecast/wt", 5, 9)], TEAM)).toBeNull();
  expect(pickShareSuggestion([repo("/a/app", 0, 9)], TEAM)).toBeNull();
});

test("a matching repo is named and shared from now on in one click", async () => {
  suggestions = { current_visibility: "full", suggestions: [repo("/Users/me/littlebird-app", 5, 42)] };
  await render();
  expect(text()).toContain("5 teammates work in littlebird-app too");
  expect(text()).toContain("42 sessions");
  const before = Date.now();
  await act(async () => { button("Share from now on")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  expect(saves).toHaveLength(1);
  expect(saves[0].teamId).toBe(TEAM);
  expect(saves[0].visibility).toBe("full");
  expect(saves[0].selectedPaths).toEqual({ "/Users/me/littlebird-app": true });
  expect(saves[0].shareSince).toBeGreaterThanOrEqual(before);
});

test("with no matching repo it is the link into the sharing setup", async () => {
  suggestions = { current_visibility: "full", suggestions: [] };
  await render();
  expect(text()).toContain("Share your workspaces with the team");
  await act(async () => { button("Set up sharing")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  expect(pushes).toEqual([`/settings/team/join?teamId=${TEAM}&setup=1`]);
  expect(saves).toHaveLength(0);
});
