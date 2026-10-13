// Mounts the moment a judge read (MomentView, line-workspace.md LW1) in jsdom
// with the moment query stubbed: unreadable, body on host, body expired, and a
// kept body that opens on the message the judge flagged (one block either
// side, its verdict beside it) with the raw ids behind one toggle. marked()
// and flaggedBlock() are pinned on their own.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
// Unmount first: a mounted ProductView would keep minting into the next file's run.
afterAll(() => { act(() => root.unmount()); closeDomWindow(dom); restoreGlobals(); });

let moment: unknown = undefined;
const realQuery = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: () => ({ data: moment, error: null }) }));
let body: { at: number; refs: unknown[]; blocks: unknown[] } = {
  at: 1_791_700_000_000, refs: [],
  blocks: [
    { type: "message", direction: "in", sender: "Kerri", channel: "imessage", at: 1, body: "Hi, I'm looking for funders." },
    { type: "message", direction: "in", sender: "Kerri", channel: "imessage", at: 2, body: "My name is Kerri Lake." },
    { type: "message", direction: "out", sender: "Union", channel: "imessage", at: 3, body: "Thanks Kerri. A first pass turned up an impact allocator in New York." },
    { type: "message", direction: "out", sender: "Union", channel: "imessage", at: 4, body: "What's the best email for you?" },
    { type: "message", direction: "in", sender: "Kerri", channel: "imessage", at: 5, body: "kerri@example.org" },
  ],
};
const reads: string[] = [];
const realConvex = await import("convex/react");
// The app view's mint answers `mint` (none by default); the body read answers `body`.
let mint: unknown = null;
mock.module("convex/react", () => ({ ...realConvex, useAction: () => async (args: { moment?: string; ref?: string }) => {
  if (args.ref) return mint;
  reads.push(args.moment!);
  return body;
} }));

const { useInboxStore } = await import("../../../../store/inboxStore");
useInboxStore.setState({ currentUser: { _id: "u1" } } as never);
const { MomentView, marked, flaggedBlock, quotedFrom, conversationBlock } = await import("../MomentView");

