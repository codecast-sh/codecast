import { replaceGlobals } from "../test-helpers/globals";
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MachineChips } from "./MachineChips";
import { machineChipTitle, type SessionMachine } from "../lib/sessionMachines";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

const laptop: SessionMachine = { device_id: "laptop", label: "macOS - MacBook", platform: "darwin", online: true, is_remote: false, last_seen: 1, local_project_roots: [] };
const cloud: SessionMachine = { device_id: "cloud", label: "Linux - ip-172-31-40-243", platform: "linux", online: false, is_remote: true, last_seen: 0, local_project_roots: [] };

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("clicking the Cloud Linux chip hands that machine to onPick", () => {
  const picks: SessionMachine[] = [];
  const { host, unmount } = mount(
    <MachineChips machines={[laptop, cloud]} selectedDeviceId="laptop" open onOpen={() => {}} onPick={(d) => picks.push(d)} />,
  );
  const chip = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Cloud Linux"));
  expect(chip).toBeDefined();
  act(() => chip!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  expect(picks).toEqual([cloud]);
  unmount();
});

test("a sleeping cloud host says it boots on start, not that it falls back", () => {
  expect(machineChipTitle(cloud)).toContain("asleep");
  expect(machineChipTitle(cloud)).not.toContain("fall back");
  expect(machineChipTitle({ ...laptop, online: false })).toContain("fall back");
  const { host, unmount } = mount(
    <MachineChips machines={[laptop, cloud]} selectedDeviceId="cloud" open onOpen={() => {}} onPick={() => {}} />,
  );
  const chip = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Cloud Linux"));
  expect(chip?.getAttribute("title")).toContain("asleep");
  unmount();
});

test("collapsed, the pill names the routed machine and opens on click", () => {
  let opened = 0;
  const { host, unmount } = mount(
    <MachineChips machines={[laptop, cloud]} selectedDeviceId="cloud" open={false} onOpen={() => { opened++; }} onPick={() => {}} />,
  );
  const pill = host.querySelector("button")!;
  expect(pill.textContent).toContain("Cloud Linux");
  act(() => pill.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  expect(opened).toBe(1);
  unmount();
});

test("a single machine renders nothing", () => {
  const { host, unmount } = mount(
    <MachineChips machines={[laptop]} selectedDeviceId="laptop" open onOpen={() => {}} onPick={() => {}} />,
  );
  expect(host.innerHTML).toBe("");
  unmount();
});
