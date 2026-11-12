// The folder-transfer strip in the conversation header: each phase reads off
// the conversation row in the store, Cancel paints "Cancelling" at once and
// holds it through daemon reports, a failed or stalled row offers Try again
// and Dismiss, and a finished transfer synced as null takes the strip away.
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

const { PeerTransferStrip } = await import("../PeerTransferStrip");
const { PEER_TRANSFER_STALE_MS } = await import("../../../lib/peerTransfer");
const { useInboxStore } = await import("../../../store/inboxStore");
const { flushSyncPublishes } = await import("../../../store/syncTransaction");

const ID = "conv_1";
let root: Root;
let retries = 0;
const setTransfer = (peer_transfer: Record<string, unknown> | undefined) =>
  act(async () => { useInboxStore.setState({ conversations: { [ID]: { _id: ID, peer_transfer } }, peerTransferCancels: {} } as any); });
const syncMeta = (peer_transfer: Record<string, unknown> | null) =>
  act(async () => {
    useInboxStore.getState().syncRecord("conversations", ID, { _id: ID, peer_transfer });
    flushSyncPublishes();
  });
const NOW = Date.now();
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
  await setTransfer({ phase: "done", started_at: NOW, updated_at: NOW });
  expect(strip()).toBeNull();
});

test("asking, then receiving with a mode chip and a determinate bar, then unpacking", async () => {
  await setTransfer({ phase: "asking", started_at: NOW, updated_at: NOW });
  expect(text()).toContain("Asking your machines");
  expect(button("Cancel")).toBeTruthy();
  expect(document.querySelector("[role=progressbar]")).toBeNull();

  await setTransfer({ phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 5 * 1024 * 1024, total: 20 * 1024 * 1024, started_at: NOW, updated_at: NOW });
  expect(text()).toContain("Receiving from MacBook-Pro-182");
  expect(text()).toContain("Direct");
  expect(text()).toContain("5.0 MB of 20.0 MB");
  expect(document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("25");

  await setTransfer({ phase: "unpacking", from: "MacBook-Pro-182", mode: "relay", total: 20 * 1024 * 1024, started_at: NOW, updated_at: NOW });
  expect(text()).toContain("Unpacking");
  expect(text()).toContain("Relay");
  expect(document.querySelector("[role=progressbar]")).toBeNull();
});

test("Cancel paints cancelling at once and holds it through a daemon report without the stamp", async () => {
  await setTransfer({ phase: "receiving", from: "Mac mini", mode: "relay", total: 1024, started_at: NOW, updated_at: NOW });
  await click("Cancel");
  expect(strip()?.getAttribute("data-peer-transfer")).toBe("cancelling");
  expect(text()).toContain("Cancelling");
  expect(button("Cancel")).toBeUndefined();
  await syncMeta({ phase: "receiving", from: "Mac mini", mode: "relay", bytes: 512, total: 1024, started_at: NOW, updated_at: NOW + 1000 });
  expect(strip()?.getAttribute("data-peer-transfer")).toBe("cancelling");
  await syncMeta({ phase: "asking", started_at: NOW + 5000, updated_at: NOW + 5000 });
  expect(button("Cancel")).toBeTruthy();
});

test("a finished transfer synced as null takes the strip away", async () => {
  await syncMeta({ phase: "unpacking", from: "Mac mini", mode: "direct", started_at: NOW, updated_at: NOW });
  expect(text()).toContain("Unpacking");
  await syncMeta(null);
  expect(strip()).toBeNull();
});

test("a row its daemon stopped updating reads as stopped, with Try again and Dismiss instead of Cancel", async () => {
  const old = Date.now() - PEER_TRANSFER_STALE_MS - 1000;
  await setTransfer({ phase: "receiving", from: "Mac mini", mode: "direct", bytes: 1, total: 10, started_at: old, updated_at: old });
  expect(strip()?.getAttribute("data-peer-transfer")).toBe("stalled");
  expect(text()).toContain("Transfer stopped");
  expect(button("Cancel")).toBeUndefined();
  expect(document.querySelector("[role=progressbar]")).toBeNull();
  await click("Dismiss");
  expect(strip()).toBeNull();
  expect(retries).toBe(0);
});

test("a failure names the reason and Try again restarts", async () => {
  await setTransfer({ phase: "failed", reason: "you cancelled the transfer", started_at: NOW, updated_at: NOW, cancel_requested_at: 2 });
  expect(text()).toContain("Fetch failed");
  expect(text()).toContain("you cancelled the transfer");
  expect(button("Cancel")).toBeUndefined();
  await click("Try again");
  expect(retries).toBe(1);
  expect(strip()).toBeNull();
});
