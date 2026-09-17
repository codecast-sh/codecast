// Mounts the staffing pane in jsdom against the fixture proposal and health
// (org-staffing.md S5) and checks the three states: a proposal (header counts,
// flags, grouped change list, accept, skip and edit, rationale, accept all), the
// health summary with no proposal, and the two buttons with no chief of staff.
// Run: bun components/org/StaffingPane.mount.test.tsx
import assert from "node:assert/strict";

async function verifyStaffingPane() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  // The thread embed and the markdown renderer pull the whole store and the
  // message pipeline; the pane only places them.
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  // The author pill (S15) reads the store and the linked session navigation;
  // its own mount test covers it. Here it is the props the pane hands it.
  mock.module("./ProposalAuthorPill", () => ({
    ProposalAuthorPill: ({ author, onOpenSession }: any) => author.kind === "role"
      ? React.createElement("a", { href: `/org/${author.short_id}`, "data-proposal-author": "role" }, author.name)
      : React.createElement("button", { type: "button", "data-proposal-author": author.kind, onClick: () => onOpenSession?.(author.id) }, author.name ?? author.id),
  }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, ORG_STAFFING_FIXTURE_BIG_PROPOSAL } = await import("./orgStaffingFixture");
  const { findChiefOfStaff } = await import("./staffingModel");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const calls: string[] = [];
  const base = {
    tree: chiefTree,
    health: ORG_STAFFING_FIXTURE_HEALTH,
    proposals: [ORG_STAFFING_FIXTURE_PROPOSAL],
    chief: findChiefOfStaff(chiefTree),
    reviewing: false,
    now: Date.now(),
    onSelectChange: (id: string | null) => calls.push(`select:${id}`),
    onDecide: (id: string, verdict: string, edits?: Record<string, unknown>) => calls.push(`decide:${id}:${verdict}${edits ? ":" + JSON.stringify(edits) : ""}`),
    onAcceptAll: (id: string, opts?: { kinds?: string[] }) => calls.push(`acceptAll:${id}${opts?.kinds ? ":" + opts.kinds.join(",") : ""}`),
    onEditRole: (c: any) => calls.push(`editRole:${c._id}`),
    onSelectNode: (id: string) => calls.push(`node:${id}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    onPickProposal: (id: string) => calls.push(`pick:${id}`),
    onHireChief: () => calls.push("hire"),
    onProposeNow: () => calls.push("propose"),
    meId: "fixture-user-me",
    introSeen: false,
    onIntroSeen: () => calls.push("introSeen"),
    onOpenGlossary: (page: string) => calls.push(`glossary:${page}`),
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

  // ── a proposal: header, flags, grouped list, rationale ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "proposal");
  assert.match(text(), /Split growth, own the platform work, budget the reviews/);
  assert.equal(q("[data-progress]")!.textContent, "2 of 8 decided");
  assert.match(text(), /Chief of Staff/);
  // S15: the author is a pill in the header, one click to its scope page.
  assert.equal(q<HTMLAnchorElement>('[data-proposal-author="role"]')?.getAttribute("href"), "/org/or-9");
  assert.equal(q<HTMLAnchorElement>('[data-proposal-author="role"]')?.textContent, "Chief of Staff");
  // S9: the records group comes first, its header counts the records, each
  // row carries the evidence line even unselected.
  assert.deepEqual(qa("[data-change-group]").map((g) => g.getAttribute("data-change-group")), ["sync", "projects", "role", "project_meta", "budget", "routine"]);
  assert.equal(qa("[data-change-row]").length, 8);
  assert.match(q("[data-sync-header]")!.textContent!, /Records to bring up to date/);
  assert.equal(q("[data-sync-count]")!.textContent, "2 records");
  assert.equal(qa("[data-sync-evidence]").length, 2);
  assert.match(q('[data-change-row="fixture-change-7"] [data-sync-evidence]')!.textContent!, /evidenceEvery task closed 19 days ago/);
  assert.equal(qa('[data-change-group="sync"] button[aria-label="Accept"]').length, 2);
  assert.equal(qa('[data-change-group="sync"] button[aria-label="Edit"]').length, 2);
  assert.equal(qa('[data-change-group="sync"] button[aria-label="Skip"]').length, 2);
  // S10: a role change carries its tenure as a chip.
  assert.equal(q('[data-change-row="fixture-change-1"] [data-tenure]')!.getAttribute("data-tenure"), "standing");
  assert.equal(q('[data-change-row="fixture-change-2"] [data-tenure]')!.textContent, "program · ends with pl-88, then review");
  assert.equal(q('[data-change-row="fixture-change-4"] [data-tenure]'), null);
  // S17: the cold read intro over the ask, for a person who has never
  // accepted a change; its link opens the short page; dismiss never returns.
  assert.ok(q("[data-proposal-intro]"));
  assert.match(q("[data-proposal-intro]")!.textContent!, /Nothing moves until you accept a change/);
  await act(async () => q<HTMLButtonElement>("[data-intro-how]")!.click());
  assert.equal(calls.pop(), "glossary:how");
  await act(async () => q<HTMLButtonElement>("[data-intro-dismiss]")!.click());
  assert.equal(calls.pop(), "introSeen");
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, introSeen: true });
  assert.equal(q("[data-proposal-intro]"), null);
  // A person who accepted a change on any proposal in view never sees it either.
  const acceptedByMe = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c.status === "accepted" ? { ...c, decided_by: "fixture-user-me" } : c) };
  await render({ proposal: acceptedByMe, proposals: [acceptedByMe], selectedChangeId: null, introSeen: false });
  assert.equal(q("[data-proposal-intro]"), null);
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  // S17: the plain ask in front, whole (a short one has no fold); no tail,
  // so no control for it. A letter with a tail and an evidence line puts
  // the tail behind a control and the link on the Evidence control.
  assert.equal(q("[data-ask]")!.getAttribute("data-ask"), "open");
  assert.match(q("[data-ask]")!.textContent!, /Two hires, one move and one budget change/);
  assert.equal(q("[data-ask-toggle]"), null);
  assert.equal(q('[data-summary-control="tail"]'), null);
  assert.equal(q('[data-summary-control="evidence"]')!.tagName, "BUTTON");
  const letter = { ...ORG_STAFFING_FIXTURE_PROPOSAL, summary_md: `${ORG_STAFFING_FIXTURE_PROPOSAL.summary_md} ${"And more words to make the ask long enough to fold on a phone. ".repeat(4)}\n\nWhat I looked at: every plan and task under Growth.\n\nEvidence, what could not be verified, findings and escalations: https://codecast.sh/a/fixture` };
  await render({ proposal: letter, selectedChangeId: null });
  assert.equal(q("[data-ask]")!.getAttribute("data-ask"), "folded");
  assert.doesNotMatch(q("[data-ask]")!.textContent!, /What I looked at/);
  await act(async () => q<HTMLButtonElement>("[data-ask-toggle]")!.click());
  assert.equal(q("[data-ask]")!.getAttribute("data-ask"), "open");
  assert.equal(q<HTMLAnchorElement>('[data-summary-control="evidence"]')!.getAttribute("href"), "https://codecast.sh/a/fixture");
  assert.equal(q('[data-summary-detail="tail"]'), null);
  await act(async () => q<HTMLButtonElement>('[data-summary-control="tail"]')!.click());
  assert.match(q('[data-summary-detail="tail"]')!.textContent!, /What I looked at: every plan and task under Growth/);
  assert.doesNotMatch(q('[data-summary-detail="tail"]')!.textContent!, /codecast\.sh\/a\/fixture/);
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  // The groups with counts are the list's own headers: no table about the
  // changes stands between the ask and the first change.
  assert.equal(q("[data-group-summary]"), null);
  assert.equal(q('[data-group-header="role"] [data-group-count]')!.textContent, "2");
  assert.match(q('[data-group-header="role"]')!.getAttribute("title")!, /standing agent/);
  // The detail sits behind three controls: findings closed by default, so no
  // flag row renders until asked; the budget is arithmetic from the tree.
  assert.equal(qa("[data-flag]").length, 0);
  assert.equal(q('[data-summary-control="findings"]')!.textContent, "Findings3");
  await act(async () => q<HTMLButtonElement>('[data-summary-control="budget"]')!.click());
  assert.ok(q('[data-summary-detail="budget"]'));
  assert.match(q("[data-budget-today]")!.textContent!, /tokens$/);
  assert.match(q("[data-budget-lines]")!.textContent!, /@growth/);
  await act(async () => q<HTMLButtonElement>('[data-summary-control="findings"]')!.click());
  assert.equal(q('[data-summary-detail="budget"]'), null);
  // The findings sit above the list, behind their control; in proposal mode
  // only the ones a change addresses show (all on @growth); the company's
  // full list is one click away.
  const order = [...document.querySelectorAll("[data-change-row], [data-flag]")].map((el) => el.hasAttribute("data-flag") ? "flag" : "change");
  assert.equal(order.lastIndexOf("flag") < order.indexOf("change"), true, "findings render above the change list");
  assert.deepEqual(qa("[data-flag]").map((f) => f.getAttribute("data-flag")), ["overloaded", "cap_hit", "review_stall"]);
  // The finding reads as words, not the code's name.
  assert.match(qa('[data-flag="overloaded"]')[0].textContent!, /more reaching it than it can handle/);
  // The glossary is one click from the summary.
  await act(async () => q<HTMLButtonElement>("[data-summary-words]")!.click());
  assert.equal(calls.pop(), "glossary:words");
  assert.equal(q("[data-rationale]"), null);
  assert.match(text(), /Accept all remaining \(6\)/);
  // Only decidable rows carry the action trio.
  assert.equal(qa('[data-change-status="proposed"] button[aria-label="Accept"]').length, 6);
  assert.equal(qa('[data-change-status="accepted"] button[aria-label="Accept"]').length, 0);
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-chief-conv");
  // No kicker over the serif title: the mode sits in the meta line.
  assert.equal(qa("span").some((el) => el.textContent === "review" && /uppercase/.test(el.className)), false);
  assert.match(text(), /Chief of Staff·review·/);
  // The progress strip is a real control, one named button per change.
  const strip = q('[role="group"][aria-label="Changes, one block each"]');
  assert.ok(strip);
  assert.equal(strip!.getAttribute("aria-hidden"), null);
  assert.equal(strip!.querySelectorAll("button[aria-label]").length, 8);
  assert.match(strip!.querySelector("button")!.getAttribute("aria-label")!, /^proposed · Create role/);
  // The session author pill opens the conversation through the pane's navigation.
  await render({ proposal: ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, proposals: [ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_SESSION_PROPOSAL], selectedChangeId: null });
  assert.equal(q('[data-proposal-author="session"]')!.textContent, "Org review, September");
  await act(async () => q<HTMLButtonElement>('[data-proposal-author="session"]')!.click());
  assert.equal(calls.pop(), "open:fixture-conv-review");
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  // The findings control keeps its state across proposals; open it only if
  // an earlier click left it closed.
  if (!q('[data-summary-detail="findings"]')) await act(async () => q<HTMLButtonElement>('[data-summary-control="findings"]')!.click());

  // A flag on a role focuses its node.
  await act(async () => (qa('[data-flag="overloaded"]')[0] as HTMLButtonElement).click());
  assert.equal(calls.pop(), "node:role:fixture-role-growth");
  // The blocker word is spelled out, not hue alone; a company flag is not a button.
  assert.equal(qa('[data-flag="unowned"]').length, 0);
  await act(async () => button("See all 5 findings in the company").click());
  assert.deepEqual(qa("[data-flag]").map((f) => f.getAttribute("data-flag")), ["unowned", "overloaded", "cap_hit", "no_charter", "review_stall"]);
  assert.equal(qa('[data-flag="unowned"]')[0].tagName, "DIV");
  assert.equal(qa('[data-flag="unowned"] [data-severity-tag]')[0]?.textContent, "blocker");
  assert.equal(qa('[data-flag="overloaded"] [data-severity-tag]').length, 0);
  await act(async () => button("Only this proposal's findings").click());

  // Accept, skip, edit, click to focus.
  await act(async () => qa('[data-change-row="fixture-change-1"] button[aria-label="Accept"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-1:accept");
  await act(async () => qa('[data-change-row="fixture-change-2"] button[aria-label="Skip"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-2:skip");
  await act(async () => qa('[data-change-row="fixture-change-1"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "editRole:fixture-change-1");
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-pressed]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-4");

  // The selected change shows its rationale, evidence and risk INLINE under
  // its own row, with worded verdict buttons, so one change is decided
  // without scrolling past the rest of the list.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-4" });
  assert.ok(q("[data-rationale]"));
  assert.ok(q('[data-change-row="fixture-change-4"] [data-rationale]'), "rationale nests inside the selected row");
  assert.match(q("[data-rationale]")!.textContent!, /hit its token cap on four of the last seven days/);
  assert.match(q("[data-rationale]")!.textContent!, /Doubles the role's daily spend ceiling/);
  assert.equal(q<HTMLAnchorElement>('[data-rationale] a[href="/org/or-1?tab=settings"]')?.textContent?.trim(), "4 cap hits in 7 days");
  assert.deepEqual(qa("[data-rationale] [data-verdicts] button").map((b) => b.textContent?.trim()), ["Accept", "Edit", "Skip"]);
  // The selected row's line is not clamped; an unselected line gets two rows
  // (one truncated row hid the role, owner or number) and the full text on hover.
  assert.equal(qa('[data-change-row="fixture-change-4"] .truncate, [data-change-row="fixture-change-4"] .line-clamp-2').length, 0);
  const unselectedLine = q('[data-change-row="fixture-change-1"] .line-clamp-2');
  assert.ok(unselectedLine, "unselected line clamps to two rows");
  assert.equal(unselectedLine!.getAttribute("title"), unselectedLine!.textContent);
  await act(async () => qa("[data-rationale] [data-verdicts] button")[2].click());
  assert.equal(calls.pop(), "decide:fixture-change-4:skip");

  // Edit on a budget change is the inline form; accept with edits carries them.
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

  // Edit on a record change (S9): the status is a closed set, the evidence a line.
  await act(async () => qa('[data-change-row="fixture-change-7"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-7");
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-7" });
  const statusSelect = q<HTMLSelectElement>('[data-edit-form] select[data-edit-select="status"]');
  assert.ok(statusSelect, "record status select");
  assert.deepEqual([...statusSelect!.options].map((o) => o.value), ["done", "abandoned", "active"]);
  await act(async () => {
    statusSelect!.value = "abandoned";
    statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => q("[data-edit-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.pop(), 'decide:fixture-change-7:accept:{"status":"abandoned"}');

  // Accept all is a two step: confirm then the action; the copy names the real apply order.
  await act(async () => button("Accept all remaining (6)").click());
  assert.match(text(), /records first, then projects and plans, then the agents, their areas and their limits/);
  await act(async () => button("Accept 6").click());
  assert.equal(calls.pop(), "acceptAll:fixture-proposal-7");

  // ── supersession (S4): the replaced proposal leads with the line and Withdraw; the newer says Replaces ──
  const older = { ...ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, superseded_by: { id: ORG_STAFFING_FIXTURE_PROPOSAL._id, short_id: ORG_STAFFING_FIXTURE_PROPOSAL.short_id, status: "open" as const, created_at: ORG_STAFFING_FIXTURE_PROPOSAL.created_at } };
  const newer = { ...ORG_STAFFING_FIXTURE_PROPOSAL, supersedes: { id: older._id, short_id: older.short_id, status: "open" as const, created_at: older.created_at } };
  await render({ proposal: older, proposals: [older, newer], selectedChangeId: null, onWithdraw: (id: string) => calls.push(`withdraw:${id}`) });
  const replaced = q("[data-superseded-by]")!;
  assert.equal(replaced.getAttribute("data-superseded-by"), "op-7");
  assert.match(replaced.textContent!, /^Replaced by op-7, posted \d+[smhd] ago\.Withdraw$/);
  // The line comes before the title, and the title is still there.
  assert.equal(replaced.compareDocumentPosition(q("h2")!) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(q("[data-supersedes]"), null);
  await act(async () => q<HTMLButtonElement>("[data-withdraw]")!.click());
  assert.equal(calls.pop(), `withdraw:${older._id}`);
  await act(async () => q<HTMLButtonElement>("[data-superseded-by] button")!.click());
  assert.equal(calls.pop(), "pick:op-7");
  // Withdrawn already: the line stays (it says what happened), the button goes.
  await render({ proposal: { ...older, status: "withdrawn" as const }, proposals: [older, newer], selectedChangeId: null, onWithdraw: () => calls.push("withdraw") });
  assert.ok(q("[data-superseded-by]"));
  assert.equal(q("[data-withdraw]"), null);
  // The newer proposal says what it replaces, under its title.
  await render({ proposal: newer, proposals: [older, newer], selectedChangeId: null });
  assert.equal(q("[data-superseded-by]"), null);
  assert.match(q("[data-supersedes]")!.textContent!, /Replaces op-8/);
  assert.equal(q("h2")!.compareDocumentPosition(q("[data-supersedes]")!) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => q<HTMLButtonElement>("[data-supersedes] button")!.click());
  assert.equal(calls.pop(), "pick:op-8");
  await render({ proposal: { ...newer, supersedes: { ...newer.supersedes, status: "withdrawn" as const } }, proposals: [older, newer], selectedChangeId: null });
  assert.match(q("[data-supersedes]")!.textContent!, /Replaces op-8 · withdrawn/);

  // ── a records group at scale (S9): one card, Accept group, Review each ──
  await render({ proposal: ORG_STAFFING_FIXTURE_BIG_PROPOSAL, proposals: [ORG_STAFFING_FIXTURE_BIG_PROPOSAL], selectedChangeId: null });
  assert.equal(q("[data-progress]")!.textContent, "0 of 129 decided");
  assert.equal(q("[data-sync-count]")!.textContent, "111 records");
  assert.ok(q("[data-sync-card]"), "a group of 111 renders as one card");
  assert.equal(qa('[data-change-group="sync"] [data-change-row]').length, 0, "no rows behind the card");
  assert.equal(q("[data-sync-count-line]")!.textContent, "103 tasks, 8 plans");
  assert.equal(qa("[data-sync-top-row]").length, 3);
  assert.match(qa("[data-sync-top-row]")[0].textContent!, /Mark plan pl-501 done · closes 4 tasks/);
  assert.match(q("[data-sync-evidence-summary]")!.textContent!, /^evidence\d+ [a-z ]+· \d+ /);
  assert.match(q("[data-sync-evidence-summary]")!.textContent!, /\d+ commits landed/);
  // The rest of the proposal is still rows.
  assert.equal(qa('[data-change-group="file"] [data-change-row]').length, 10);
  // A top line focuses that change.
  await act(async () => qa("[data-sync-top-row]")[1].click());
  assert.equal(calls.pop(), "select:fixture-big-2");
  // Accept group: a confirm, then accept all narrowed to the record kinds.
  await act(async () => q<HTMLButtonElement>("[data-sync-accept-group]")!.click());
  assert.match(q("[data-sync-confirm]")!.textContent!, /Bring the 111 remaining records up to date now: 103 tasks, 8 plans/);
  await act(async () => button("Accept 111").click());
  assert.equal(calls.pop(), "acceptAll:fixture-proposal-big:plan_status,task_status,project_status");
  // Review each: the rows, carried tasks nested under their plan, a way back.
  await act(async () => q<HTMLButtonElement>("[data-sync-review-each]")!.click());
  assert.equal(q("[data-sync-card]"), null);
  assert.equal(qa('[data-change-group="sync"] [data-change-row]').length, 111 - 9, "nine carried tasks nest instead of standing alone");
  assert.equal(q('[data-change-row="fixture-big-1"] [data-nested-tasks]')!.getAttribute("data-nested-tasks"), "4");
  assert.equal(qa('[data-change-row="fixture-big-1"] [data-nested-task]').length, 3, "three shown unselected, the rest counted");
  assert.match(q('[data-change-row="fixture-big-1"] [data-nested-tasks]')!.textContent!, /and 1 more/);
  assert.equal(q('[data-change-row="fixture-big-9"]'), null, "ct-9001's own row is gone");
  await render({ proposal: ORG_STAFFING_FIXTURE_BIG_PROPOSAL, proposals: [ORG_STAFFING_FIXTURE_BIG_PROPOSAL], selectedChangeId: "fixture-big-1" });
  assert.equal(qa('[data-change-row="fixture-big-1"] [data-nested-task]').length, 4, "selected shows every carried task");
  await act(async () => q<HTMLButtonElement>("[data-sync-collapse]")!.click());
  assert.ok(q("[data-sync-card]"), "back to the summary");
  // The small group of the ordinary fixture stays rows.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  assert.equal(q("[data-sync-card]"), null);
  assert.equal(qa('[data-change-group="sync"] [data-change-row]').length, 2);

  // ── a failed change stays decidable (the server's DECIDABLE set) ──
  const withFailed = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c._id === "fixture-change-4" ? { ...c, status: "failed" as const, applied_note: "handle growth is taken" } : c) };
  await render({ proposal: withFailed, selectedChangeId: null });
  assert.equal(q("[data-progress]")!.textContent, "2 of 8 decided", "a failed row is not decided");
  assert.match(text(), /Accept all remaining \(6\)/);
  assert.equal(qa('[data-change-status="failed"] button[aria-label="Accept"]').length, 1);
  assert.equal(q('[data-change-status="failed"] [data-failed-note]')!.textContent, "handle growth is taken");
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-label="Skip"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-4:skip");
  await render({ proposal: withFailed, selectedChangeId: "fixture-change-4" });
  assert.match(q("[data-rationale]")!.textContent!, /failedhandle growth is taken/);
  assert.equal(qa("[data-rationale] [data-verdicts] button")[0].textContent?.trim(), "Retry");
  await act(async () => qa("[data-rationale] [data-verdicts] button")[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-4:accept");

  // ── before the change rows land, the list row's counts stand in ──
  await render({ proposal: { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: [], counts: { total: 12, decided: 3, applied: 1, failed: 1, skipped: 1 } }, selectedChangeId: null });
  assert.equal(q("[data-progress]")!.textContent, "2 of 12 decided");
  assert.ok(q("[data-progress-loading]"));
  assert.match(q("[data-changes-loading]")!.textContent!, /Loading the 12 changes/);

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

  // Health missing on this backend says so instead of "no flags".
  await render({ proposal: null, selectedChangeId: null, health: null, healthMissing: true });
  assert.match(text(), /Health is not deployed on this backend yet/);

  // A read that failed with nothing cached says so with a retry, never "no
  // flags"; with a cached copy the flags stay and one line says the read failed.
  await render({ proposal: null, selectedChangeId: null, health: null, healthMissing: false, healthError: "Too many reads in a single function execution", onRetryHealth: () => calls.push("retryHealth") });
  assert.match(text(), /Health could not be read: Too many reads/);
  assert.doesNotMatch(text(), /Nothing is flagged\. Every role is inside its limits/);
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
  // A review that stopped with nothing posted says so, keeps the way in, and gives the buttons back.
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: false, reviewEnded: true, reviewSessionId: "conv-ended" });
  assert.match(q("[data-review-ended]")!.textContent!, /The review session stopped without posting a proposal/);
  assert.ok(qa("button").find((b) => b.textContent?.trim() === "Propose an org now"), "the buttons are back");
  await act(async () => q<HTMLButtonElement>("[data-review-ended] button")!.click());
  assert.equal(calls.pop(), "open:conv-ended");
  await render({ proposal: null, selectedChangeId: null, reviewing: false, reviewEnded: true, reviewSessionId: "conv-ended" });
  assert.ok(q("[data-review-ended]"), "the health summary says it too");
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: true, reviewSessionId: "stub-review-1" });
  // The review session is one click away while it works.
  await act(async () => q<HTMLButtonElement>("[data-review-session]")!.click());
  assert.equal(calls.pop(), "open:stub-review-1");

  // ── a link into another workspace: the line alone, never another proposal
  // and never the active workspace's body ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, link: { kind: "foreign", shortId: "op-4", workspaceName: "Codecast", onSwitch: () => calls.push("switch") } });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "link");
  assert.equal(q("[data-proposal-link]")!.getAttribute("data-proposal-link"), "foreign");
  assert.match(q("[data-proposal-link]")!.textContent!, /op-4belongs to Codecast/);
  assert.doesNotMatch(text(), /Split growth, own the platform work/);
  assert.equal(qa("[data-change-row]").length, 0);
  assert.equal(q("[data-composer]"), null);
  assert.equal(q("[data-no-chief]"), null);
  await act(async () => button("Switch").click());
  assert.equal(calls.pop(), "switch");
  await render({ proposal: null, selectedChangeId: null, proposals: [], tree: ORG_FIXTURE, chief: null, link: { kind: "unreadable", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /op-99is not a proposal you can read/);
  assert.doesNotMatch(text(), /Split growth, own the platform work/);
  assert.equal(qa("[data-change-row]").length, 0);
  assert.equal(q("[data-no-chief]"), null, "the hire buttons of the active workspace do not answer a link elsewhere");
  await render({ proposal: null, selectedChangeId: null, proposals: [], link: { kind: "loading", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /looking it up/);

  await act(async () => root.unmount());
  dom.window.close();
  console.log("staffing pane mount: passed");
}

if (import.meta.main) await verifyStaffingPane();
