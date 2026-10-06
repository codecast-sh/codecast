// The composer's tray with a mixed batch (org-staffing.md S39): the head is
// one sentence about the next send (batchSendWords); answers to a proposal's
// cards come first, grouped by proposal, bare approvals folded into one row
// named by their subjects, every other answer its own row; then the quotes.
// Edit in input shows only with quotes; a row's x undoes what it stands for;
// a row's click scrolls to its entry on the card and flashes it.
// Run through components/__tests__/reviewBarAnswers.mount.test.ts.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { useInboxStore } from "../../../store/inboxStore";
import { PendingBatchRows, ReviewBar } from "../../ReviewBar";
import { ReviewComposerContext } from "../../reviewContext";
import { answerProposalCard, batchSendWords } from "../../../lib/reviewActions";
import type { PendingComment } from "../../../lib/quoteFormat";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
afterAll(() => { dom.window.close(); restore(); });

const P = { id: "p-1", short_id: "op-55", title: "Rank Union's projects by the goals they carry" };
const card = (key: string, seqs: number[], sentence: string, subject?: string) => ({ proposal: P, key, change_ids: seqs.map((n) => `ch-${n}`), seqs, sentence, ...(subject ? { subject } : {}) });
const quote = (id: string, body: string): PendingComment => ({ id, messageId: "m1", blockIndex: 1, quote: `Quoted ${id}`, body, createdAt: 1 });
// Spans sit side by side with a CSS gap, so read each element's own text, joined by one space.
const textNodes = (n: Node): string[] => n.nodeType === 3 ? [n.textContent ?? ""] : Array.from(n.childNodes).flatMap(textNodes);
const words = (el: Element) => textNodes(el).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
const texts = (host: HTMLElement, sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel), (el) => el.children.length ? words(el) : el.textContent?.replace(/\s+/g, " ").trim());

