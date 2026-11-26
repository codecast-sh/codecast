// The Ship bar of a personal run that stopped at Landing unknown or Land cut off leads with Resume at Land: the press
// asks the server to resume the run at Land (convex failedRunResume.resume), reads Resuming… while it does, and a
// refusal says the server's own words under it. Every other stop offers no Resume. Convex is faked; the runs are the
// real runner's recorded reports (lib/ship/__tests__/replayReports.ts).
// Run: cd packages/web && bun test components/ship/Journey.resume.mount.test.tsx
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/conversation/c1" });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), DocumentFragment: dom.window.DocumentFragment, KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent, NodeFilter: dom.window.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const calls: { name: string; args: any }[] = [];
let answer: (args: any) => Promise<unknown> = async () => ({});
const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useMutation: (ref: any) => (args: any) => (calls.push({ name: getFunctionName(ref), args }), answer(args)) }));
mock.module("next/link", () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }));

const { JourneyView } = await import("./Journey");
const { journeyOf } = await import("../../lib/ship/journey");
const { appPool, flowBySlug } = await import("../../lib/line/flowPool");
const { end, replay } = await import("../../lib/ship/__tests__/replayReports");
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
beforeEach(() => { calls.length = 0; answer = async () => ({}); });

const personal = flowBySlug(appPool(), "personal") as any;
const UNKNOWN = "r7 #3: a push whose answer is lost while origin cannot be read stops at Landing unknown, never Not landed (run 1)";
const UNKNOWN_CUT = "r8c #3: a Land its station cuts off after it set out to push ends Landing unknown";
const CUT = "r8f: a Land its station cuts off during the catch-up says the change landed, and resuming it finishes and deploys (run 1)";

async function mount(scenario: string) {
  const run = { ...end(replay(scenario)), _id: "run_1", workspace: "user:u1" } as any;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<JourneyView journey={journeyOf(personal, run)} run={run} now_ms={Date.now()} />));
  return { container, press: () => container.querySelector("[data-journey-resume]") as HTMLButtonElement | null, unmount: () => act(() => root.unmount()) };
}
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); });
// The press opens its review (resumeLedger); only the review's confirm resumes the run.
const confirm = () => click(document.body.querySelector("[data-switch-confirm]"));

describe("Resume at Land on the Ship bar", () => {
  test("each stop that says to resume leads with Resume at Land, which resumes the run at Land and reads Resuming…", async () => {
    for (const scenario of [UNKNOWN, UNKNOWN_CUT, CUT]) {
      calls.length = 0;
      answer = () => new Promise(() => {});
      const m = await mount(scenario);
      const press = m.press()!;
      expect([press.textContent, press.hasAttribute("data-primary")]).toEqual(["Resume at Land", true]);
      // Opening the run follows it, no longer the lead.
      expect(m.container.querySelector("[data-journey-open-run]")!.hasAttribute("data-primary")).toBe(false);
      await click(press);
      // One press only opens the review, which says what resuming may do: nothing is resumed yet.
      expect(calls).toEqual([]);
      expect(document.body.querySelector("[data-switch-review]")!.textContent).toContain("Pushes it to main, then deploys");
      await confirm();
      expect(calls).toEqual([{ name: "failedRunResume:resume", args: { run_id: "run_1", at: "land" } }]);
      expect([m.press()!.textContent, m.press()!.disabled]).toEqual(["Resuming…", true]);
      // A second press while it is pending sends nothing more.
      await click(m.press());
      expect(calls.length).toBe(1);
      await m.unmount();
    }
  });

  test("a refusal says the server's own words, and the press can be tried again", async () => {
    answer = async () => { throw new ConvexError("Only the run's owner resumes it"); };
    const m = await mount(UNKNOWN);
    await click(m.press());
    await confirm();
    expect(m.container.querySelector("[data-journey-resume-refused]")!.textContent).toBe("Could not resume: Only the run's owner resumes it");
    expect([m.press()!.textContent, m.press()!.disabled]).toEqual(["Resume at Land", false]);
    await m.unmount();
  });

  test("backing out of the review resumes nothing", async () => {
    const m = await mount(UNKNOWN);
    await click(m.press());
    await click(document.body.querySelector("[data-switch-cancel]"));
    expect(calls).toEqual([]);
    expect(document.body.querySelector("[data-switch-review]")).toBeNull();
    await m.unmount();
  });

  test("a stop that does not say to resume offers no Resume", async () => {
    for (const scenario of ["a remote that refuses the push", "a push whose landing could not be recorded", "origin that cannot be read before Deploy stops the run"]) {
      const m = await mount(scenario);
      expect(m.press()).toBeNull();
      expect(m.container.querySelector("[data-journey-open-run]")!.hasAttribute("data-primary")).toBe(true);
      await m.unmount();
    }
  });
});