const base = {
  short_id: "mo-1083", kind: "contact-conversation", subject: "5c2a9e1f-0b7d-4a43-9c11-2f0a7e9d1b3c", event_at: 1_791_700_000_000, gap_ms: 0, events: 10,
  refs: { trigger: "imessage_received", score: "8f3c1a2b-77de-4a10-b9a2-1c9d0e7f6a55" }, source: "union-moments", status: "ready", kept: true, storage: "convex", blocks: 5, error: null,
  runs: [{ judge: "comms", judge_version: "72298db6c154", mode: "live", status: "ok", reason: null, filed: 1, model: "m", cost_usd: 0, at: 1,
    findings: [{ expectation: "ex-3", severity: 5, what_happened: "Narrated the search instead of leading with a result.", quote: "A first pass turned up an impact allocator" }] }],
};

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
let n = 0;
async function render(m: unknown, id = "mo-1083") {
  moment = m;
  // A new key per state: the stubbed query pushes nothing, so each state mounts afresh.
  await act(async () => { root.render(React.createElement(MomentView, { key: n++, moment: id, cited: "ex-3" })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

test("marked: quotes shorter than 4 characters mark nothing; repeats all mark; an overlap keeps the earlier span", () => {
  const html = (t: string, q: string[]) => renderToStaticMarkup(React.createElement("span", null, marked(t, q)));
  expect(html("a cat sat", ["cat"])).toBe("<span>a cat sat</span>");
  expect(html("send it, send it", ["send it"])).toBe('<span><mark class="mv-mark">send it</mark>, <mark class="mv-mark">send it</mark></span>');
  expect(html("abcdefgh", ["abcdef", "cdefgh"])).toBe('<span><mark class="mv-mark">abcdef</mark>gh</span>');
  // Marked the way flaggedBlock found the block: curly quotes, spacing and case aside, the original text kept.
  expect(html("He said “What’s the best  Email” today", ["what's the best email"])).toBe('<span>He said “<mark class="mv-mark">What’s the best  Email</mark>” today</span>');
});

test("flaggedBlock finds the quoted message, curly quotes and spacing aside", () => {
  expect(flaggedBlock(body.blocks as never, ["What’s the best  email"])).toBe(3);
  expect(flaggedBlock(body.blocks as never, ["nowhere in the body"])).toBe(-1);
  expect(flaggedBlock(body.blocks as never, ["Hi"])).toBe(-1);
});

test("a moment the viewer cannot read says so", async () => {
  await render(null);
  expect(host.querySelector('[data-line-moment="none"]')?.textContent).toContain("mo-1083 not readable here");
});

test("a body held on the host, or expired, says which, and reads nothing", async () => {
  reads.length = 0;
  await render({ ...base, kept: false, storage: "host" });
  expect(host.querySelector(".mv-held")?.textContent).toContain("body on host");
  await render({ ...base, kept: false, storage: "convex" });
  expect(host.querySelector(".mv-held")?.textContent).toContain("body expired");
  expect(reads).toEqual([]);
});

test("a kept body opens on the flagged message with its verdict, one block either side, and the ids behind a toggle", async () => {
  await render(base);
  const flagged = host.querySelector("[data-line-moment-flagged]")!;
  expect(flagged.textContent).toContain("A first pass turned up");
  expect(flagged.textContent).toContain("Narrated the search");
  expect(host.querySelectorAll(".mv-body .mv-msg").length).toBe(3);
  expect(host.querySelector(".mv-body")!.textContent).toContain("1 earlier");
  expect(host.querySelector(".mv-body")!.textContent).toContain("1 later");
  // The raw ids are folded: the subject's UUID shows only once asked for.
  expect(host.textContent).not.toContain(base.subject);
  // The judge's runs and the ids are behind the one disclosure.
  expect(host.querySelector("[data-line-moment-runs]")).toBeNull();
  await act(async () => { (host.querySelector("[data-line-moment-saw-toggle]") as HTMLElement).click(); });
  expect(host.querySelector("[data-line-moment-ids]")!.textContent).toContain(base.subject);
  expect(host.querySelector("[data-line-moment-runs]")).not.toBeNull();
  await act(async () => { (host.querySelector(".mv-expand") as HTMLElement).click(); });
  expect(host.querySelectorAll(".mv-body .mv-msg").length).toBe(5);
});

test("quotedFrom finds where an email's quoted history starts, flattened or not", () => {
  expect(quotedFrom("Sounds good, Tuesday works.\n\nOn Oct 2, 2026, at 8:12 PM, Riley <r@x.org> wrote:\n> Can we meet?")).toBe(29);
  expect(quotedFrom("Thanks! > > Earlier we said > > more")).toBe(7);
  expect(quotedFrom("> all of it is quote")).toBe(-1);
  expect(quotedFrom("No history here.")).toBe(-1);
});

test("the judge's context (ledger, facts) and every run hide behind 'What the judge saw'; an email's quoted history folds (ct-59433)", async () => {
  body = { at: 1_791_700_000_000, refs: [], blocks: [
    { type: "text", title: "Commitment ledger (what we promised and what became of it by this moment; trust this over impressions from the messages)", text: "1. pitched with FWRD clearly as t" },
    { type: "message", direction: "in", sender: "Riley", channel: "email", at: 1, body: "Tuesday works for me.\n\nOn Oct 2, 2026, Union <u@x.org> wrote:\n> > A first pass turned up nothing yet" },
    { type: "message", direction: "out", sender: "Union", channel: "email", at: 2, body: "Great, I will send the intro. A first pass turned up an impact allocator." },
    { type: "facts", title: "Party 2 (principal)", facts: [{ label: "Lifecycle", value: "contactedAt: 2026-10-02" }] },
  ] };
  await render(base, "mo-2001");
  expect(host.textContent).not.toContain("Commitment ledger");
  expect(host.textContent).not.toContain("Lifecycle");
  expect(host.textContent).not.toContain("blocks");
  // The flagged line is lit with the judge's reason; the reply's quoted history is folded.
  expect(host.querySelector("[data-line-moment-flagged]")!.textContent).toContain("Narrated the search");
  expect(host.textContent).toContain("Tuesday works for me.");
  expect(host.textContent).not.toContain("wrote:");
  await act(async () => { (host.querySelector("[data-line-moment-quoted]") as HTMLElement).click(); });
  expect(host.textContent).toContain("wrote:");
  await act(async () => { (host.querySelector("[data-line-moment-saw-toggle]") as HTMLElement).click(); });
  expect(host.querySelector("[data-line-moment-saw]")!.textContent).toContain("Commitment ledger");
});

test("a moment with no messages (a match) shows the judge's reason, never the lifecycle dump", async () => {
  body = { at: 1_791_700_000_000, refs: [], blocks: [{ type: "facts", title: "Party 2 (principal)", facts: [{ label: "Lifecycle", value: "contactedAt: 2026-10-02, A first pass turned up an impact allocator" }] }] };
  await render({ ...base, kind: "match", source: null }, "mo-2002");
  expect(host.textContent).not.toContain("Lifecycle");
  expect(host.querySelector("[data-line-moment-why]")!.textContent).toContain("Narrated the search");
});

test("an app view that cannot be framed puts no refusal over the conversation shown below; a missing grant keeps its Allow", async () => {
  body = { at: 1_791_700_000_000, refs: [], blocks: [{ type: "message", direction: "out", sender: "Union", channel: "email", at: 1, body: "A first pass turned up an impact allocator." }] };
  mint = { ok: false, app: "Union", view: "conversation", title: "Conversation", error: "the app's url is not on fly.dev" };
  useInboxStore.setState({ currentUser: { _id: "u-frame" } } as never);
  await render({ ...base, source: "union" }, "mo-2003");
  expect(host.querySelector(".mv-body")!.textContent).toContain("impact allocator");
  expect(host.textContent).not.toContain("can't be shown here");
  // Nothing of ours to show: the refusal is the only thing a reader learns, so it stays.
  await render({ ...base, source: "union", kept: false, storage: "host" }, "mo-2004");
  expect(host.textContent).toContain("can't be shown here");
  useInboxStore.setState({ currentUser: { _id: "u-grant" } } as never);
  mint = { ok: false, app: "Union", view: "conversation", title: "Conversation", error: "views.token is not granted", grant_url: "https://codecast.sh/ops/sources/so-3/grant" };
  await render({ ...base, source: "union" }, "mo-2005");
  expect(host.querySelector(".pv-why a")?.getAttribute("href")).toBe("https://codecast.sh/ops/sources/so-3/grant");
  mint = null;
});

test("a moment carried as text (a match) opens on the conversation block that holds the judged words (ct-59338 sg-2635, mo-1021)", async () => {
  const keep = body;
  const conv = "[Oct 9 2:25 PM] [EMAIL] [SENT] Subject: Re: Quick yes/no\nLory,\n\nRobert from our team left you a voicemail yesterday and said he'd follow up by email, so here it is.";
  const blocks = [
    { type: "facts", title: "Match", facts: [{ label: "status", value: "live" }] },
    { type: "text", title: "Party 1's private conversation with Union", text: conv },
    { type: "text", title: "Party 2's private conversation with Union", text: "[Oct 1] nothing judged here" },
  ];
  const quote = "Robert from our team left you a voicemail yesterday";
  expect(conversationBlock(blocks as never, [quote])).toBe(blocks[1] as never);
  // With no quote found, the first conversation block; a moment of messages has none.
  expect(conversationBlock(blocks as never, [])).toBe(blocks[1] as never);
  expect(conversationBlock(keep.blocks as never, [quote])).toBeNull();
  body = { at: 1_791_700_000_000, refs: [], blocks };
  await render({ ...base, kind: "match", runs: [{ ...base.runs[0], judge: "match", findings: [{ ...base.runs[0].findings[0], quote }] }] }, "mo-1021");
  const shown = host.querySelector("[data-line-moment-conversation]");
  expect(shown?.querySelector("h5")?.textContent).toBe("Party 1's private conversation with Union");
  expect(shown?.querySelector(".mv-mark")?.textContent).toBe(quote);
  body = keep;
});
