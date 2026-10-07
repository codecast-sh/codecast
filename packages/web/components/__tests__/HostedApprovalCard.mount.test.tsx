import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { DispatchNotWiredError } from "@platform/engine";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The answer's dispatch is the test's to settle: each pick hands back the next
// promise, so a refusal and a write still on its way can both be played.
let nextAnswer: () => Promise<unknown> = () => new Promise(() => {});
const picks: number[] = [];
const realAnswer = await import("../../hooks/useDecisionAnswer");
mock.module("../../hooks/useDecisionAnswer", () => ({
  ...realAnswer,
  useDecisionAnswer: () => ({
    question: "Start a weekly routine?",
    options: [
      { label: "Approve", description: "Start it. Runs every week until you pause it. You'll get it in your inbox, and as a notification when those are on.", index: 0 },
      { label: "Decline", index: 1 },
    ],
    answer: (index: number) => {
      picks.push(index);
      return nextAnswer();
    },
  }),
}));
const { createRoot } = await import("react-dom/client");
const { HostedApprovalCard, APPROVAL_REFUSED } = await import("../conversation/HostedApprovalCard");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const item = { key: "d1", source: "decide", conversationId: "c1", decisionId: "d1", question: "Start a weekly routine?", options: [], contextMd: "**What I'll do:** remind you every Monday." } as any;

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<HostedApprovalCard item={item} />); });
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  return { container, root, button };
}

test("what Yes does is said above both buttons, never after Not now", async () => {
  const { container, root } = await mount();
  const yesLine = container.querySelector("[data-hosted-approval-yes]")!;
  // A card asked before the yes stopped promising notifications reads as the new words.
  expect(yesLine.textContent).toBe("Start it. Runs every week until you pause it. Each run arrives in your inbox.");
  const firstButton = container.querySelector("button")!;
  expect(yesLine.compareDocumentPosition(firstButton) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  root.unmount();
});

test("a refused answer lets go of the buttons and says so in one line", async () => {
  picks.length = 0;
  nextAnswer = () => Promise.reject(new DispatchNotWiredError("answerDecision", false));
  const { container, root, button } = await mount();
  await act(async () => { button("Yes").click(); });
  expect(picks).toEqual([0]);
  expect(container.querySelector("[data-hosted-approval-refused]")?.textContent).toBe(APPROVAL_REFUSED);
  expect(button("Yes").disabled).toBe(false);
  // The second try clears the line while it is on its way.
  nextAnswer = () => new Promise(() => {});
  await act(async () => { button("Not now").click(); });
  expect(picks).toEqual([0, 1]);
  expect(container.querySelector("[data-hosted-approval-refused]")).toBeNull();
  expect(button("Yes").disabled).toBe(true);
  root.unmount();
});

test("an answer still on its way holds the buttons and says nothing", async () => {
  picks.length = 0;
  nextAnswer = () => Promise.reject(new DispatchNotWiredError("answerDecision", true));
  const { container, root, button } = await mount();
  await act(async () => { button("Yes").click(); });
  await act(async () => { button("Yes").click(); });
  expect(picks).toEqual([0]);
  expect(button("Yes").disabled).toBe(true);
  expect(container.querySelector("[data-hosted-approval-refused]")).toBeNull();
  root.unmount();
});
