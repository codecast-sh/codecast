import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const realDeviceBadge = await import("../DeviceBadge");
mock.module("../DeviceBadge", () => ({ ...realDeviceBadge, useDevices: () => ({ devices: [] }) }));
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { SessionErrorBanner } = await import("../SessionErrorBanner");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const MiB = 1048576;

test("a cloud placement over the context cap asks to leave the named files out, and the answer carries their paths", async () => {
  const files = [
    { path: "src/app/renders/c00.mp4", bytes: 41 * MiB },
    { path: "src/app/renders/c03.mp4", bytes: 36 * MiB },
  ];
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, conv1: { _id: "conv1", cloud_context_too_large: { total_bytes: 800 * MiB, cap_bytes: 768 * MiB, files } } } }));
  const calls: any[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionErrorBanner error="cloud host preparation failed (exit 1): project context is 800 MiB" sessionId="conv1" onResume={(extra) => calls.push(extra)} />);
  });
  expect(container.textContent).toContain("over the 768 MiB a cloud host takes");
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["~/src/app/renders/c00.mp441 MiB", "~/src/app/renders/c03.mp436 MiB"]);
  const leave = [...container.querySelectorAll("button")].find((b) => b.textContent === "Leave out and start")!;
  await act(async () => { leave.click(); });
  expect(calls).toEqual([{ leave_out: ["src/app/renders/c00.mp4", "src/app/renders/c03.mp4"] }]);
  root.unmount();
});

test("any other error keeps its text and a plain Resume", async () => {
  const calls: any[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionErrorBanner error="No local checkout" sessionId="missing" onResume={(extra) => calls.push(extra)} />);
  });
  expect(container.textContent).toContain("No local checkout");
  const resume = [...container.querySelectorAll("button")].find((b) => b.textContent === "Resume")!;
  await act(async () => { resume.click(); });
  expect(calls).toEqual([undefined]);
  root.unmount();
});
