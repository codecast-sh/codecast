// Three asks with their Accept and Skip fit the first desktop screen at
// 1440 by 900 (org eval round 3: the third ask's buttons sat below the fold;
// round 12: they sat at it again, with the asks the analyzer writes now).
// jsdom lays nothing out, so this is a height budget: the spacing and line
// heights are read from the classes the pane renders, the line counts from a
// greedy wrap of the words at the column's measured width, and the sum is
// held under the screen. The chrome above the cards and the column's width
// were measured on the real page in Chrome at 1440 by 900 on 2026-09-23
// (getBoundingClientRect on the round 12 proposal), where this model landed
// within 7px of the browser on every card. The shapes are the round 12 Union
// proposal's, the longest the analyzer has written: a two line title on
// every card, three to four lines of why, two to four of effect. Change the
// card's spacing and this test moves with it; change the words the analyzer
// may write (orgInit ORG_ASKS_RULE) and it says so.
// A proposal that is one ask draws its entries straight under the title
// (S39), so the second budget is the first entry's: its Accept ends above the
// fold too, with the letter's own words as the sentence and the reason.
// Run: bun components/org/StaffingPane.fit.test.tsx
// FIT_PROPOSAL=<an org eval run's proposal.json> measures a real proposal.
import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";

/** The desktop capture's geometry (desktop.png, 1440 by 900). */
const SCREEN_H = 900;
/** Where the first card's top pixel sits: under the app's top bar and tab
 *  strip (79), the org page's one line header (40) and the column's top
 *  padding (16). The page header names the proposal (titleInPageHeader), so
 *  nothing else is above the cards. Measured in Chrome: 135. */
const PANE_TOP = 135;
/** The width the words wrap in: the asks column (STAFFING_ASKS_W 380) less
 *  its gutters (32), the card's border and padding (2 x 15), the number
 *  badge (24) and its gap (12). Measured in Chrome: 282. */
const TEXT_W = 282;
/** JetBrains Mono's advance is 0.6 em. */
const CHAR_W = (px: number) => px * 0.6;

/** Tailwind's spacing scale, in px, for the tokens the card uses. */
const space = (token: string): number => {
  const m = /^\[(\d+(?:\.\d+)?)px\]$/.exec(token);
  if (m) return Number(m[1]);
  return Number(token) * 4;
};
const classTokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
/** The px value of a utility on the element: `pt-2.5` → 10, `h-7` → 28; 0 when absent. */
const util = (el: Element, prefix: string): number => {
  const hit = classTokens(el).find((c) => c.startsWith(`${prefix}-`) && !/^-/.test(c));
  return hit ? space(hit.slice(prefix.length + 1)) : 0;
};
const fontPx = (el: Element): number => {
  const hit = classTokens(el).find((c) => /^text-\[\d+(\.\d+)?px\]$/.test(c));
  assert.ok(hit, `no font size on ${el.tagName}`);
  return Number(/\[(.*)px\]/.exec(hit!)![1]);
};
const LEADING: Record<string, number> = { "leading-none": 1, "leading-tight": 1.25, "leading-snug": 1.375, "leading-normal": 1.5, "leading-relaxed": 1.625, "leading-loose": 2 };
const lineHeight = (el: Element): number => {
  const hit = classTokens(el).find((c) => c in LEADING);
  assert.ok(hit, `no line height on ${el.tagName}`);
  return fontPx(el) * LEADING[hit!];
};
/** Greedy word wrap: how many lines the words take at this width and size. */
export const wrappedLines = (text: string, fontPxSize: number, width = TEXT_W): number => {
  const perLine = Math.floor(width / CHAR_W(fontPxSize));
  let lines = 1, col = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const need = col === 0 ? word.length : col + 1 + word.length;
    if (need <= perLine) col = need;
    else { lines += 1; col = word.length; }
  }
  return lines;
};

