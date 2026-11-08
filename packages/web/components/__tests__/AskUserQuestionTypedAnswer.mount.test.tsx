import { afterAll, expect, test } from "bun:test";
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
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { AskUserQuestionBlock } = await import("../conversation/blocks/interactiveBlocks");
const { typedPollAnswerTexts } = await import("../../lib/pollPayload");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Session jx79zqj (2026-11-07): one free-text answer and one option pick, so the
// app declined the menu and typed both. Opened anywhere but the answering
// window, the card read "Closed without an answer" with nothing chosen.
const input = {
  questions: [
    {
      question: "What happens to that portal shortlist?",
      header: "Shortlist",
      options: [
        { label: "Remove it too (Recommended)", description: "Broker stops linking it." },
        { label: "Keep the page, drop links", description: "Page stays." },
      ],
    },
    {
      question: "How should I handle them?",
      header: "Overlap",
      options: [
        { label: "Tell them, I proceed (Recommended)", description: "Message both." },
        { label: "Wait for jx7969z first", description: "Hold edits." },
      ],
    },
  ],
};
const rejection = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const typed = "Shortlist: only suggest people actively engaged with us  ·  Overlap: Tell them, I proceed";

function render(result: { tool_use_id: string; content: string; typed_answer?: string }) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AskUserQuestionBlock tool={{ id: "ask1", name: "AskUserQuestion", input: JSON.stringify(input) }} result={result} />);
  });
  const text = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text;
}

test("a declined card shows the answers typed after it", () => {
  const [typed_answer] = Object.values(
    typedPollAnswerTexts([
      { role: "user", content: "", tool_results: [{ tool_use_id: "ask1", content: rejection }] },
      { role: "user", content: "[Request interrupted by user for tool use]" },
      { role: "user", content: typed },
    ])
  );
  const text = render({ tool_use_id: "ask1", content: rejection, typed_answer });
  expect(text).not.toContain("Closed without an answer");
  expect(text).toContain("only suggest people actively engaged with us");
});

test("a declined card with nothing typed after it still says so", () => {
  expect(render({ tool_use_id: "ask1", content: rejection })).toContain("Closed without an answer");
});
