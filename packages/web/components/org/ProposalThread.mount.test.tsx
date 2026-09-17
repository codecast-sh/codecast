// Mounts the proposal's conversation (org-staffing.md S18) and the pane's
// revise rows in jsdom against the revised fixture proposal. The thread
// embed is the same conversation view a session uses; here it is a stub that
// captures what the pane hands it (the send override, the about line), so
// the test can prove: the next message names the selected change and its
// number, clearing it talks about the whole proposal, a removed change reads
// struck with the author's note, an amended one shows what moved, an added
// one is marked new, and the strip counts what landed since the reader last
// looked. Run: bun components/org/ProposalThread.mount.test.tsx
import assert from "node:assert/strict";

async function verifyProposalThread() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const embed: { onSendOverride?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => Promise<void>; composerNode?: React.ReactNode; conversationId?: string } = {};
  mock.module("../anchor/AnchorConversation", () => ({
    AnchorConversation: (props: any) => {
      embed.onSendOverride = props.onSendOverride; embed.composerNode = props.composerNode; embed.conversationId = props.conversationId;
      return React.createElement("div", { "data-thread": props.conversationId }, props.composerNode, React.createElement("textarea", null));
    },
  }));
  const toasts: string[] = [];
  mock.module("sonner", () => ({ toast: { error: (m: string) => toasts.push(`error:${m}`), warning: (m: string) => toasts.push(`warning:${m}`), success: (m: string) => toasts.push(`success:${m}`) } }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("./ProposalAuthorPill", () => ({ ProposalAuthorPill: ({ author }: any) => React.createElement("span", { "data-proposal-author": author.kind }, author.name) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ProposalThread } = await import("./ProposalThread");
  const { StaffingPane } = await import("./StaffingPane");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } = await import("./orgStaffingFixture");
  const { findChiefOfStaff } = await import("./staffingModel");
  const { proposalThread, revisedSince } = await import("./staffingRevise");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const proposal = ORG_STAFFING_FIXTURE_REVISED_PROPOSAL;
  const thread = proposalThread(proposal, chiefTree)!;
  const root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const text = () => document.body.textContent ?? "";
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };

  // ── the thread: the next message names the selected change ──
  const said: string[] = [];
  const calls: string[] = [];
  const budget = proposal.changes.find((c) => c._id === "fixture-change-93")!;
  const renderThread = (about: typeof budget | null, layout: "side" | "stack" | "phone" = "side") => act(async () => root.render(React.createElement(ProposalThread, {
    proposal, thread, layout, about,
    onClearAbout: () => calls.push("clear"),
    onSay: (conv: string, shortId: string, seq: number | null, body: string) => said.push(`${conv}|${shortId}|${seq}|${body}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    revisedRows: revisedSince(proposal.changes, 0),
    onBackToList: () => calls.push("back"),
  })));
  await renderThread(budget);
  assert.equal(q("[data-proposal-thread]")!.getAttribute("data-proposal-thread"), "fixture-chief-conv");
  assert.equal(embed.conversationId, "fixture-chief-conv");
  assert.match(text(), /Talk to Chief of Staff, who wrote this/);
  assert.equal(q("[data-about-line]")!.getAttribute("data-about-change"), "fixture-change-93");
  assert.match(q("[data-about-line]")!.textContent!, /about this change.*800,?000|about this change/);
  await embed.onSendOverride!("  that is too much  ");
  assert.deepEqual(said, ["fixture-chief-conv|op-9|3|that is too much"]);
  await embed.onSendOverride!("   ");
  assert.equal(said.length, 1, "a blank line sends nothing");
  // A picture alone is refused out loud; words with a picture send the words and say so.
  await embed.onSendOverride!("", [{ previewUrl: "blob:x", mime: "image/png", uploading: false }]);
  assert.equal(said.length, 1, "a picture alone sends nothing");
  assert.deepEqual(toasts.splice(0), ["error:This conversation takes text for now; the picture was not sent."]);
  await embed.onSendOverride!("see this", [{ previewUrl: "blob:x", mime: "image/png", uploading: false }]);
  assert.equal(said[1], "fixture-chief-conv|op-9|3|see this");
  assert.deepEqual(toasts.splice(0), ["warning:Sent your words; the picture was not, this conversation takes text for now."]);
  await click(q("[data-about-clear]"));
  assert.deepEqual(calls, ["clear"]);
  // Nothing selected: the whole proposal, and the send carries no row.
  await renderThread(null);
  assert.equal(q("[data-about-line]")!.getAttribute("data-about-change"), "");
  assert.match(q("[data-about-line]")!.textContent!, /the whole proposal/);
  await embed.onSendOverride!("why is growth in there");
  assert.equal(said[2], "fixture-chief-conv|op-9|null|why is growth in there");
  assert.equal(q("[data-thread-back]"), null, "no back control off the phone");
  // A session author is not a name: the header says "the agent that wrote this" and nothing after it.
  await act(async () => root.render(React.createElement(ProposalThread, {
    proposal, thread: { ...thread, name: "the agent that wrote this", named: false, role: null }, layout: "side", about: null,
    onClearAbout: () => {}, onSay: () => {}, onOpenSession: () => {},
  })));
  assert.match(text(), /Talk to the agent that wrote this/);
  assert.doesNotMatch(text(), /who wrote this/);
  // Phone: the way back to the list, and the revise notice with it.
  await renderThread(null, "phone");
  assert.ok(q("[data-thread-back]"));
  assert.match(q("[data-thread-revised]")!.textContent!, /Chief of Staff removed 1, changed 1 and added 1 since you last looked/);
  await click(q("[data-thread-revised]"));
  assert.equal(calls.at(-1), "back");

  // ── the pane: revise rows under the reader ──
  const paneCalls: string[] = [];
  const renderPane = (extra: Record<string, unknown>) => act(async () => root.render(React.createElement(StaffingPane, {
    tree: chiefTree, health: ORG_STAFFING_FIXTURE_HEALTH, proposals: [proposal], proposal, selectedChangeId: null,
    chief: findChiefOfStaff(chiefTree), reviewing: false, now: Date.now(), introSeen: true,
    onSelectChange: (id: string | null) => paneCalls.push(`select:${id}`),
    onDecide: (id: string, v: string) => paneCalls.push(`decide:${id}:${v}`),
    onAcceptAll: () => paneCalls.push("acceptAll"),
    onEditRole: () => {}, onSelectNode: () => {}, onOpenSession: () => {}, onPickProposal: () => {}, onHireChief: () => {}, onProposeNow: () => {},
    onAskAbout: (c: any) => paneCalls.push(`ask:${c._id}`),
    revised: { rows: revisedSince(proposal.changes, 0), who: "Chief of Staff", onSeen: () => paneCalls.push("seen") },
    threadNode: React.createElement("div", { "data-thread-slot": true }, "thread here"),
    ...extra,
  })));
  await renderPane({});
  // The strip names what landed; the removed row leaves the count.
  assert.match(q("[data-revised-strip]")!.textContent!, /Chief of Staff removed 1, changed 1 and added 1 since you last looked/);
  assert.equal(q("[data-progress]")!.textContent, "1 of 4 decided");
  assert.equal(qa("[data-change-row]").length, 5, "the removed row stays in the list, struck");
  const removed = q('[data-change-row="fixture-change-92"]')!;
  assert.equal(removed.getAttribute("data-change-status"), "removed");
  assert.equal(removed.getAttribute("data-revised"), "removed");
  assert.equal(removed.getAttribute("data-revised-new"), "true");
  assert.match(removed.querySelector("[data-revision]")!.textContent!, /Removed.*You said the SEO plan is winding down/);
  assert.equal(removed.querySelectorAll('button[aria-label="Accept"]').length, 0, "a removed change is nobody's to decide");
  assert.equal(removed.querySelector("[data-status]")!.getAttribute("data-status"), "removed");
  // An amended row shows what moved; the reader's verdicts stay.
  const amended = q('[data-change-row="fixture-change-93"]')!;
  assert.match(amended.querySelector("[data-revision]")!.textContent!, /Changed.*Raised to what four afternoons/);
  assert.match(amended.querySelector("[data-revision-moves]")!.textContent!, /tokens a day: was 600,000, now 800,000/);
  assert.ok(amended.querySelector('button[aria-label="Accept"]'));
  // An added row is marked new.
  const added = q('[data-change-row="fixture-change-95"]')!;
  assert.equal(added.querySelector("[data-revised-tag]")!.textContent, "new");
  assert.match(added.querySelector("[data-revision]")!.textContent!, /New.*You asked who watches the releases/);
  // The applied row was decided by the person: untouched by the revise.
  assert.equal(q('[data-change-row="fixture-change-94"]')!.getAttribute("data-revised"), null);
  // The progress strip drops the removed row.
  assert.equal(qa('[role="group"][aria-label="Changes, one block each"] button').length, 4);
  // Got it clears the strip; the thread sits under the list when the page hands it over.
  await click(q("[data-revised-seen]"));
  assert.equal(paneCalls.at(-1), "seen");
  assert.ok(q("[data-thread-slot]"));
  assert.equal(q("[data-composer]"), null, "the chief's composer yields to the proposal's thread");
  // Selecting a row: "Ask about this" sits with the verdicts.
  await renderPane({ selectedChangeId: "fixture-change-93" });
  await click(q('[data-change-row="fixture-change-93"] [data-ask-about]'));
  assert.equal(paneCalls.at(-1), "ask:fixture-change-93");
  // The applied row still takes a question; the removed one does not.
  await renderPane({ selectedChangeId: "fixture-change-94" });
  assert.ok(q('[data-change-row="fixture-change-94"] [data-ask-about]'));
  await renderPane({ selectedChangeId: "fixture-change-92" });
  assert.equal(q('[data-change-row="fixture-change-92"] [data-ask-about]'), null);
  // Phone: the list leads, the bar at its foot opens the conversation and counts the revises.
  await renderPane({ threadNode: null, discuss: { name: "Chief of Staff", named: true, updated: 3, onOpen: () => paneCalls.push("discuss") } });
  assert.equal(q("[data-thread-slot]"), null);
  assert.match(q("[data-discuss-bar]")!.textContent!, /Talk to Chief of Staff about this3 revised/);
  // A session author is not a name: the bar and the header say "the agent that wrote this".
  await renderPane({ threadNode: null, discuss: { name: "the agent that wrote this", named: false, updated: 0, onOpen: () => {} } });
  assert.match(q("[data-discuss-bar]")!.textContent!, /Talk to the agent that wrote this/);
  assert.doesNotMatch(q("[data-discuss-bar]")!.textContent!, /about this/);
  await click(q("[data-discuss-bar] button"));
  assert.equal(paneCalls.at(-1), "discuss");
  // A proposal nobody agent wrote: the chief's composer, as before.
  await renderPane({ threadNode: undefined, discuss: null, revised: undefined });
  assert.ok(q("[data-composer]"));

  await act(async () => root.unmount());
  dom.window.close();
  console.log("proposal thread mount: passed");
}

if (import.meta.main) await verifyProposalThread();
