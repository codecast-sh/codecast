// "Where you work" for a joiner whose machine has never synced: the step
// offers the one-step machine setup instead of a two-command install, and
// says it is waiting once a machine has just been connected.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/settings/team/join", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useMutation: () => async () => ({ token: "setup_tok_123456", expiresAt: Date.now() + 3_600_000 }), useQuery: () => undefined, useQueries: () => ({}) }));

const { WorkspaceSharePicker } = await import("../WorkspaceSharePicker");
const { CLI_CONNECTED_KEY } = await import("../../../lib/cliConnected");

const data: any = { suggestions: null, allProjects: [], suggestedPaths: new Set(), matched: [], other: [], teamName: "Littlebird", teamOnlyRepos: [], getSuggestion: () => undefined };
let root: Root;
const render = () => act(async () => root.render(<WorkspaceSharePicker data={data} teamId={null} selectedPaths={{}} onToggle={() => {}} />));
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  sessionStorage.removeItem(CLI_CONNECTED_KEY);
});
afterEach(async () => { await act(async () => root.unmount()); });

test("a joiner with no synced machine is offered the one-step setup", async () => {
  await render();
  expect(text()).toContain("Connect this machine first");
  expect(text()).toContain("Generate install command");
  expect(text()).not.toContain("cast auth");
});

test("a machine that just connected waits for sessions instead of installing again", async () => {
  sessionStorage.setItem(CLI_CONNECTED_KEY, String(Date.now()));
  await render();
  expect(text()).toContain("Waiting for your first sessions");
  expect(text()).not.toContain("Generate install command");
});
