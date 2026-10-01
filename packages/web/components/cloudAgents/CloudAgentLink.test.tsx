import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CLOUD_AGENT_PROVIDERS, cloudAgentChangedProblem, cloudAgentLimitProblem } from "@codecast/shared/contracts";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { CloudAgentLink, useCloudAgentProblemText } from "./index";
import type { CloudAgentActions } from "./sessionAgent";
import type { CloudAgentProblem } from "./machine";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
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

test("a plan limit holds messages only: no surface says syncing stopped, and each counts down to the reset", () => {
  const sentence = `${cloudAgentLimitProblem(codex, "the Week (7d) window of your ChatGPT Pro plan is used up")}.`;
  const problem: CloudAgentProblem = { kind: "limit", sentence, credential: false, resetsAt: Date.now() + 3 * 60 * 60_000 };
  const { host, unmount } = mount(problem);
  expect(word(host)).toBe("limited");
  unmount();
  expect(said(problem, "session")).toMatch(/Messages to it wait until the limit resets \(in [23]h/);
  expect(said(problem, "settings")).toMatch(/New tasks and messages wait until the limit resets \(in [23]h/);
  for (const where of ["session", "settings", "composer"] as const) expect(said(problem, where)).not.toContain("Nothing syncs");
});

test("a workspace that refuses the account stops everything until it is fixed", () => {
  const problem: CloudAgentProblem = { kind: "access", sentence: "Codex Cloud is not enabled for you in this ChatGPT workspace (x).", credential: false };
  expect(said(problem, "settings")).toBe(`${problem.sentence} Nothing syncs until this is fixed.`);
  expect(said(problem, "session")).toBe(`${problem.sentence} Nothing syncs, and messages to it wait, until this is fixed.`);
});
