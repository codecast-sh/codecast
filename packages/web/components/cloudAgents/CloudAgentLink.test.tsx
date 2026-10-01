import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { CLOUD_AGENT_PROVIDERS, cloudAgentChangedProblem, cloudAgentLimitProblem } from "@codecast/shared/contracts";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { CloudAgentActions } from "./sessionAgent";
import type { CloudAgentProblem } from "./machine";
import type { Device } from "../DeviceBadge";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const domClasses = Object.fromEntries(
  Object.getOwnPropertyNames(dom.window)
    .filter((k) => /^(HTML\w*Element|SVG\w*Element|\w*Event|Element|Node|NodeFilter|MutationObserver|DocumentFragment|Text|Range|Selection)$/.test(k))
    .map((k) => [k, (dom.window as any)[k]]),
);
const restoreGlobals = replaceGlobals({ ...domClasses, window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
// The note's popover is positioned by floating-ui, which observes its anchor.
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(dom.window as any).ResizeObserver = (globalThis as any).ResizeObserver;
// Loaded once the DOM is in place, as the browser would have it.
const { createRoot } = await import("react-dom/client");
const { CloudAgentLink, CloudAgentProblemDetail, useCloudAgentProblemText } = await import("./index");
const { cloudAgentMachineOf } = await import("./machine");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const codex = CLOUD_AGENT_PROVIDERS.codex;

function mount(problem?: CloudAgentProblem) {
  const actions = { cloud: { spec: codex, agentId: "task_e_1", launch: null, archived: false }, items: [], run: async () => {}, pending: null, palette: [], problem } as unknown as CloudAgentActions;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<CloudAgentLink actions={actions} />));
  return { host, unmount: () => act(() => { root.unmount(); host.remove(); }) };
}

/** The note's word beside the chip, or null for none. */
const word = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).find((b) => b.querySelector("[aria-label^='Why']"))?.textContent ?? null;

/** What a surface says for a problem (the note's popover, Settings, the composer). */
function said(problem: CloudAgentProblem, where: "settings" | "session" | "composer"): string {
  let text = "";
  function Probe() {
    text = useCloudAgentProblemText(codex, problem, where);
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return text;
}

test("a session whose machine syncs normally shows only its chip", () => {
  const { host, unmount } = mount();
  expect(word(host)).toBeNull();
  expect(host.textContent).toContain("Codex Cloud");
  unmount();
});

test("a paused lane says so beside the chip, and that messages wait; Settings adds nothing its sentence already says", () => {
  const sentence = `${cloudAgentChangedProblem(codex, "Mac")}.`;
  const problem: CloudAgentProblem = { kind: "changed", sentence, credential: false };
  const { host, unmount } = mount(problem);
  expect(word(host)).toBe("paused");
  unmount();
  expect(said(problem, "session")).toBe(`${sentence} Messages to it wait until codecast can read Codex Cloud again.`);
  expect(said(problem, "settings")).toBe(sentence);
});

test("a plan limit a send met holds messages only: no surface says syncing stopped, and each counts down to the reset", () => {
  const sentence = `${cloudAgentLimitProblem(codex, "the Week (7d) window of your ChatGPT Pro plan is used up")}.`;
  const problem: CloudAgentProblem = { kind: "limit", sentence, credential: false, resetsAt: Date.now() + 3 * 60 * 60_000, sendsOnly: true };
  const { host, unmount } = mount(problem);
  expect(word(host)).toBe("limited");
  unmount();
  expect(said(problem, "session")).toMatch(/Messages to it wait until the limit resets \(in [23]h.*, at .+\)\.$/);
  expect(said(problem, "settings")).toMatch(/New tasks and messages wait until the limit resets \(in [23]h/);
  for (const where of ["session", "settings", "composer"] as const) expect(said(problem, where)).not.toContain("Nothing syncs");
});

test("a limit a read met pauses syncing too, and every surface says so", () => {
  const sentence = `${cloudAgentLimitProblem(codex, "requests from Mac are rate limited (Too many requests)")}.`;
  const problem: CloudAgentProblem = { kind: "limit", sentence, credential: false };
  expect(said(problem, "settings")).toBe(`${sentence} Nothing syncs until the limit resets.`);
  expect(said(problem, "session")).toBe(`${sentence} Nothing syncs, and messages to it wait, until the limit resets.`);
});

test("a workspace that refuses the account stops everything until it lets the account in", () => {
  const problem: CloudAgentProblem = { kind: "access", sentence: "Codex Cloud is not enabled for you in this ChatGPT workspace (x).", credential: false };
  const { host, unmount } = mount(problem);
  expect(word(host)).toBe("no access");
  unmount();
  expect(said(problem, "settings")).toBe(`${problem.sentence} Nothing syncs until Codex Cloud lets this account in.`);
  expect(said(problem, "session")).toBe(`${problem.sentence} Nothing syncs, and messages to it wait, until Codex Cloud lets this account in.`);
});

test("a sign-in that ran out says so beside the chip, and its popover carries the connect control", () => {
  const problem: CloudAgentProblem = { kind: "key_invalid", sentence: "The Codex sign-in on Mac expired Oct 5.", credential: true };
  const { host, unmount } = mount(problem);
  expect(word(host)).toBe("not connected");
  unmount();
  const detail = document.createElement("div");
  const root = createRoot(detail);
  act(() => root.render(<CloudAgentProblemDetail spec={codex} problem={problem} where="session" deviceId="mine" />));
  expect(detail.textContent).toContain("Nothing syncs, and messages to it wait, until you connect Codex.");
  expect(Array.from(detail.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Connect Codex"]);
  act(() => root.unmount());
});

test("a session's header asks only about the computer of yours that drives it: never your own for a teammate's session", () => {
  const mine = { device_id: "mine", label: "My Mac", online: true, last_seen: 1, cloud_agent_blocks: [{ provider: "codex", kind: "access" }] } as unknown as Device;
  const roster = { byId: new Map([["mine", mine]]), mostRecentOnlineLocal: mine };
  // A teammate's computer is not in your roster: nothing to say about it.
  expect(cloudAgentMachineOf(roster, "theirs", "session")).toBeNull();
  expect(cloudAgentMachineOf(roster, undefined, "session")).toBeNull();
  expect(cloudAgentMachineOf(roster, "mine", "session")).toBe(mine);
  // Where you would connect (a dialog, the composer), your own stands in.
  expect(cloudAgentMachineOf(roster, "theirs", "picked")).toBe(mine);
});
