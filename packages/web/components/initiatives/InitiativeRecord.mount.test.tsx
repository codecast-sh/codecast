// The intent record on a goal's page
// (docs/architecture/initiatives-projects-role-page.md I5), mounted in jsdom
// against the typed fixture. Proves: the sections stand in the order of the
// test a goal must pass; milestones read in day order with the reached, the
// next and the late ones marked, and reaching one moves the mark; an answer
// closes a question and folds it away; decisions read newest first with who
// and where; a source typed as "ct-12 said so" lands as a task source with
// its words; why saves on Cmd+Enter and Escape cancels; every entry is edited
// in its own row (a milestone's day moves and keeps its key and source); a
// source says who said it with a face and a note shows its words; a draft or
// an open form never follows the sheet to another goal; and a goal with no
// record draws none of its parts, only the row that starts one, with no
// sentence saying a part is empty. Why is mounted above the record the way a
// goal's sheet draws it, and capped, it shows Read all only where it is cut.
// Run: bun test components/initiatives/InitiativeRecord.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { InitiativeRecordOp } from "../../store/initiativeRecord";
import type { OrgTree } from "../org/orgTypes";

async function verifyRecord() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // ── the world the record reads ──
  const { ORG_FIXTURE } = await import("../org/orgFixture");
  const fx = await import("./initiativeFixture");
  const { settleRecordOp } = await import("../../store/initiativeRecord");
  const tree = ORG_FIXTURE as OrgTree;
  const calls: string[] = [];
  let rows: InitiativeRow[] = fx.FIXTURE_INITIATIVES.map((r) => ({ ...r }));
  const patch = (id: string, fields: Partial<InitiativeRow>) => { rows = rows.map((r) => (r._id === id ? { ...r, ...fields } : r)); };
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot" },
    orgTree: tree,
    // The mount's stand-ins do what the slice's actions do to the draft
    // (store/initiativeSlice.ts, proven on the real store in initiativeRecord.test.ts).
    updateInitiative: (id: string, fields: any) => { calls.push(`update:${id}:${JSON.stringify(fields)}`); patch(id, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? undefined]))); },
    recordInitiativeEntry: (id: string, op: InitiativeRecordOp) => {
      calls.push(`record:${id}:${JSON.stringify(op)}`);
      const row = rows.find((r) => r._id === id)!;
      const settled = settleRecordOp(row[op.list] ?? [], op, { by: "Ashot", now: fx.FIXTURE_NOW });
      if (settled) patch(id, { [op.list]: settled.next.length ? settled.next : undefined });
    },
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realOrgRoles = { ...(await import("../../hooks/useOrgRoles")) };
  mock.module("../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: tree.roles, workspace: tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => [{ _id: "fixture-user-me", name: "Ashot" }, { _id: "fixture-user-sam", name: "Sam" }] }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realAssignee = { ...(await import("../identity/AssigneeFace")) };
  mock.module("../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: any) => React.createElement("div", { "data-markdown": true }, content) }));

  const { createRoot } = await import("react-dom/client");
  const { InitiativeRecord, Written } = await import("./InitiativeRecord");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const attrs = (sel: string, name: string) => qa(sel).map((el) => el.getAttribute(name));
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    const proto = el instanceof (dom.window as any).HTMLTextAreaElement ? (dom.window as any).HTMLTextAreaElement.prototype : (dom.window as any).HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  };
  const press = async (el: Element | null, key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => {
    assert.ok(el, "missing field");
    await act(async () => { el.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); });
  };
  let shown = "init-org";
  // The page paints from the store: after a write, the row it is handed is the store's.
  // As a goal's sheet draws it: Why, then the record, the two keyed by the goal.
  const paint = async () => {
    const goal = rows.find((r) => r._id === shown)!;
    await act(async () => root.render(React.createElement(React.Fragment, { key: goal._id },
      React.createElement(Written, { initiative: goal, field: "why", label: "Why", rows: 4, markdown: true, fallback: goal.description, placeholder: "" }),
      React.createElement(InitiativeRecord, { initiative: goal, now: fx.FIXTURE_NOW }))));
  };
  const mount = async (id: string) => {
    shown = id;
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await paint();
  };
  const last = () => calls[calls.length - 1];

  // ── the order of the test a goal must pass ──
  await mount("init-org");
  assert.deepEqual(attrs("[data-initiative-section]", "data-initiative-section"), ["why", "done_when", "milestones", "questions", "decisions", "sources"]);
  assert.match(q("[data-initiative-section='why'] [data-markdown]")!.textContent!, /routing work that an agent could route/);
  assert.match(q("[data-initiative-section='done_when']")!.textContent!, /Every project has a lead that is an agent/);

  // ── milestones: day order, the reached ones kept, the late one red and next ──
  assert.deepEqual(attrs("[data-initiative-milestone-row]", "data-initiative-milestone-row"), ["org_chart_live", "roles_own_tasks", "scope_view_ships", "every_area_has_a_lead", "a_person_reads_one_page"]);
  assert.deepEqual(attrs("[data-initiative-milestone-row]", "data-milestone-state"), ["reached", "reached", "late", "ahead", "ahead"]);
  assert.deepEqual(attrs("[data-milestone-next]", "data-initiative-milestone-row"), ["scope_view_ships"], "the first one not reached is the next, late or not");
  assert.match(q("[data-initiative-milestone-row='org_chart_live'] [data-initiative-milestone-date]")!.textContent!, /^reached Aug 28$/);
  assert.equal(q("[data-initiative-milestone-row='org_chart_live'] [data-intent-source]")!.getAttribute("data-intent-source"), "plan");
  assert.match(q("[data-initiative-milestone-row='scope_view_ships']")!.textContent!, /overdue/);
  assert.equal(q("[data-initiative-milestone-counts]")!.textContent, "2 of 5 reached");

  // Reaching it marks it done and hands the mark to the one after.
  await click(q("[data-initiative-milestone-row='scope_view_ships'] [data-initiative-milestone-reach]"));
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "milestones", action: "close", key: "scope_view_ships" })}`);
  await paint();
  assert.deepEqual(attrs("[data-initiative-milestone-row]", "data-milestone-state"), ["reached", "reached", "reached", "next", "ahead"]);
  assert.deepEqual(attrs("[data-milestone-next]", "data-initiative-milestone-row"), ["every_area_has_a_lead"]);
  assert.equal(q("[data-initiative-milestone-counts]")!.textContent, "3 of 5 reached");

  // Add: a title and an optional day, keyed by its words.
  await click(q("[data-initiative-add='milestones']"));
  await type(q("[data-initiative-form='milestones'] [data-field='title']"), "Weekly review reads itself");
  await type(q("[data-initiative-form='milestones'] [data-field='date']"), "2026-10-30");
  await press(q("[data-initiative-form='milestones'] [data-field='title']"), "Enter");
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "milestones", action: "add", entry: { title: "Weekly review reads itself", date: Date.UTC(2026, 9, 30, 23, 59, 59, 999) } })}`);
  await paint();
  assert.equal(q("[data-initiative-form='milestones']"), null, "the form closes");
  assert.ok(q("[data-initiative-milestone-row='weekly_review_reads_itself']"));
  // Remove takes it off by key.
  await click(q("[data-initiative-milestone-row='weekly_review_reads_itself'] [data-initiative-remove]"));
  await paint();
  assert.equal(q("[data-initiative-milestone-row='weekly_review_reads_itself']"), null);

  // ── questions: open first, each with who asked; answered ones folded away ──
  assert.deepEqual(attrs("[data-question-state='open']", "data-initiative-question"), ["who_leads_the_inbox_project", "does_the_review_run_weekly_or_daily"]);
  assert.ok(q("[data-initiative-question='who_leads_the_inbox_project'] [data-face='person:Ashot']"), "a name the roster knows wears its face");
  assert.ok(q("[data-initiative-question='does_the_review_run_weekly_or_daily'] [data-face='role:growth']"), "an @handle that is a role wears the role's");
  assert.deepEqual(attrs("[data-initiative-answered] [data-question-state='answered']", "data-initiative-question"), ["do_agent_seats_bill_separately"]);
  assert.match(q("[data-initiative-answered] summary")!.textContent!, /1 answered/);
  assert.match(q("[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-answer]")!.textContent!, /Billing has its own/);

  // An answer closes the question, in place.
  await click(q("[data-initiative-question='who_leads_the_inbox_project'] [data-initiative-answer-open]"));
  await type(q("[data-initiative-form='answer'] input"), "The growth lead, from Monday");
  await click(q("[data-initiative-form='answer'] [data-initiative-form-submit]"));
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "questions", action: "close", key: "who_leads_the_inbox_project", answer: "The growth lead, from Monday" })}`);
  await paint();
  assert.deepEqual(attrs("[data-question-state='open']", "data-initiative-question"), ["does_the_review_run_weekly_or_daily"]);
  assert.equal(q("[data-initiative-question='who_leads_the_inbox_project']")!.getAttribute("data-question-state"), "answered");
  assert.match(q("[data-initiative-question='who_leads_the_inbox_project'] [data-initiative-answer]")!.textContent!, /The growth lead, from Monday/);
  assert.match(q("[data-initiative-answered] summary")!.textContent!, /2 answered/);

  // ── decisions: newest first, who decided, when and where ──
  assert.deepEqual(attrs("[data-initiative-decision]", "data-initiative-decision"), ["the_head_of_people_is_the_root_seat", "roles_are_colleagues"]);
  const newest = q("[data-initiative-decision='the_head_of_people_is_the_root_seat']")!;
  assert.ok(newest.querySelector("[data-face='person:Ashot']"));
  assert.match(newest.textContent!, /Sep 4/);
  assert.equal(newest.querySelector("[data-intent-source]")!.getAttribute("data-intent-source"), "call");
  assert.match(newest.querySelector("a")!.getAttribute("href")!, /cl-42/);

  // ── sources: who said it and where, the words under it ──
  assert.deepEqual(attrs("[data-initiative-source]", "data-initiative-source"), ["call:cl-42:15", "note:agents should run the routine work by the end of the year."]);
  assert.match(q("[data-initiative-source='call:cl-42:15'] [data-initiative-source-quote]")!.textContent!, /I read one page/);
  // Who said it wears the roster's face, the way a question's asker does; the address is the link alone.
  const callSource = q("[data-initiative-source='call:cl-42:15']")!;
  assert.ok(callSource.querySelector("[data-initiative-by='face'] [data-face='person:Ashot']"));
  assert.equal(callSource.querySelector("[data-intent-source]")!.textContent, "Call cl-42, line 15");
  assert.match(callSource.textContent!, /Aug 21/);
  // A note has no address: who said it, then its words, never the bare word "Note".
  const noteSource = q("[data-initiative-source^='note:']")!;
  assert.ok(noteSource.querySelector("[data-face='person:Sam']"));
  assert.equal(noteSource.querySelector("[data-intent-source]"), null);
  assert.doesNotMatch(noteSource.textContent!, /Note/);
  assert.match(noteSource.querySelector("[data-initiative-source-quote]")!.textContent!, /Agents should run the routine work/);
  // One field takes an address or words; "ct-12 said so" is a task source with its words.
  await click(q("[data-initiative-add='sources']"));
  await type(q("[data-initiative-form='sources'] [data-field='text']"), "ct-12 said so");
  await type(q("[data-initiative-form='sources'] [data-field='by']"), "Sam");
  await click(q("[data-initiative-form='sources'] [data-initiative-form-submit]"));
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "sources", action: "add", entry: { text: "ct-12 said so", by: "Sam" } })}`);
  await paint();
  const added = q("[data-initiative-source='task:ct-12']")!;
  assert.ok(added, "read as a task");
  assert.equal(added.querySelector("[data-intent-source]")!.getAttribute("data-intent-source"), "task");
  assert.equal(added.querySelector("[data-initiative-source-quote]")!.textContent, "said so");
  assert.deepEqual(rows.find((r) => r._id === "init-org")!.sources![2], { by: "Sam", kind: "task", quote: "said so", ref: "ct-12" });

  // ── every entry is edited in its own row: Enter saves what changed, Escape cancels ──
  // A milestone slips: its day moves, and it keeps its key, its title and where it was stated.
  const withSource = () => rows.find((r) => r._id === "init-org")!.milestones!.find((m) => m.key === "org_chart_live")!;
  await click(q("[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]"));
  const editTitle = q<HTMLInputElement>("[data-initiative-form='edit-milestones'] [data-field='title']")!;
  assert.equal(editTitle.value, "Org chart live", "the form opens on the entry's own words");
  assert.equal(q<HTMLInputElement>("[data-initiative-form='edit-milestones'] [data-field='date']")!.value, "2026-08-29", "and its own day");
  await type(q("[data-initiative-form='edit-milestones'] [data-field='date']"), "2026-11-15");
  await press(editTitle, "Enter");
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "milestones", action: "edit", key: "org_chart_live", entry: { date: Date.UTC(2026, 10, 15, 23, 59, 59, 999) } })}`, "only what changed is sent");
  await paint();
  assert.equal(q("[data-initiative-form='edit-milestones']"), null, "the form closes");
  assert.deepEqual({ ...withSource(), done_at: 0 }, { date: Date.UTC(2026, 10, 15, 23, 59, 59, 999), done_at: 0, key: "org_chart_live", source: { kind: "plan", ref: "pl-600" }, title: "Org chart live" });
  // Escape leaves it as it was; an emptied day clears it; a save that changed nothing writes nothing.
  let writes = calls.length;
  await click(q("[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]"));
  await type(q("[data-initiative-form='edit-milestones'] [data-field='title']"), "Something else");
  await press(q("[data-initiative-form='edit-milestones'] [data-field='title']"), "Escape");
  assert.equal(q("[data-initiative-form='edit-milestones']"), null);
  await click(q("[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]"));
  await press(q("[data-initiative-form='edit-milestones'] [data-field='title']"), "Enter");
  assert.equal(calls.length, writes, "neither Escape nor an unchanged save writes");
  await click(q("[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]"));
  await type(q("[data-initiative-form='edit-milestones'] [data-field='title']"), "The org chart is live");
  await type(q("[data-initiative-form='edit-milestones'] [data-field='date']"), "");
  await click(q("[data-initiative-form='edit-milestones'] [data-initiative-form-submit]"));
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "milestones", action: "edit", key: "org_chart_live", entry: { title: "The org chart is live", date: null } })}`);
  await paint();
  assert.equal(withSource().date, undefined);
  assert.match(q("[data-initiative-milestone-row='org_chart_live']")!.textContent!, /The org chart is live/);
  // A question's words, open or answered, and a decision's.
  await click(q("[data-initiative-question='does_the_review_run_weekly_or_daily'] [data-initiative-edit-entry]"));
  assert.equal(q<HTMLInputElement>("[data-initiative-form='edit-questions'] [data-field='text']")!.value, "Does the review run weekly or daily?");
  await type(q("[data-initiative-form='edit-questions'] [data-field='text']"), "Does the review run weekly?");
  await press(q("[data-initiative-form='edit-questions'] [data-field='text']"), "Enter");
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "questions", action: "edit", key: "does_the_review_run_weekly_or_daily", entry: { text: "Does the review run weekly?" } })}`);
  await paint();
  const reworded = q("[data-initiative-question='does_the_review_run_weekly_or_daily']")!;
  assert.match(reworded.textContent!, /Does the review run weekly\?/);
  assert.ok(reworded.querySelector("[data-face='role:growth']"), "who asked it stays");
  assert.equal(reworded.querySelector("[data-intent-source]")!.getAttribute("data-intent-source"), "session", "and so does where");
  await click(q("[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-edit-entry]"));
  assert.equal(q<HTMLInputElement>("[data-initiative-form='edit-questions'] [data-field='answer']")!.value, "Not in this goal. Billing has its own.");
  await type(q("[data-initiative-form='edit-questions'] [data-field='answer']"), "Billing has its own goal.");
  await press(q("[data-initiative-form='edit-questions'] [data-field='answer']"), "Enter");
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "questions", action: "edit", key: "do_agent_seats_bill_separately", entry: { answer: "Billing has its own goal." } })}`);
  await paint();
  assert.equal(q("[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-answer]")!.textContent, "Billing has its own goal.");
  await click(q("[data-initiative-decision='roles_are_colleagues'] [data-initiative-edit-entry]"));
  await type(q("[data-initiative-form='edit-decisions'] [data-field='text']"), "Roles are colleagues.");
  await press(q("[data-initiative-form='edit-decisions'] [data-field='text']"), "Enter");
  assert.equal(last(), `record:init-org:${JSON.stringify({ list: "decisions", action: "edit", key: "roles_are_colleagues", entry: { text: "Roles are colleagues." } })}`);
  await paint();
  assert.match(q("[data-initiative-decision='roles_are_colleagues']")!.textContent!, /Roles are colleagues\.Head of Growth/);
  // A source is read whole from its text: the form opens on its address and words, and who said it can be put right.
  await click(q("[data-initiative-source='call:cl-42:15'] [data-initiative-edit-entry]"));
  assert.equal(q<HTMLInputElement>("[data-initiative-form='edit-sources'] [data-field='text']")!.value, "call:cl-42:15 Every area should have a lead that is an agent, and I read one page.");
  await type(q("[data-initiative-form='edit-sources'] [data-field='by']"), "Sam");
  await press(q("[data-initiative-form='edit-sources'] [data-field='by']"), "Enter");
  await paint();
  assert.deepEqual(rows.find((r) => r._id === "init-org")!.sources![0], { at: fx.FIXTURE_NOW - 28 * 86_400_000, by: "Sam", kind: "call", quote: "Every area should have a lead that is an agent, and I read one page.", ref: "cl-42:15" });
  assert.ok(q("[data-initiative-source='call:cl-42:15'] [data-face='person:Sam']"));
  // A decision whose "where" is plain words keeps them on the page.
  await click(q("[data-initiative-add='decisions']"));
  await type(q("[data-initiative-form='decisions'] [data-field='text']"), "Brokers go first");
  await type(q("[data-initiative-form='decisions'] [data-field='source']"), "on the Monday standup");
  await click(q("[data-initiative-form='decisions'] [data-initiative-form-submit]"));
  await paint();
  assert.equal(q("[data-initiative-decision='brokers_go_first'] [data-intent-source='note']")!.textContent, "on the Monday standup");

  // ── the record belongs to its goal: nothing typed follows the page to another ──
  // The page keeps one element across goals (the route is /initiatives/:id), so this paints the next goal over the first.
  await click(q("[data-initiative-edit='why']"));
  await type(q("[data-initiative-field='why']"), "A draft about the first goal");
  await click(q("[data-initiative-add='milestones']"));
  await type(q("[data-initiative-form='milestones'] [data-field='title']"), "A milestone of the first goal");
  await click(q("[data-initiative-add='questions']"));
  await click(q("[data-initiative-add='sources']"));
  writes = calls.length;
  shown = "init-org-sub";
  await paint();
  assert.equal(q("[data-initiative-record]")!.getAttribute("data-initiative-record"), "in-2");
  assert.equal(q("[data-initiative-field='why']"), null, "the first goal's draft is not open on the second");
  assert.deepEqual(attrs("[data-initiative-form]", "data-initiative-form"), [], "nor is any of its forms");
  assert.equal(document.body.textContent!.includes("A draft about the first goal"), false);
  // Writing on the second goal starts from the second goal's own words and lands on it.
  await click(q("[data-initiative-edit='why']"));
  assert.equal(q<HTMLTextAreaElement>("[data-initiative-field='why']")!.value, rows.find((r) => r._id === "init-org-sub")!.why ?? "");
  await type(q("[data-initiative-field='why']"), "Why the second goal matters");
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.equal(last(), `update:init-org-sub:${JSON.stringify({ why: "Why the second goal matters" })}`);
  assert.equal(calls.length, writes + 1, "and nothing was written to the first");
  shown = "init-org";
  await paint();

  // ── why: edited in place; Cmd+Enter saves, Escape cancels ──
  await click(q("[data-initiative-edit='why']"));
  await type(q("[data-initiative-field='why']"), "  Because a person should read one page.  ");
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.equal(last(), `update:init-org:${JSON.stringify({ why: "Because a person should read one page." })}`);
  await paint();
  assert.equal(q("[data-initiative-field='why']"), null, "the editor closes");
  assert.equal(q("[data-initiative-section='why'] [data-markdown]")!.textContent, "Because a person should read one page.");
  const before = calls.length;
  await click(q("[data-initiative-edit='done_when']"));
  await type(q("[data-initiative-field='done_when']"), "Something else");
  await press(q("[data-initiative-field='done_when']"), "Escape");
  assert.equal(q("[data-initiative-field='done_when']"), null);
  assert.equal(calls.length, before, "Escape writes nothing");
  // Emptying it clears the field.
  await click(q("[data-initiative-edit='done_when']"));
  await type(q("[data-initiative-field='done_when']"), "   ");
  await press(q("[data-initiative-field='done_when']"), "Enter", { ctrlKey: true });
  assert.equal(last(), `update:init-org:${JSON.stringify({ done_when: null })}`);

  // ── a goal with no record: no part drawn, no sentence about an empty one ──
  await mount("init-orphan");
  assert.deepEqual(attrs("[data-initiative-section]", "data-initiative-section"), ["why"], "Why with the word that writes it, and nothing else");
  assert.match(q("[data-initiative-section='why']")!.textContent!, /^Why\s*Write$/);
  assert.deepEqual(attrs("[data-initiative-add-part]", "data-initiative-add-part"), ["done_when", "milestones", "questions", "decisions", "sources"]);
  assert.doesNotMatch(document.body.textContent!, /Nobody|No milestones|Nothing is waiting|No decisions/);
  assert.equal(document.querySelectorAll("p.italic, .italic").length, 0, "no column of italics");
  assert.equal(q("[data-initiative-answered]"), null);
  assert.equal(q("[data-initiative-milestone-counts]"), null);
  // Starting a part opens it with its form ready, and the row stops offering it.
  await click(q("[data-initiative-add-part='milestones']"));
  assert.deepEqual(attrs("[data-initiative-section]", "data-initiative-section"), ["why", "milestones"]);
  assert.ok(q("[data-initiative-form='milestones']"), "the form is open");
  assert.deepEqual(attrs("[data-initiative-add-part]", "data-initiative-add-part"), ["done_when", "questions", "decisions", "sources"]);
  // A description stands in for an unwritten why, and the editor still writes why.
  rows = rows.map((r) => (r._id === "init-orphan" ? { ...r, description: "Phones do what the desktop does." } : r));
  await paint();
  assert.equal(q("[data-initiative-section='why'] [data-markdown]")!.textContent, "Phones do what the desktop does.");
  await click(q("[data-initiative-edit='why']"));
  await type(q("[data-initiative-field='why']"), "Half the team reads on a phone.");
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.equal(last(), `update:init-orphan:${JSON.stringify({ why: "Half the team reads on a phone." })}`);

  // ── a capped Why: held to a glance with Read all, only where the words are cut ──
  // jsdom lays nothing out, so the clamp box reports how tall its words run.
  let runs = 400;
  const proto = (dom.window as any).HTMLElement.prototype;
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.parentElement?.hasAttribute("data-clamped") ? runs : 0; } });
  const capped = async () => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(React.createElement(Written, { initiative: rows.find((r) => r._id === "init-org")!, field: "why", label: "Why", rows: 4, markdown: true, clamp: true, placeholder: "" })));
  };
  await capped();
  assert.equal(q("[data-clamped]")!.getAttribute("data-clamped"), "cut");
  assert.equal(q("[data-clamp-toggle]")!.textContent, "Read all");
  await click(q("[data-clamp-toggle]"));
  assert.equal(q("[data-clamped]")!.getAttribute("data-clamped"), "open", "Read all lifts the cap");
  assert.equal(q("[data-clamp-toggle]")!.textContent, "Show less");
  assert.ok(q("[data-initiative-edit='why']"), "Edit stays in the section head");
  runs = 0;
  await capped();
  assert.equal(q("[data-clamped]")!.getAttribute("data-clamped"), "whole");
  assert.equal(q("[data-clamp-toggle]"), null, "words that fit get no toggle");
  delete proto.scrollHeight;

  await act(async () => root.unmount());
}

test("the goal record mounts: parts in order, milestones marked, a question answered, a source read, why saved, nothing empty drawn", async () => {
  await verifyRecord();
}, 600_000);
