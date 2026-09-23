// Mounts the staffing pane in jsdom against the fixture proposal and health
// and checks its states: a proposal as its asks (org-staffing.md S19: one
// line of header, one card per ask with Accept, Skip and Ask about this, the
// rows inside the fold, one line of cost), the health summary with no
// proposal, and the two buttons with no chief of staff. It ends with S19's
// own test applied to the first screen: every word a cold reader meets before
// scrolling, checked against the words the glossary exists to define.
// Run: bun components/org/StaffingPane.mount.test.tsx
import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyStaffingPane() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  // The chief's thread embed pulls the whole store and the message pipeline;
  // the pane only places it.
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, ORG_STAFFING_FIXTURE_BIG_PROPOSAL } = await import("./orgStaffingFixture");
  const { findChiefOfStaff } = await import("./staffingModel");
  const { revisedSince } = await import("./staffingRevise");
  const { ORG_VERDICT_REVISED, orgVerdictSeenFault } = await import("@codecast/shared/contracts/orgProposal");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const calls: string[] = [];
  // What each verdict said the page had painted (S18): the latest revise
  // among its rows and, for an ask, the seqs its card held.
  const seens: unknown[] = [];
  const base = {
    tree: chiefTree,
    health: ORG_STAFFING_FIXTURE_HEALTH,
    proposals: [ORG_STAFFING_FIXTURE_PROPOSAL],
    chief: findChiefOfStaff(chiefTree),
    reviewing: false,
    now: Date.now(),
    hasThread: true,
    onSelectChange: (id: string | null) => calls.push(`select:${id}`),
    onDecide: (id: string, verdict: string, edits: Record<string, unknown> | undefined, seen: unknown) => { seens.push(seen); calls.push(`decide:${id}:${verdict}${edits ? ":" + JSON.stringify(edits) : ""}`); },
    onDecideAsk: (id: string, ask: number, verdict: string, seen: unknown, opts?: { leave_sessions?: boolean }) => { seens.push(seen); calls.push(`ask:${id}:${ask}:${verdict}${opts ? ":" + JSON.stringify(opts) : ""}`); },
    onEditRole: (c: any) => calls.push(`editRole:${c._id}`),
    onSelectNode: (id: string) => calls.push(`node:${id}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    onPickProposal: (id: string) => calls.push(`pick:${id}`),
    onHireChief: () => calls.push("hire"),
    onProposeNow: () => calls.push("propose"),
    onAskAbout: (c: any) => calls.push(`about:${c._id}`),
    onAskAboutAsk: (a: any) => calls.push(`aboutAsk:${a.index}`),
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (props: any) => act(async () => root.render(React.createElement(StaffingPane, { ...base, ...props })));
  const text = () => document.body.textContent ?? "";
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const button = (label: string) => {
    const el = qa("button").find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
    assert.ok(el, `Missing button "${label}"`);
    return el!;
  };
  const card = (i: number) => q(`[data-ask="${i}"]`)!;

  // ── a proposal: one line of header, one card per ask, one line of cost ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "proposal");
  assert.match(q("[data-asks-header]")!.textContent!, /^Split growth, own the platform work, budget the reviews0 of 4 decided$/);
  // What goes (S19): no op-N pill, no picker, no provenance line, no progress
  // strip, no summary controls, no section label, no group headers, no
  // accept all box, no intro banner, no glossary link. The author and the
  // date are the letter's, on the left.
  assert.doesNotMatch(text(), /op-7|from a company review|ago|Accept all|Changes|Findings|Budget|How this works|Words/);
  assert.equal(q("select"), null);
  assert.equal(q('[role="group"]'), null);
  assert.equal(q("[data-proposal-intro]"), null);
  // The asks the fixture derives (it stores none): the records, one per new
  // role, and the rest as one; every card reads title, why, effect, and the
  // three controls, with its rows folded and counted.
  assert.deepEqual(qa("[data-ask-title]").map((el) => el.textContent), ["Bring 2 records up to date", "Add an agent: Head of Platform", "Add an agent: Content Lead", "4 smaller changes: filing, goals and settings"]);
  assert.deepEqual(qa("[data-ask]").map((el) => el.getAttribute("data-ask-state")), ["open", "open", "open", "open"]);
  assert.match(card(1).querySelector("[data-ask-why]")!.textContent!, /^The Platform project has 14 open tasks and no owner role/);
  assert.match(card(1).querySelector("[data-ask-effect]")!.textContent!, /^If you accept: Platform decisions get a recommendation/);
  assert.deepEqual([...card(1).querySelectorAll("[data-ask-controls] button")].map((b) => b.textContent?.trim()), ["Accept", "Skip", "Ask about this"]);
  assert.deepEqual(qa("[data-ask-fold]").map((el) => el.textContent?.trim()), ["2 records", "1 change", "1 change", "4 changes"]);
  assert.equal(qa("[data-change-row]").length, 0, "no row on the first screen");
  // The half decided ask says so under its title and keeps its controls.
  assert.equal(card(3).querySelector("[data-ask-verdict]")!.textContent, "2 of 4 changes decided");
  assert.ok(card(3).querySelector("[data-ask-accept]"));
  // Accept and Skip on a card are the ask's verdict, once, by index, and each
  // says what the card showed: this fixture was never revised, and the first
  // card holds the two records.
  await act(async () => (card(0).querySelector("[data-ask-accept]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "ask:fixture-proposal-7:0:accept");
  assert.deepEqual(seens.pop(), { revised_at: 0, seqs: [8, 7] }, "the two records, in the order the card applies them (the server sorts before comparing)");
  await act(async () => (card(2).querySelector("[data-ask-skip]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "ask:fixture-proposal-7:2:skip");
  const staleSeen = seens.pop() as { revised_at: number; seqs: number[] };
  assert.deepEqual(staleSeen, { revised_at: 0, seqs: [ORG_STAFFING_FIXTURE_PROPOSAL.changes.find((c) => c.change.kind === "role" && c.change.handle === "content")!.seq] });
  await act(async () => (card(1).querySelector("[data-ask-about]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "aboutAsk:1");
  // No cost line and no arithmetic (org-staffing.md S23.2): a proposal says
  // nothing about what a role may do in a day.
  assert.equal(q("[data-cost]"), null);
  assert.equal(q("[data-cost-line]"), null);
  assert.equal(q('[data-summary-detail="budget"]'), null);
  // No composer of the chief's: the page renders the author's thread.
  assert.equal(q("[data-composer]"), null);
  assert.equal(q("[data-thread]"), null);

  // ── the fold: today's rows and controls, one at a time ──
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(card(3).getAttribute("data-ask-state"), "open");
  assert.equal(qa("[data-ask-rows]").length, 1, "one fold open at a time");
  assert.deepEqual(qa("[data-ask-rows] [data-change-row]").map((el) => el.getAttribute("data-change-row")), ["fixture-change-3", "fixture-change-6", "fixture-change-4", "fixture-change-5"]);
  assert.equal(qa('[data-ask-rows] [data-change-status="proposed"] button[aria-label="Accept"]').length, 2);
  assert.equal(qa('[data-ask-rows] [data-change-status="accepted"] button[aria-label="Accept"]').length, 0);
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-label="Skip"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-4:skip");
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-pressed]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-4");
  // Opening another fold closes this one; a change focused from the chart
  // opens the card that holds it, and the row shows its rationale inline.
  await act(async () => (card(1).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.deepEqual(qa("[data-ask-rows] [data-change-row]").map((el) => el.getAttribute("data-change-row")), ["fixture-change-1"]);
  await act(async () => qa('[data-change-row="fixture-change-1"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "editRole:fixture-change-1");
  assert.equal(q('[data-change-row="fixture-change-1"] [data-tenure]')!.getAttribute("data-tenure"), "standing");
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-4" });
  assert.ok(q('[data-ask="3"] [data-change-row="fixture-change-4"] [data-rationale]'), "the focused change's card opens with the rationale under the row");
  assert.match(q("[data-rationale]")!.textContent!, /hit its token cap on four of the last seven days/);
  assert.deepEqual(qa("[data-rationale] [data-verdicts] button").map((b) => b.textContent?.trim()), ["Accept", "Edit", "Skip", "Ask about this"]);
  await act(async () => qa("[data-rationale] [data-verdicts] button")[3].click());
  assert.equal(calls.pop(), "about:fixture-change-4");
  // Closing the card lets go of the focused change.
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "select:null");
  // Edit on a budget change is the inline form; accept with edits carries them.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-4" });
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-4");
  const input = q<HTMLInputElement>('[data-edit-form] input[type="number"]');
  assert.ok(input, "budget edit form");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "600000");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q("[data-edit-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.pop(), 'decide:fixture-change-4:accept:{"caps":{"tokens_per_day":600000}}');
  // A record row inside the records ask: the evidence on the row, the status a closed set.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-7" });
  assert.match(q('[data-change-row="fixture-change-7"] [data-sync-evidence]')!.textContent!, /evidenceEvery task closed 19 days ago/);
  // A record row names its record (S9): the act, the title a person can
  // read cold, and the id as a pill; the tooltip carries the same line.
  assert.equal(q('[data-change-row="fixture-change-7"] [data-record-title]')!.textContent, "Onboarding emails");
  assert.equal(q('[data-change-row="fixture-change-7"] [data-record-ref]')!.textContent, "pl-61");
  assert.match(q('[data-change-row="fixture-change-7"] [data-record-line]')!.textContent!, /^Mark done: Onboarding emailspl-61$/);
  assert.equal(q('[data-change-row="fixture-change-7"] [title]')!.getAttribute("title"), "Mark done: Onboarding emails (pl-61)");
  assert.doesNotMatch(q('[data-change-row="fixture-change-7"]')!.textContent!, /Mark plan pl-61/, "the id alone no longer stands for the record");
  await act(async () => qa('[data-change-row="fixture-change-7"] button[aria-label="Edit"]')[0].click());
  const statusSelect = q<HTMLSelectElement>('[data-edit-form] select[data-edit-select="status"]');
  assert.deepEqual([...statusSelect!.options].map((o) => o.value), ["done", "abandoned", "active"]);

  // ── decided asks: the verdict under the title, the controls gone, the fold kept ──
  const decided = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c.seq === 7 || c.seq === 8 ? { ...c, status: "applied" as const } : c.seq === 1 ? { ...c, status: "skipped" as const } : c.seq === 2 ? { ...c, status: "failed" as const, applied_note: "handle content is taken" } : c) };
  await render({ proposal: decided, proposals: [decided], selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /2 of 4 decided$/);
  assert.equal(card(0).getAttribute("data-ask-state"), "accepted");
  assert.equal(card(0).querySelector("[data-ask-verdict]")!.textContent, "Accepted");
  assert.equal(card(0).querySelector("[data-ask-controls]"), null);
  await act(async () => (card(0).querySelector("[data-ask-about]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "aboutAsk:0", "a decided ask still takes a question");
  assert.equal(card(0).querySelector("[data-ask-why]"), null);
  assert.equal(card(1).getAttribute("data-ask-state"), "skipped");
  assert.equal(card(1).querySelector("[data-ask-verdict]")!.textContent, "Skipped");
  // A failed row is still the person's (the server takes it again): the ask stays open and says so.
  assert.equal(card(2).getAttribute("data-ask-state"), "open");
  assert.equal(card(2).querySelector("[data-ask-verdict]")!.textContent, "1 change failed. Accept tries it again");
  assert.ok(card(2).querySelector("[data-ask-accept]"));
  await act(async () => (card(0).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(qa('[data-ask="0"] [data-change-status="applied"]').length, 2);

  // ── the author revised rows since the reader last looked (S18): the card says so ──
  const amendedRow = { ...ORG_STAFFING_FIXTURE_PROPOSAL.changes[3], revision: { kind: "amended" as const, note: "Raised on your note.", at: Date.now(), before: ORG_STAFFING_FIXTURE_PROPOSAL.changes[3].change } };
  const revisedProposal = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c._id === amendedRow._id ? amendedRow : c) };
  await render({ proposal: revisedProposal, proposals: [revisedProposal], selectedChangeId: null, revised: { rows: [amendedRow], who: "Chief of Staff", onSeen: () => calls.push("seen") } });
  assert.equal(qa("[data-ask-revised]").length, 1);
  assert.match(card(3).querySelector("[data-ask-revised]")!.textContent!, /Chief of Staff changed 1 since you last looked/);
  // A verdict pressed now says it read this revise; the stale skip above did
  // not, so the server refuses it (orgVerdictSeenFault) and this list, with
  // the strip, is what the page shows instead: no row of that card is marked.
  await act(async () => (card(3).querySelector("[data-ask-accept]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "ask:fixture-proposal-7:3:accept");
  assert.equal((seens.pop() as { revised_at: number }).revised_at, amendedRow.revision.at);
  assert.ok(staleSeen.revised_at < amendedRow.revision.at, "the stale verdict named an older read than the revise");
  assert.deepEqual(revisedSince(revisedProposal.changes, staleSeen.revised_at), [amendedRow], "the strip shows exactly the revise that refused the stale verdict");
  assert.equal(orgVerdictSeenFault(revisedProposal.short_id, staleSeen, revisedProposal.changes, staleSeen.seqs), `${revisedProposal.short_id} ${ORG_VERDICT_REVISED}`);
  assert.equal(card(2).getAttribute("data-ask-state"), "open");
  assert.equal(qa('[data-ask="2"] [data-change-status="skipped"], [data-ask="2"] [data-change-status="accepted"]').length, 0);
  await act(async () => (card(3).querySelector("[data-revised-seen]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "seen");
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(q('[data-change-row="fixture-change-4"]')!.getAttribute("data-revised-new"), "true");
  assert.match(q('[data-change-row="fixture-change-4"] [data-revision]')!.textContent!, /Changed.*Raised on your note/);
  // A verdict on one row inside the fold says the same read.
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-label="Skip"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-4:skip");
  assert.deepEqual(seens.pop(), { revised_at: amendedRow.revision.at });

  // ── a records ask at scale (S9 inside S19): one card, the rows paged inside the fold ──
  await render({ proposal: ORG_STAFFING_FIXTURE_BIG_PROPOSAL, proposals: [ORG_STAFFING_FIXTURE_BIG_PROPOSAL], selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /0 of \d+ decided$/);
  assert.equal(card(0).querySelector("[data-ask-title]")!.textContent, "Bring 111 records up to date");
  assert.match(card(0).querySelector("[data-ask-fold]")!.textContent!, /^111 records/);
  assert.equal(qa("[data-change-row]").length, 0);
  await act(async () => (card(0).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(qa("[data-ask-rows] [data-change-row]").length, 25, "a page of rows, not a hundred");
  await act(async () => q<HTMLButtonElement>("[data-ask-show-all]")!.click());
  assert.equal(qa("[data-ask-rows] [data-change-row]").length, 111 - 9, "nine carried tasks nest under their plan instead of standing alone");
  assert.equal(q('[data-change-row="fixture-big-1"] [data-nested-tasks]')!.getAttribute("data-nested-tasks"), "4");
  assert.equal(q("[data-ask-show-all]"), null);
  await act(async () => (card(0).querySelector("[data-ask-accept]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "ask:fixture-proposal-big:0:accept");

  // ── before the change rows land, the header says so ──
  await render({ proposal: { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: [], counts: { total: 12, decided: 3, applied: 1, failed: 1, skipped: 1 } }, selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /loading$/);
  assert.ok(q("[data-changes-loading]"));
  assert.equal(q("[data-cost]"), null);

  // ── supersession (S4): the replaced proposal says so, with Withdraw; the newer says what it replaces ──
  const older = { ...ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, superseded_by: { id: ORG_STAFFING_FIXTURE_PROPOSAL._id, short_id: ORG_STAFFING_FIXTURE_PROPOSAL.short_id, status: "open" as const, created_at: ORG_STAFFING_FIXTURE_PROPOSAL.created_at } };
  const newer = { ...ORG_STAFFING_FIXTURE_PROPOSAL, supersedes: { id: older._id, short_id: older.short_id, status: "open" as const, created_at: older.created_at } };
  await render({ proposal: older, proposals: [older, newer], selectedChangeId: null, onWithdraw: (id: string) => calls.push(`withdraw:${id}`) });
  const replaced = q("[data-superseded-by]")!;
  assert.equal(replaced.getAttribute("data-superseded-by"), "op-7");
  assert.match(replaced.textContent!, /^A newer proposal replaced this one \d+[smhd] ago\. Open itWithdraw$/);
  assert.equal(q("[data-supersedes]"), null);
  await act(async () => q<HTMLButtonElement>("[data-withdraw]")!.click());
  assert.equal(calls.pop(), `withdraw:${older._id}`);
  await act(async () => q<HTMLButtonElement>("[data-superseded-by] button")!.click());
  assert.equal(calls.pop(), "pick:op-7");
  await render({ proposal: { ...older, status: "withdrawn" as const }, proposals: [older, newer], selectedChangeId: null, onWithdraw: () => calls.push("withdraw") });
  assert.ok(q("[data-superseded-by]"));
  assert.equal(q("[data-withdraw]"), null);
  await render({ proposal: newer, proposals: [older, newer], selectedChangeId: null });
  assert.equal(q("[data-superseded-by]"), null);
  assert.match(q("[data-supersedes]")!.textContent!, /Replaces an earlier proposal/);
  // Another open proposal is reachable from the foot, by its title, never a picker.
  assert.match(q("[data-other-proposals]")!.textContent!, /One more proposal is openRetire the ops seat/);
  await act(async () => q<HTMLButtonElement>("[data-other-proposals] button")!.click());
  assert.equal(calls.pop(), "pick:op-8");

  // ── a proposal no agent wrote: the chief's composer, as before ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, hasThread: false });
  assert.ok(q("[data-composer]"));
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-chief-conv");

  // ── S19's test on the first screen: a cold reader, no scrolling ──
  // Every word before the fold, in screen order, checked against the words
  // the glossary exists to define. None may be needed to say what is asked,
  // what it changes, and what to press.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  const firstScreen = [q("[data-asks-header]"), ...qa("[data-ask]")].map((el) => el!.textContent).join("\n");
  console.log("first screen, in order:\n" + firstScreen.replace(/\n/g, "\n  "));
  const needsGlossary = /standing agent|\bscope\b|\bcharter\b|\bwakes?\b|\bhands?\b|\btokens?\b|\bop-\d+|\bseq\b|\bproposal\b|\bchief of staff\b/i;
  const hit = firstScreen.match(needsGlossary);
  assert.equal(hit, null, `the first screen needs the glossary for "${hit?.[0]}"`);
  assert.match(firstScreen, /Accept/);
  assert.match(firstScreen, /Skip/);
  assert.match(firstScreen, /Ask about this/);
  assert.match(firstScreen, /If you accept:/);

  // ── a paused chief of staff is said, with Resume ──
  const pausedTree = { ...chiefTree, roles: chiefTree.roles.map((r) => r.handle === "chief-of-staff" ? { ...r, status: "paused" as const } : r) };
  await render({ proposal: null, selectedChangeId: null, tree: pausedTree, chief: findChiefOfStaff(pausedTree), onResumeChief: (id: string) => calls.push(`resume:${id}`) });
  assert.match(q("[data-chief-paused]")!.textContent!, /Paused: what you send waits until you resume/);
  await act(async () => button("Resume").click());
  assert.equal(calls.pop(), "resume:fixture-role-chief");
  assert.ok(q("[data-thread]"), "the thread still renders under the notice");
  await render({ proposal: null, selectedChangeId: null });
  assert.equal(q("[data-chief-paused]"), null);

  // ── no proposal, a chief: the health summary ──
  await render({ proposal: null, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "health");
  assert.match(text(), /Company health/);
  assert.equal(qa("[data-span] button").length, 2);
  assert.match(qa("[data-span] button")[0].textContent!, /Ashot Petrosian1 \/ 7/);
  assert.equal(qa("[data-bottlenecks] button").length, 1);
  assert.match(qa("[data-bottlenecks] button")[0].textContent!, /@growth/);
  assert.ok(q("[data-thread]"));
  await act(async () => qa("[data-bottlenecks] button")[0].click());
  assert.equal(calls.pop(), "node:role:fixture-role-growth");
  // A flag on a role focuses its node; the finding reads as words.
  assert.match(qa('[data-flag="overloaded"]')[0].textContent!, /more reaching it than it can handle/);
  await act(async () => (qa('[data-flag="overloaded"]')[0] as HTMLButtonElement).click());
  assert.equal(calls.pop(), "node:role:fixture-role-growth");

  // Health missing on this backend says so instead of "no flags".
  await render({ proposal: null, selectedChangeId: null, health: null, healthMissing: true });
  assert.match(text(), /Health is not deployed on this backend yet/);

  // A read that failed with nothing cached says so with a retry, never "no
  // flags"; with a cached copy the flags stay and one line says the read failed.
  await render({ proposal: null, selectedChangeId: null, health: null, healthMissing: false, healthError: "Too many reads in a single function execution", onRetryHealth: () => calls.push("retryHealth") });
  assert.match(text(), /Health could not be read: Too many reads/);
  await act(async () => q<HTMLButtonElement>("[data-health-error] button")!.click());
  assert.equal(calls.pop(), "retryHealth");
  await render({ proposal: null, selectedChangeId: null, healthMissing: false, healthError: "the host is busy" });
  assert.ok(q("[data-health-stale]"));
  assert.ok(q("[data-flags]"));

  // ── no chief of staff: the two buttons, then reviewing ──
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "no_chief");
  await act(async () => button("Hire a Chief of Staff").click());
  assert.equal(calls.pop(), "hire");
  await act(async () => button("Propose an org now").click());
  assert.equal(calls.pop(), "propose");
  assert.equal(q("[data-composer]"), null);
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: true, reviewSessionId: "stub-review-1" });
  assert.ok(q("[data-reviewing]"));
  assert.equal(qa("button").find((b) => b.textContent?.trim() === "Hire a Chief of Staff"), undefined);
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: false, reviewEnded: true, reviewSessionId: "conv-ended" });
  assert.match(q("[data-review-ended]")!.textContent!, /The review session stopped without posting a proposal/);
  assert.ok(qa("button").find((b) => b.textContent?.trim() === "Propose an org now"), "the buttons are back");
  await act(async () => q<HTMLButtonElement>("[data-review-ended] button")!.click());
  assert.equal(calls.pop(), "open:conv-ended");
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: true, reviewSessionId: "stub-review-1" });
  await act(async () => q<HTMLButtonElement>("[data-review-session]")!.click());
  assert.equal(calls.pop(), "open:stub-review-1");

  // ── a link into another workspace: the line alone ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, link: { kind: "foreign", shortId: "op-4", workspaceName: "Codecast", onSwitch: () => calls.push("switch") } });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "link");
  assert.match(q("[data-proposal-link]")!.textContent!, /op-4belongs to Codecast/);
  assert.doesNotMatch(text(), /Split growth, own the platform work/);
  assert.equal(qa("[data-ask]").length, 0);
  await act(async () => button("Switch").click());
  assert.equal(calls.pop(), "switch");
  await render({ proposal: null, selectedChangeId: null, proposals: [], tree: ORG_FIXTURE, chief: null, link: { kind: "unreadable", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /op-99is not a proposal you can read/);
  assert.equal(q("[data-no-chief]"), null, "the hire buttons of the active workspace do not answer a link elsewhere");
  await render({ proposal: null, selectedChangeId: null, proposals: [], link: { kind: "loading", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /looking it up/);

  // ── what an accept takes over, said before it, with the one edit (R1) ──
  // The page reads the counts in one query and hands them in by change id;
  // only a change that would move a session has one.
  const moves = { "fixture-change-1": { phrase: "12 sessions now report to @platform and leave your needs input", count: 12, kept_in_front: 0, over_cap: 0 } };
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, takeovers: moves });
  const holder = qa("[data-ask]").find((el) => el.querySelector("[data-takeover]"));
  assert.ok(holder, "the ask that holds the role change says what accepting it moves");
  assert.equal(qa("[data-ask] [data-takeover]").length, 1, "and no other ask says anything");
  assert.match(holder!.querySelector("[data-takeover-phrase]")!.textContent!, /^12 sessions now report to @platform and leave your needs input\.$/);
  assert.match(holder!.querySelector("[data-takeover]")!.textContent!, /Leave the sessions where they are/);
  const at = holder!.getAttribute("data-ask");
  // Accepted as proposed: no edit rides along.
  await act(async () => holder!.querySelector<HTMLButtonElement>("[data-ask-accept]")!.click());
  assert.equal(calls.pop(), `ask:fixture-proposal-7:${at}:accept`);
  // Ticked: the accept carries the person's one edit.
  await act(async () => holder!.querySelector<HTMLInputElement>("[data-takeover-leave-input]")!.click());
  assert.equal(holder!.querySelector("[data-takeover]")!.getAttribute("data-takeover-leave"), "1");
  await act(async () => holder!.querySelector<HTMLButtonElement>("[data-ask-accept]")!.click());
  assert.equal(calls.pop(), `ask:fixture-proposal-7:${at}:accept:{"leave_sessions":true}`);
  // Inside the fold the row says it too, and its own accept carries the edit.
  await act(async () => holder!.querySelector<HTMLButtonElement>("[data-ask-fold]")!.click());
  const moving = q('[data-change-row="fixture-change-1"]')!;
  assert.match(moving.querySelector("[data-takeover-phrase]")!.textContent!, /12 sessions now report to @platform/);
  await act(async () => moving.querySelector<HTMLInputElement>("[data-takeover-leave-input]")!.click());
  await act(async () => moving.querySelector<HTMLButtonElement>('button[aria-label="Accept"]')!.click());
  assert.equal(calls.pop(), 'decide:fixture-change-1:accept:{"leave_sessions":true}');
  // A row that moves nothing says nothing.
  for (const row of qa("[data-change-row]").filter((r) => r !== moving)) assert.equal(row.querySelector("[data-takeover]"), null);

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("staffing pane mount: passed");
}

if (import.meta.main) await verifyStaffingPane();