async function verifyFit() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } = await import("./orgStaffingFixture");
  const { UNION_GOALS_DATA, UNION_GOALS_PROPOSAL, UNION_GOALS_TREE } = await import("./goalsFixture");
  const { findHeadOfPeople } = await import("./staffingModel");

  // The round 12 shapes, the analyzer's own words (~/.cache/org-eval/union/
  // round-12/s1/proposal.json): every title two lines; why 100, 110 and 125
  // characters; effect 50, 113 and 86. The wrap below turns them into the
  // capture's line counts: why 3, 3, 4 and effect 2, 4, 3.
  const round12 = [
    { title: "Correct 17 plans and tasks that no longer match the work", why: "Their status disagrees with the code history and the sessions, so your lists overstate what is open.", effect: "Your task lists show only work that is still open.", seqs: [7, 8] },
    { title: "Resume the Infrastructure lead and add a Public Launch lead", why: "Infrastructure has the most open work and a paused lead, and Public Launch & Fundraise has real work and none.", effect: "Eight of ten projects with work have a lead, and the plan for Claude Code accounts is filed where it can be seen.", seqs: [1, 2, 3, 4] },
    { title: "Name two long running sessions as roles", why: "The Market growth mandate and Cold email reply rate optimization sessions each run a daily job that has no name on the chart.", effect: "Both keep running as they do; you may skip the steps that put each under an area lead.", seqs: [5, 6] },
  ];
  // FIT_PROPOSAL=<proposal.json> measures a real proposal instead (an org
  // eval run's spec), read the way the page's preview reads it.
  const { orgProposalRowFromSpec } = await import("./orgPreviewSpec");
  const real = process.env.FIT_PROPOSAL ? orgProposalRowFromSpec(JSON.parse(await Bun.file(process.env.FIT_PROPOSAL).text())) : null;
  assert.ok(!process.env.FIT_PROPOSAL || real, `${process.env.FIT_PROPOSAL} is not a proposal spec`);
  const proposal = real ?? { ...ORG_STAFFING_FIXTURE_PROPOSAL, title: "Company review: Fixture", asks: round12 };
  const asks = proposal.asks!;
  const headOfPeopleTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-head", short_id: "or-9", handle: "head-of-people", name: "Head of People", standing: { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" } }] };
  const noop = () => {};
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(React.createElement(StaffingPane, {
    tree: headOfPeopleTree, health: ORG_STAFFING_FIXTURE_HEALTH, proposals: [proposal], proposal, head: findHeadOfPeople(headOfPeopleTree), reviewing: false, now: Date.now(), hasThread: true, selectedChangeId: null, titleInPageHeader: true,
    onSelectChange: noop, onDecide: noop, onDecideAsk: noop, onEditRole: noop, onSelectNode: noop, onOpenSession: noop, onPickProposal: noop, onHireHeadOfPeople: noop, onProposeNow: noop, onAskAbout: noop, onAskAboutAsk: noop,
  } as any)));
  const q = (sel: string, from: ParentNode = document) => { const el = from.querySelector(sel); assert.ok(el, `missing ${sel}`); return el!; };

  // The page header names the proposal: the column carries no header of its
  // own, and the list sits on the column's first pixel.
  assert.equal(document.querySelector("[data-asks-header]"), null, "the column has no header of its own on a desktop");
  const list = q("[data-asks]");
  assert.equal(util(list, "mt"), 0, "nothing above the first card");
  let y = PANE_TOP;
  const gap = util(list, "gap");
  const cards = [...document.querySelectorAll<HTMLElement>("[data-ask]")];
  assert.equal(cards.length, 3);
  const report: string[] = [];
  let lastControlsBottom = 0;
  cards.forEach((card, i) => {
    const top = y + (i === 0 ? 0 : gap);
    const head = card.firstElementChild!;
    const title = q("[data-ask-title]", card), why = q("[data-ask-why]", card), effect = q("[data-ask-effect]", card), controls = q("[data-ask-controls]", card), fold = q("[data-ask-fold]", card);
    const titleH = wrappedLines(asks[i].title, fontPx(title)) * lineHeight(title);
    const whyH = wrappedLines(asks[i].why, fontPx(why)) * lineHeight(why);
    // The effect line carries its own prefix, on the same line as the words.
    const effectH = wrappedLines(`If you accept: ${asks[i].effect}`, fontPx(effect)) * lineHeight(effect);
    const buttonH = util(q("[data-ask-accept]", controls), "h") || 28;
    const controlsBottom = top + 1 + util(head, "pt") + titleH + util(why, "mt") + whyH + util(effect, "mt") + effectH + util(controls, "mt") + buttonH;
    const bottom = controlsBottom + util(head, "pb") + 1 + util(fold, "h") + 1;
    report.push(`card ${i + 1}: ${Math.round(top)} to ${Math.round(bottom)} (buttons end at ${Math.round(controlsBottom)}); title ${wrappedLines(asks[i].title, fontPx(title))} lines, why ${wrappedLines(asks[i].why, fontPx(why))}, effect ${wrappedLines(`If you accept: ${asks[i].effect}`, fontPx(effect))}`);
    lastControlsBottom = controlsBottom;
    y = bottom;
  });
  console.log(report.join("\n"));
  console.log(`three cards end at ${Math.round(y)} of ${SCREEN_H}`);
  // The line counts are the capture's: without them the budget measures nothing.
  if (!real) {
    assert.deepEqual(asks.map((a) => wrappedLines(a.title, 14.5)), [2, 2, 2]);
    assert.deepEqual(asks.map((a) => wrappedLines(a.why, 12.5)), [3, 3, 4]);
    assert.deepEqual(asks.map((a) => wrappedLines(`If you accept: ${a.effect}`, 12.5)), [2, 4, 3]);
  }
  // The third ask's Accept and Skip are on the first screen, with room for a
  // one line difference between the wrap model and the browser.
  assert.ok(lastControlsBottom + 18.75 <= SCREEN_H, `the third ask's buttons end at ${Math.round(lastControlsBottom)}; the screen ends at ${SCREEN_H}`);

  // ── one ask: the first entry's Accept on the first screen ──
  // Union's goals proposal (op-54, eleven changes in one ask): the purpose is
  // the first entry, with the longest sentence and the longest field value the
  // analyzer has written. The entry is read the way it is drawn in the narrow
  // layout: the number column (20) beside the text, the sentence at 13.5 over
  // 20, then the fields at 12.5 over 20 in a label gutter of 86, the reason
  // at 12 over 1.6, and the verdict row under it all, 12 above and 28 tall.
  await act(async () => root.render(React.createElement(StaffingPane, {
    tree: UNION_GOALS_TREE, health: ORG_STAFFING_FIXTURE_HEALTH, proposals: [UNION_GOALS_PROPOSAL], proposal: UNION_GOALS_PROPOSAL, head: findHeadOfPeople(UNION_GOALS_TREE), reviewing: false, now: Date.now(), hasThread: true, selectedChangeId: null, titleInPageHeader: true,
    live: { tree: UNION_GOALS_TREE, goals: UNION_GOALS_DATA.initiatives, projects: UNION_GOALS_DATA.projects, plans: [], tasks: [] },
    onSelectChange: noop, onDecide: noop, onDecideAsk: noop, onEditRole: noop, onSelectNode: noop, onOpenSession: noop, onPickProposal: noop, onHireHeadOfPeople: noop, onProposeNow: noop, onAskAbout: noop, onAskAboutAsk: noop,
  } as any)));
  assert.equal(document.querySelector("[data-asks-header]"), null);
  assert.equal(document.querySelector("[data-ask-fold]"), null, "one ask: no fold, the entries are the column");
  const first = q("[data-ask-rows] [data-subject]");
  assert.equal(first.getAttribute("data-subject-variant"), "full");
  const sentence = q("[data-subject-sentence]", first);
  // The entry's own width: the column (380) less its gutters (32) and the number column (20).
  const ENTRY_W = 380 - 32 - 20;
  const sentenceLines = wrappedLines(sentence.textContent!, 13.5, ENTRY_W);
  const fields = [...first.querySelectorAll<HTMLElement>("[data-field]")];
  // A field's label sits in the gutter; its value wraps in what is left. A list behind a summary is one line until opened.
  const fieldLines = fields.reduce((n, dd) => n + wrappedLines(dd.textContent!, 12.5, ENTRY_W - 86), 0);
  const reasonLines = [...first.querySelectorAll<HTMLElement>("[data-subject-reasons] p")].reduce((n, p) => n + wrappedLines(p.textContent!, 12, Math.min(ENTRY_W, 70 * 0.6 * 12)), 0);
  const entryTop = PANE_TOP + 1 + 13;
  const acceptBottom = entryTop + sentenceLines * 20 + 8 + fieldLines * 20 + 8 + reasonLines * 12 * 1.6 + 12 + 28;
  console.log(`lone ask, first entry: sentence ${sentenceLines} lines, fields ${fieldLines}, reason ${reasonLines}; Accept ends at ${Math.round(acceptBottom)} of ${SCREEN_H}`);
  // The purpose's sentence is 80 characters: two lines at this width. Without the count the budget measures nothing.
  assert.equal(sentenceLines, 2);
  assert.ok(acceptBottom + 20 <= SCREEN_H, `the first entry's Accept ends at ${Math.round(acceptBottom)}; the screen ends at ${SCREEN_H}`);

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("staffing pane fit: passed");
}

if (import.meta.main) await verifyFit();