test("the tray reads like the send being built", async () => {
  useInboxStore.setState({ reviewComments: { c1: [quote("q1", "tighten this")] } });
  answerProposalCard("c1", card("project:a", [1], "Make Matching Engine a high priority.", "Matching Engine & Funnel"), { verdict: "approve" });
  answerProposalCard("c1", card("project:b", [2], "Make Funnel a high priority.", "Funnel"), { verdict: "reject", text: "P1 not P0" });
  answerProposalCard("c1", card("project:c", [3], "Make Callers a medium priority.", "Callers & Call Management"), { verdict: "approve" });
  answerProposalCard("c1", card("project:d", [4, 5], "Move Billing under Revenue and have Ops carry it.", "Infrastructure"), { verdict: "approve" });
  answerProposalCard("c1", card("project:e", [6], "Make Callers & Call Management a medium priority.", "Callers"), { verdict: "note", text: "Cameron owns this" });
  answerProposalCard("c1", card("project:f", [7], "Retire the Growth plan.", "Growth"), { verdict: "approve", text: "but revisit in a month" });
  answerProposalCard("c1", card("project:g", [8], "Retire the Ads plan.", "Ads"), { verdict: "approve" });
  answerProposalCard("c1", card("project:h", [9], "Retire the SEO plan.", "SEO"), { verdict: "approve" });
  answerProposalCard("c1", card("project:i", [10], "Retire the Blog plan.", "Blog"), { verdict: "approve" });
  // A legacy note on the whole proposal, already in a batch: no surface creates one any more.
  answerProposalCard("c1", card("", [], ""), { verdict: "note", text: "do the same for the plans next" });
  // The card in the thread the rows scroll to.
  const thread = document.createElement("div");
  thread.innerHTML = '<div data-proposal-card="op-55"><div data-subject="project:a"></div><div data-subject="project:b"></div></div>';
  document.body.append(thread);
  const scrolled: [Element, unknown][] = [];
  (dom.window.Element.prototype as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = function (this: Element, o: unknown) { scrolled.push([this, o]); };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const jumps: string[] = [];
  const submits: string[] = [];
  try {
    await act(() => root.render(<ReviewComposerContext.Provider value={{ quote() {}, submit() { submits.push("submit"); }, jumpToComment: (c) => jumps.push(c.id) }}><ReviewBar conversationId="c1" /></ReviewComposerContext.Provider>));
    // 7 approvals over 8 changes; 1 reject + 1 note + 1 whole-proposal note = 3 answers; 1 quote.
    expect(batchSendWords(useInboxStore.getState().reviewComments.c1!).head).toBe("8 changes will apply when you send, and 3 answers go with them · 1 quote");
    const title = host.querySelector<HTMLElement>(".cc-review-tray-title")!;
    expect(words(title)).toBe("8 changes will apply when you send, and 3 answers go with them · 1 quote");
    expect(title.dataset.reviewHead).toBe("8 changes will apply when you send, and 3 answers go with them · 1 quote");
    expect(host.querySelector(".cc-review-tray-dest")).toBeNull();
    expect(host.querySelector(".cc-review-tray")!.hasAttribute("data-applies")).toBe(true);
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Rank Union's projects by the goals they carry"]);
    // Bare approvals fold into one row named by the first three subjects and a count; each other answer is its own row with its subject and words; the quote comes last.
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Approve", "Reject", "On", "Approve", "On all of it"]);
    expect(texts(host, ".cc-review-tray-item")).toEqual([
      "Approve Matching Engine & Funnel, Callers & Call Management, Infrastructure and 3 more",
      "Reject Funnel P1 not P0",
      "On Callers Cameron owns this",
      "Approve Growth but revisit in a month",
      "On all of it do the same for the plans next",
      "❝ Quoted q1 tighten this",
    ]);
    const items = host.querySelectorAll<HTMLElement>(".cc-review-tray-item");
    expect(Array.from(items, (el) => el.dataset.reviewAnswer)).toEqual(["approve", "reject", "note", "approve", "note", undefined]);
    expect(Array.from(items, (el) => el.dataset.reviewCount)).toEqual(["6", "1", "1", "1", "1", undefined]);
    // A folded row's click scrolls to its first entry and flashes it; a whole-proposal note scrolls to the card; the quote's row still jumps through the host.
    const jumpButtons = host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-jump");
    await act(() => jumpButtons[0].click());
    const first = thread.querySelector('[data-subject="project:a"]')!;
    expect(scrolled).toEqual([[first, { block: "center", behavior: "smooth" }]]);
    expect(first.hasAttribute("data-flash")).toBe(true);
    await act(() => jumpButtons[4].click());
    expect(scrolled[1][0]).toBe(thread.querySelector('[data-proposal-card="op-55"]')!);
    expect(Array.from(jumpButtons, (b) => b.disabled)).toEqual([false, false, false, false, false, false]);
    await act(() => jumpButtons[5].click());
    expect(jumps).toEqual(["q1"]);
    // Edit in input shows while a quote is in the batch, and hands off to the composer.
    const edit = Array.from(host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-actions button")).find((b) => b.textContent?.includes("Edit in input"))!;
    await act(() => edit.click());
    expect(submits).toEqual(["submit"]);
    // The folded row's x undoes all six approvals and nothing else.
    const undo = host.querySelector<HTMLButtonElement>('[aria-label="Undo this answer"]')!;
    expect(undo.title).toBe("Undo");
    await act(() => undo.click());
    expect(texts(host, ".cc-review-tray-verdict")).toEqual(["Reject", "On", "Approve", "On all of it"]);
    expect(useInboxStore.getState().reviewComments.c1!.filter((c) => c.proposal).map((c) => c.proposal!.verdict)).toEqual(["reject", "note", "approve", "note"]);
    expect(words(host.querySelector(".cc-review-tray-title")!)).toBe("1 change will apply when you send, and 3 answers go with them · 1 quote");
    // With the quote gone, Edit in input goes too; the head drops the quotes.
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove this quote"]')!.click());
    expect(words(host.querySelector(".cc-review-tray-title")!)).toBe("1 change will apply when you send, and 3 answers go with them");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".cc-review-tray-actions button")).map((b) => b.textContent?.trim())).toEqual(["Clear"]);
    // Answers alone: no data-applies, and the head speaks of answers only.
    await act(() => {
      useInboxStore.setState({ reviewComments: {} });
      answerProposalCard("c1", card("project:a", [1], "A.", "Alpha"), { verdict: "reject", text: "no" });
      answerProposalCard("c1", card("project:b", [2], "B.", "Beta"), { verdict: "note", text: "later" });
    });
    expect(host.querySelector(".cc-review-tray")!.hasAttribute("data-applies")).toBe(false);
    expect(words(host.querySelector(".cc-review-tray-title")!)).toBe("2 answers go when you send");
    // One, two and three subjects read in full; an item with no subject is named by its sentence.
    await act(() => {
      useInboxStore.setState({ reviewComments: {} });
      answerProposalCard("c1", card("project:a", [1], "A."), { verdict: "approve" });
    });
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Approve A."]);
    await act(() => answerProposalCard("c1", card("project:b", [2], "B.", "Beta"), { verdict: "approve" }));
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Approve A. and Beta"]);
    await act(() => answerProposalCard("c1", card("project:c", [3], "C.", "Gamma"), { verdict: "approve" }));
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Approve A., Beta and Gamma"]);
  } finally { await act(() => root.unmount()); host.remove(); thread.remove(); }
}, 60_000);

test("a reply box's rows are one proposal's, on a thread key two proposals share", async () => {
  const P2 = { id: "p-2", short_id: "op-56", title: "Close the Growth plan" };
  useInboxStore.setState({ reviewComments: { t1: [quote("q1", "tighten this")] } });
  answerProposalCard("t1", card("project:a", [1], "A.", "Alpha"), { verdict: "approve" });
  answerProposalCard("t1", { ...card("plan:g", [1], "Retire the Growth plan.", "Growth"), proposal: P2 }, { verdict: "reject", text: "keep it" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<PendingBatchRows batchKey="t1" proposalId="p-2" />));
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Close the Growth plan"]);
    expect(texts(host, ".cc-review-tray-item")).toEqual(["Reject Growth keep it"]);
    // Without the filter the same key shows both proposals and the quote.
    await act(() => root.render(<PendingBatchRows batchKey="t1" />));
    expect(texts(host, ".cc-review-tray-group")).toEqual(["Rank Union's projects by the goals they carry", "Close the Growth plan"]);
    expect(texts(host, ".cc-review-tray-item")).toHaveLength(3);
  } finally { await act(() => root.unmount()); host.remove(); }
}, 60_000);
