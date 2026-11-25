// ct-101490: a mint the daemon rejected (its account check did not pass) must
// show on the account itself, with a way to recover in the app, not only
// inside a dialog the person has no reason to reopen.
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
const { ConvexProvider } = await import("convex/react");
const { MintTokenButton } = await import("../../MintTokenDialog");

const REASON = "the browser signed into a different Claude account than work@example.com (and none of the other saved accounts) — sign out of claude.ai, sign in as work@example.com, and try again";
const profiles = [{ name: "work", email: "work@example.com" }, { name: "home", email: "home@example.com" }];
const client = { mutation: async () => ({}) } as any;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];

async function renderRow(finishedAgoMs: number) {
  const now = Date.now();
  const device = { device_id: "mini", label: "Mac Mini", online: true, profiles, provider_key_pubkey: "",
    mint_flow: { status: "rejected" as const, profile: "work", reason: REASON, started_at: now - finishedAgoMs - 60_000, finished_at: now - finishedAgoMs } };
  await act(() => root.render(<ConvexProvider client={client}><MintTokenButton device={device} profile={profiles[0]} /></ConvexProvider>));
  return buttons()[0];
}

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
afterAll(() => { dom.window.close(); restore(); });

test("the account row shows the rejected mint, with its reason on hover", async () => {
  const row = await renderRow(2 * 60_000);
  expect(row.textContent?.trim()).not.toBe("mint token");
  expect(row.title).toContain(REASON);
});

test("the failure stays on the row after the dialog's 30-minute window", async () => {
  const row = await renderRow(2 * 60 * 60_000);
  expect(row.textContent?.trim()).not.toBe("mint token");
  expect(row.title).toContain(REASON);
});

test("opening the failed row offers recovery in the app: the reason, Try again, and a different account", async () => {
  const row = await renderRow(2 * 60_000);
  await act(async () => { row.click(); });
  const dialog = document.querySelector("[role=dialog]")!;
  expect(dialog.textContent).toContain(REASON);
  const labels = buttons().map(b => b.textContent?.trim());
  expect(labels).toContain("Try again");
  expect(labels).toContain("Use a different account");
  expect(dialog.textContent).not.toMatch(/Terminal/);
});
