import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";

// An option's meaning renders under its label, inside the row that answers
// it: the reader never matches a pill to a description printed elsewhere.
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

import { DecisionAnswerControls } from "../DecisionAnswerControls";
import { DecisionOptionList } from "../DecisionOptionList";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { dom.window.close(); restoreGlobals(); });

const options = [
  { label: "Gate the runs (Recommended)", description: "a machine wide semaphore; queued runs wait" },
  { label: "Leave the load", description: "commands stay slow when the box is saturated", cost: "nothing", risk: "flaky runs" },
  { label: "Relaunch Chrome" },
];

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("each row carries its label and its meaning once, and the row answers", async () => {
  const picked: number[] = [];
  const { container, unmount } = await mount(<DecisionOptionList options={options} keys onPick={(n) => picked.push(n)} compact />);
  const rows = Array.from(container.querySelectorAll("[data-option]"));
  expect(rows.map((r) => r.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
  expect(rows[0].textContent).toContain("Gate the runs");
  expect(rows[0].textContent).not.toContain("(Recommended)");
  expect(rows[0].textContent).toContain("queued runs wait");
  // Cost and risk sit in the row when the option carries them.
  expect(rows[1].textContent).toContain("cost nothing");
  expect(rows[1].textContent).toContain("risk flaky runs");
  // No description is printed anywhere but its row.
  expect(container.textContent!.split("queued runs wait").length).toBe(2);
  // The digit renders as a key cap when the keys are live.
  expect(rows[2].querySelector("kbd")!.textContent).toBe("3");
  await act(() => { (rows[1] as HTMLElement).click(); });
  expect(picked).toEqual([1]);
  unmount();
});

test("without a pick handler the rows are plain and the number is a badge", async () => {
  const { container, unmount } = await mount(<DecisionOptionList options={options} />);
  const rows = Array.from(container.querySelectorAll("[data-option]"));
  expect(rows.map((r) => r.tagName)).toEqual(["DIV", "DIV", "DIV"]);
  expect(container.querySelector("kbd")).toBeNull();
  expect(rows[0].textContent).toContain("1");
  unmount();
});

test("the single answer controls render the rows and a typed answer line, not a pill per option", async () => {
  const answers: any[] = [];
  const decision: any = { _id: "d1", options, kind: "single", status: "pending", blocking: false, default_option: 1 };
  const { container, unmount } = await mount(<DecisionAnswerControls decision={decision} onAnswer={(a) => answers.push(a)} keys recommendation={0} size="compact" />);
  const rows = Array.from(container.querySelectorAll("[data-option]"));
  expect(rows.length).toBe(3);
  expect(rows[0].textContent).toContain("recommended");
  expect(rows[1].textContent).toContain("proceeding with this");
  expect(container.textContent).toContain("type an answer");
  await act(() => { (rows[2] as HTMLElement).click(); });
  expect(answers).toEqual([{ index: 2 }]);
  unmount();
});

test("the queue card and the document page have no option list of their own", () => {
  const web = join(import.meta.dir, "..", "..");
  const card = readFileSync(join(web, "SessionDecisionCard.tsx"), "utf8");
  const doc = readFileSync(join(web, "decisions", "DecisionDocument.tsx"), "utf8");
  expect(card).toContain("<DecisionOptionList");
  expect(card).not.toContain("→");
  expect(doc).toContain("<DecisionOptionList");
  expect(doc).not.toMatch(/decision\.options\.map\(\(o, i\)/);
});
