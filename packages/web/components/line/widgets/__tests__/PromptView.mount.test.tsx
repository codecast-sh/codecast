// Mounts PromptView (line-workspace.md LW3) in jsdom the way a step's
// Instructions tab does, and remounts it the way switching tabs or steps
// does (ct-101553): a section opened by hand is still open when the person
// comes back to the step, and "Open all" carries over to the next mount, so
// reading a step's instructions does not mean unfolding each section again.
import { afterAll, expect, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { PromptView } = await import("../PromptView");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const promptFor = (file: string) => ({
  kind: "prompt" as const,
  text: [
    "You own this problem until it is fixed in production.",
    "",
    "## Money",
    "Your own reasoning and subagents cost nothing that matters.",
    "",
    "## Facts",
    "The cause is filed as a task.",
    "",
    "## Task",
    "Show the miss before anyone fixes it.",
  ].join("\n"),
  readable: "",
  includes: [],
  file,
  version: null,
  versions: [],
});
const STEP_A = promptFor("line/fix/prove.md");
const STEP_B = promptFor("line/fix/analyze.md");

async function mount(prompt: ReturnType<typeof promptFor>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<PromptView prompt={prompt} />); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const sections = (host: HTMLElement) => [...host.querySelectorAll<HTMLDetailsElement>("details.lw-psec")];
const openTitles = (host: HTMLElement) => sections(host).filter((d) => d.open).map((d) => d.querySelector("summary b")?.textContent);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function openByHand(host: HTMLElement, title: string) {
  const d = sections(host).find((x) => x.querySelector("summary b")?.textContent === title)!;
  await act(async () => { d.querySelector("summary")!.click(); });
  await settle();
  // jsdom may not run the summary's activation; open it the way the browser would.
  if (!d.open) await act(async () => { d.open = true; d.dispatchEvent(new dom.window.Event("toggle")); });
  await settle();
  expect(d.open).toBe(true);
}

test("a section opened by hand is still open after switching away and back", async () => {
  let m = await mount(STEP_A);
  expect(openTitles(m.host)).toEqual([]);
  await openByHand(m.host, "Money");
  await openByHand(m.host, "Task");
  m.unmount();

  m = await mount(STEP_A);
  expect(openTitles(m.host)).toEqual(["Money", "Task"]);
  m.unmount();
});

test("Open all carries over to the next mount, and to another step", async () => {
  let m = await mount(STEP_A);
  const button = [...m.host.querySelectorAll("button")].find((b) => b.textContent === "Open all")!;
  await act(async () => { button.click(); });
  expect(openTitles(m.host)).toEqual(["Role", "Money", "Facts", "Task"]);
  m.unmount();

  m = await mount(STEP_A);
  expect(openTitles(m.host)).toEqual(["Role", "Money", "Facts", "Task"]);
  m.unmount();

  m = await mount(STEP_B);
  expect(openTitles(m.host)).toEqual(["Role", "Money", "Facts", "Task"]);
  m.unmount();
});
