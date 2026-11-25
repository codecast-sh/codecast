// ct-101497: a teammate (not the session's owner) answers an agent's open
// question. Their submit becomes a proposal to the owner, and the card then
// reset itself: open again, selections empty, still marked Needs you, so the
// person could not tell their answer was taken (replay rp-25556).
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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
const { AskUserQuestionBlock } = await import("../blocks/interactiveBlocks");
const { TeamProposalContext } = await import("../../../hooks/useTeamProposals");
const { ThemeContext } = await import("../../ThemeProvider");
const { useInboxStore } = await import("../../../store/inboxStore");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV = "jx7conversation0000000000000000";
const proposals: string[] = [];
// The real action paints an optimistic proposal row and dispatches to the
// server; paint the same row and never settle the round trip.
useInboxStore.setState({
  currentUser: { _id: "user_admin", name: "Sam Admin" } as any,
  proposeAnswer: ((conversationId: string, toolUseId: string, body: string, clientKey: string, authorName: string) => {
    proposals.push(body);
    useInboxStore.setState((s: any) => ({
      guestSuggestions: {
        ...s.guestSuggestions,
        [clientKey]: { _id: clientKey, client_key: clientKey, conversation_id: conversationId, author_user_id: "user_admin", guest_name: authorName, kind: "answer", tool_use_id: toolUseId, body: body.trim(), status: "pending", created_at: Date.now() },
      },
    }));
    return new Promise(() => {});
  }) as any,
} as any);

const input = {
  questions: [
    { question: "Should the page be gated?", header: "Access", options: [{ label: "Gate it (Recommended)", description: "Email gate." }, { label: "Leave it open", description: "Anyone with the link." }] },
    { question: "Who should get access?", header: "Audience", options: [{ label: "The team", description: "Members only." }, { label: "Everyone", description: "Public." }] },
  ],
};
const typedAnswer = "Gate it behind the team's email domain, and keep the README link pointing at the gated page for now";

test("a teammate's submitted answer does not come back as an unanswered Needs you card", () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const theme = { visualStyle: "modern" } as any;
  act(() => {
    root.render(
      <ThemeContext.Provider value={theme}>
        <TeamProposalContext.Provider value={{ conversationId: CONV, role: "teammate", ownerName: "Alex Owner" }}>
          <AskUserQuestionBlock tool={{ id: "ask_teammate_1", name: "AskUserQuestion", input: JSON.stringify(input) }} />
        </TeamProposalContext.Provider>
      </ThemeContext.Provider>,
    );
  });
  const buttons = () => Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
  const byText = (t: string) => buttons().find((b) => b.textContent?.includes(t));
  expect(host.querySelectorAll('[data-cc-ask="needs_you"]').length).toBe(2);

  // Question 1: an option. Question 2: an answer in their own words.
  act(() => { byText("Gate it")!.click(); });
  const field = host.querySelectorAll("input")[1] as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, typedAnswer);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  act(() => { field.form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  const submit = byText("Submit answers 2/2");
  expect(submit).toBeDefined();
  act(() => { submit!.click(); });

  // The answer was taken as a proposal to the owner...
  expect(proposals.length).toBe(1);
  // ...so the card must not reopen as an open question that still needs them,
  // with what they chose and wrote wiped.
  expect(byText("Submit answers 0/2")?.outerHTML ?? null).toBeNull();
  expect(host.querySelectorAll('[data-cc-ask="needs_you"]').length).toBe(0);

  act(() => root.unmount());
  host.remove();
});
