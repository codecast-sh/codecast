// The folder-transfer strip in the conversation header: each phase reads off
// the conversation row in the store, Cancel paints "Cancelling" at once
// through the store action, and a failure offers Try again.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const { PeerTransferStrip } = await import("../sessionChrome");
const { useInboxStore } = await import("../../../store/inboxStore");

const ID = "conv_1";
let root: Root;
let retries = 0;
const setTransfer = (peer_transfer: Record<string, unknown> | undefined) =>
  act(async () => { useInboxStore.setState({ conversations: { [ID]: { _id: ID, peer_transfer } } } as any); });
const strip = () => document.querySelector("[data-peer-transfer]");
const text = () => strip()?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const click = (label: string) => act(async () => { button(label)!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

beforeEach(async () => {
  retries = 0;
  await setTransfer(undefined);
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<PeerTransferStrip conversationId={ID} onRetry={() => { retries++; }} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

test("nothing without a transfer, and nothing once it is done", async () => {
  expect(strip()).toBeNull();
  await setTransfer({ phase: "done", started_at: 1, updated_at: 2 });
  expect(strip()).toBeNull();
});

test("asking, then receiving with a mode chip and a determinate bar, then unpacking", async () => {
  await setTransfer({ phase: "asking", started_at: 1, updated_at: 1 });
  expect(text()).toContain("Asking your machines");
  expect(button("Cancel")).toBeTruthy();
  expect(document.querySelector("[role=progressbar]")).toBeNull();

  await setTransfer({ phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 5 * 1024 * 1024, total: 20 * 1024 * 1024, started_at: 1, updated_at: 2 });
  expect(text()).toContain("Receiving from MacBook-Pro-182");
  expect(text()).toContain("Direct");
  expect(text()).toContain("5.0 MB of 20.0 MB");
  expect(document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("25");

  await setTransfer({ phase: "unpacking", from: "MacBook-Pro-182", mode: "relay", total: 20 * 1024 * 1024, started_at: 1, updated_at: 3 });
  expect(text()).toContain("Unpacking");
  expect(text()).toContain("Relay");
  expect(document.querySelector("[role=progressbar]")).toBeNull();
});

test("Cancel paints cancelling at once and stamps the row", async () => {
  await setTransfer({ phase: "receiving", from: "Mac mini", mode: "relay", total: 1024, started_at: 1, updated_at: 2 });
  await click("Cancel");
  expect(strip()?.getAttribute("data-peer-transfer")).toBe("cancelling");
  expect(text()).toContain("Cancelling");
  expect(button("Cancel")).toBeUndefined();
  expect((useInboxStore.getState().conversations[ID] as any).peer_transfer.cancel_requested_at).toBeGreaterThan(0);
});

test("a failure names the reason and Try again restarts", async () => {
  await setTransfer({ phase: "failed", reason: "you cancelled the transfer", started_at: 1, updated_at: 2, cancel_requested_at: 2 });
  expect(text()).toContain("Folder not fetched");
  expect(text()).toContain("you cancelled the transfer");
  expect(button("Cancel")).toBeUndefined();
  await click("Try again");
  expect(retries).toBe(1);
});
