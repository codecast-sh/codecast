import { replaceGlobals } from "../test-helpers/globals";
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionModeToggles } from "./SessionModeToggles";
import type { SessionMachine } from "../lib/sessionMachines";

import { closeDomWindow } from "../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const cloud: SessionMachine = { device_id: "cloud", label: "Linux - ip-172-31-40-243", platform: "linux", online: false, is_remote: true, last_seen: 0, local_project_roots: [] };

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}
const buttons = (host: HTMLElement) => Array.from(host.querySelectorAll("button"));
const byText = (host: HTMLElement, text: string) => buttons(host).find((b) => b.textContent?.includes(text))!;
const click = (el: Element) => act(() => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

test("cloud mode on: violet label; the isolated toggle is the workspace pick and never writes the local flag", () => {
  let cloudToggles = 0;
  let isolatedToggles = 0;
  let sharedToggles = 0;
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode cloudToggleEnabled onToggleCloud={() => { cloudToggles++; }} isolated onToggleIsolated={() => { isolatedToggles++; }} shared={false} onToggleShared={() => { sharedToggles++; }} />,
  );
  const cloudBtn = byText(host, "run in the cloud");
  expect(cloudBtn.innerHTML).toContain("text-sol-violet");
  expect(cloudBtn.getAttribute("title")).toContain("turn off 'isolated worktree' to use the host's main checkout");
  const isolatedBtn = byText(host, "isolated worktree");
  expect(isolatedBtn.disabled).toBe(false);
  expect(isolatedBtn.getAttribute("title")).toBe("Own worktree on the host (default)");
  click(isolatedBtn);
  expect(isolatedToggles).toBe(0);
  expect(sharedToggles).toBe(1);
  click(cloudBtn);
  expect(cloudToggles).toBe(1);
  unmount();
});

test("cloud mode with the shared checkout picked: the toggle reads off and explains the refusals", () => {
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode cloudToggleEnabled onToggleCloud={() => {}} isolated={false} onToggleIsolated={() => {}} shared onToggleShared={() => {}} />,
  );
  const isolatedBtn = byText(host, "isolated worktree");
  expect(isolatedBtn.innerHTML).not.toContain("text-sol-cyan\"");
  expect(isolatedBtn.getAttribute("title")).toBe("Runs in the host's main checkout — refused if it is dirty or another session is using it");
  unmount();
});

test("cloud mode off: the isolated toggle acts and the cloud label is plain", () => {
  let isolatedToggles = 0;
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode={false} cloudToggleEnabled onToggleCloud={() => {}} isolated={false} onToggleIsolated={() => { isolatedToggles++; }} />,
  );
  expect(byText(host, "run in the cloud").innerHTML).not.toContain("text-sol-violet");
  const isolatedBtn = byText(host, "isolated worktree");
  expect(isolatedBtn.disabled).toBe(false);
  click(isolatedBtn);
  expect(isolatedToggles).toBe(1);
  unmount();
});

test("a cloud-only roster disables the toggle and says why", () => {
  let cloudToggles = 0;
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode cloudToggleEnabled={false} onToggleCloud={() => { cloudToggles++; }} isolated onToggleIsolated={() => {}} />,
  );
  const cloudBtn = byText(host, "run in the cloud");
  expect(cloudBtn.disabled).toBe(true);
  expect(cloudBtn.getAttribute("title")).toContain("only machine");
  click(cloudBtn);
  expect(cloudToggles).toBe(0);
  unmount();
});

test("no cloud host: only the isolated toggle renders", () => {
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={null} cloudMode={false} cloudToggleEnabled={false} onToggleCloud={() => {}} isolated={false} onToggleIsolated={() => {}} />,
  );
  expect(buttons(host)).toHaveLength(1);
  unmount();
});

test("cloud mode shows the 'start from' pick: my checkout by default, origin/main on click; the shared checkout pins it at origin/main (ct-49433)", () => {
  const picks: string[] = [];
  const { host, unmount } = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode cloudToggleEnabled onToggleCloud={() => {}} isolated onToggleIsolated={() => {}} shared={false} onToggleShared={() => {}} startFrom="checkout" onSetStartFrom={(v) => { picks.push(v); }} />,
  );
  const mine = byText(host, "my checkout");
  const origin = byText(host, "origin/main");
  expect(mine.getAttribute("aria-checked")).toBe("true");
  expect(origin.getAttribute("aria-checked")).toBe("false");
  expect(mine.getAttribute("title")).toContain("uncommitted changes");
  click(origin);
  expect(picks).toEqual(["origin_main"]);
  click(mine); // already active: no pick
  expect(picks).toEqual(["origin_main"]);
  unmount();

  const shared = mount(
    <SessionModeToggles cloudHost={cloud} cloudMode cloudToggleEnabled onToggleCloud={() => {}} isolated={false} onToggleIsolated={() => {}} shared onToggleShared={() => {}} startFrom="checkout" onSetStartFrom={(v) => { picks.push(v); }} />,
  );
  expect(byText(shared.host, "origin/main").getAttribute("aria-checked")).toBe("true");
  expect(byText(shared.host, "my checkout").disabled).toBe(true);
  click(byText(shared.host, "my checkout"));
  expect(picks).toEqual(["origin_main"]);
  shared.unmount();

  const off = mount(<SessionModeToggles cloudHost={cloud} cloudMode={false} cloudToggleEnabled onToggleCloud={() => {}} isolated={false} onToggleIsolated={() => {}} />);
  expect(buttons(off.host).some((b) => b.textContent?.includes("my checkout"))).toBe(false);
  off.unmount();
});
