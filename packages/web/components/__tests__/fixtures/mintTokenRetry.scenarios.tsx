import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { MintTokenHarness, mintCalls } = await import("./mintToken");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const labels = () => [...document.querySelectorAll<HTMLButtonElement>("button")].map(b => b.textContent?.trim());
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label);
const click = (label: string) => act(async () => { button(label)!.click(); });

// The daemon's own rejection when the minted token proves to be another
// account's (watchMintFlow → storeMinted in packages/cli/src/daemon.ts).
const WRONG_ACCOUNT = "the browser signed into a different Claude account than work@example.com (and none of the other saved accounts) — sign out of claude.ai, sign in as work@example.com, and try again";

beforeEach(async () => {
  mintCalls.length = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const finished = Date.now() - 1_000;
  await act(() => root.render(<MintTokenHarness initialFlow={{
    status: "rejected", profile: "work", email: "work@example.com", started_at: finished - 11_000, finished_at: finished, reason: WRONG_ACCOUNT,
  }} />));
  await click("mint token");
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
afterAll(() => { dom.window.close(); restore(); });

// ct-101468: a mint rejected because the browser is signed into another
// account fails the same way on every retry, since the browser is still
// signed in as that account. On a machine with more than one saved profile
// the rejected dialog must offer a step that changes the outcome, not only
// a "Try again" that reopens the same sign-in.
test("a wrong-account rejection offers another account, not only the same retry", async () => {
  expect(document.body.textContent).toContain("The mint did not complete");
  expect(button("Use a different account"), `rejected dialog offers only: ${JSON.stringify(labels())}`).toBeDefined();
  await click("Use a different account");
  expect(document.querySelector("select"), "choosing another account shows the account picker").not.toBeNull();
  expect(mintCalls.some(c => c.name === "accountSwitch:requestMintToken"), "choosing does not relaunch the same doomed mint").toBe(false);
});
