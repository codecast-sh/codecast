// The composer's tray with a mixed batch (org-staffing.md S39): answers to a
// proposal's cards first, grouped by proposal and worded as the reply being
// built, then the quotes; the head counts both in words; Edit in input shows
// only with quotes; a row's cross withdraws what it stands for.
// Run through components/__tests__/reviewBarAnswers.mount.test.ts.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { useInboxStore } from "../../../store/inboxStore";
import { PendingBatchRows, ReviewBar, batchHeadWords } from "../../ReviewBar";
import { ReviewComposerContext } from "../../reviewContext";
import { answerProposalCard } from "../../../lib/reviewActions";
import type { PendingComment } from "../../../lib/quoteFormat";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
afterAll(() => { dom.window.close(); restore(); });

const P = { id: "p-1", short_id: "op-55", title: "Rank Union's projects by the goals they carry" };
const card = (key: string, seqs: number[], sentence: string, ordinal?: number) => ({ proposal: P, key, change_ids: seqs.map((n) => `ch-${n}`), seqs, sentence, ordinal });
const quote = (id: string, body: string): PendingComment => ({ id, messageId: "m1", blockIndex: 1, quote: `Quoted ${id}`, body, createdAt: 1 });
// Spans sit side by side with a CSS gap, so read each element's own text, joined by one space.
const textNodes = (n: Node): string[] => n.nodeType === 3 ? [n.textContent ?? ""] : Array.from(n.childNodes).flatMap(textNodes);
const words = (el: Element) => textNodes(el).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
const texts = (host: HTMLElement, sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel), (el) => el.children.length ? words(el) : el.textContent?.replace(/\s+/g, " ").trim());

test("the tray reads like the reply being built", async () => {
  useInboxStore.setState({ reviewComments: { c1: [quote("q1", "tighten this")] } });
  answerProposalCard("c1", card("project:a", [1], "Make Matching Engine a high priority.", 1), { verdict: "approve" });
  answerProposalCard("c1", card("project:b", [2], "Make Funnel a high priority.", 2), { verdict: "reject", text: "P1 not P0" });
  answerProposalCard("c1", card("project:c", [3], "Make Callers a medium priority.", 3), { verdict: "approve" });
  answerProposalCard("c1", card("project:d", [4, 5], "Move Billing under Revenue and have Ops carry it.", 4), { verdict: "approve" });
  answerProposalCard("c1", card("project:e", [6], "Make Callers & Call Management a medium priority.", 6), { verdict: "note", text: "Cameron owns this" });
  answerProposalCard("c1", card("project:f", [7], "Retire the Growth plan.", 7), { verdict: "approve", text: "but revisit in a month" });
  answerProposalCard("c1", card("", [], ""), { verdict: "note", text: "do the same for the plans next" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const jumps: string[] = [];
  const submits: string[] = [];
  try {
    await act(() => root.render(<ReviewComposerContext.Provider value={{ quote() {}, submit() { submits.push("submit"); }, jumpToComment: (c) => jumps.push(c.id) }}><ReviewBar conversationId="c1" /></ReviewComposerContext.Provider>));
    expect(batchHeadWords(useInboxStore.getState().reviewComments.c1!)).toBe("7 answers and 1 quote");
    expect(words(host.querySelector(".cc-review-tray-title")!)).toBe("7 answers and 1 quote on your next message");
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Rank Union's projects by the goals they carry"]);
    // Bare approvals fold into one row, in card order; each other answer is its own row with its sentence and words; the quote comes last.
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Approve 1, 3 and 4", "Reject 2", "On 6", "Approve 7", "On all of it"]);
    expect(texts(host, ".cc-review-tray-item")).toEqual([
      "Approve 1, 3 and 4",
      "Reject 2 Make Funnel a high priority. P1 not P0",
      "On 6 Make Callers & Call Management a medium priority. Cameron owns this",
      "Approve 7 Retire the Growth plan. but revisit in a month",
      "On all of it do the same for the plans next",
      "❝ Quoted q1 tighten this",
    ]);
    expect(Array.from(host.querySelectorAll<HTMLElement>(".cc-review-tray-verdict"), (el) => el.dataset.verdict)).toEqual(["approve", "reject", "note", "approve", "note"]);
    // An answer has no passage to jump to: its row is inert; the quote's row still jumps.
    const jumpButtons = host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-jump");
    expect(Array.from(jumpButtons, (b) => b.disabled)).toEqual([true, true, true, true, true, false]);
    await act(() => jumpButtons[5].click());
    expect(jumps).toEqual(["q1"]);
    // Edit in input shows while a quote is in the batch, and hands off to the composer.
    const edit = Array.from(host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-actions button")).find((b) => b.textContent?.includes("Edit in input"))!;
    await act(() => edit.click());
    expect(submits).toEqual(["submit"]);
    // The folded row's cross withdraws all three approvals and nothing else.
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Withdraw this answer"]')!.click());
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Reject 2", "On 6", "Approve 7", "On all of it"]);
    expect(useInboxStore.getState().reviewComments.c1!.filter((c) => c.proposal).map((c) => c.proposal!.verdict)).toEqual(["reject", "note", "approve", "note"]);
    // With the quote gone, Edit in input goes too; the head speaks of answers only.
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove this quote"]')!.click());
    expect(words(host.querySelector(".cc-review-tray-title")!)).toBe("4 answers on your next message");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-actions button")).map((b) => b.textContent?.trim())).toEqual(["Clear"]);
    // Cards the list does not number read as a count.
    await act(() => {
      useInboxStore.setState({ reviewComments: {} });
      answerProposalCard("c1", card("project:a", [1], "A."), { verdict: "approve" });
      answerProposalCard("c1", card("project:b", [2], "B."), { verdict: "approve" });
      answerProposalCard("c1", card("project:c", [3], "C."), { verdict: "reject" });
    });
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Approve 2 changes", "Reject"]);
    expect(texts(host, ".cc-review-tray-item")[1]).toBe("Reject C.");
    // One unnumbered card (a closed ask) is named by its sentence, never counted.
    await act(() => {
      useInboxStore.setState({ reviewComments: {} });
      answerProposalCard("c1", card("ask:1", [1, 2], "Staff the funnel"), { verdict: "approve" });
    });
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Approve"]);
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Approve Staff the funnel"]);
  } finally { await act(() => root.unmount()); host.remove(); }
}, 60_000);

test("a reply box's rows are one proposal's, on a thread key two proposals share", async () => {
  const P2 = { id: "p-2", short_id: "op-56", title: "Close the Growth plan" };
  useInboxStore.setState({ reviewComments: { t1: [quote("q1", "tighten this")] } });
  answerProposalCard("t1", card("project:a", [1], "A.", 1), { verdict: "approve" });
  answerProposalCard("t1", { ...card("plan:g", [1], "Retire the Growth plan.", 1), proposal: P2 }, { verdict: "reject", text: "keep it" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<PendingBatchRows batchKey="t1" proposalId="p-2" />));
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Close the Growth plan"]);
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Reject 1 Retire the Growth plan. keep it"]);
    // Without the filter the same key shows both proposals and the quote.
    await act(() => root.render(<PendingBatchRows batchKey="t1" />));
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Rank Union's projects by the goals they carry", "Close the Growth plan"]);
    expect(texts(host, ".cc-review-tray-item")).toHaveLength(3);
  } finally { await act(() => root.unmount()); host.remove(); }
}, 60_000);
