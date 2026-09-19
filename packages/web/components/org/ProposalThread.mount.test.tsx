// Mounts the proposal's conversation (org-staffing.md S19) in jsdom against
// the revised fixture proposal. The thread embed is the same conversation view
// a session uses; here it is a stub that captures what the thread hands it
// (the window start, the letter, the reading density, the send override, the
// composer line), so the test can prove: the letter is the author's first
// bubble with one line of introduction the first time, the embed starts at
// the proposal and reads condensed, the next message names the ask or the
// change it is about, clearing it talks about the whole proposal, and on the
// phone the bar at the foot counts the asks and opens them.
// Run: bun components/org/ProposalThread.mount.test.tsx
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
  const embed: { onSendOverride?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => Promise<void>; props?: any } = {};
  mock.module("../anchor/AnchorConversation", () => ({
    AnchorConversation: (props: any) => {
      embed.onSendOverride = props.onSendOverride; embed.props = props;
      return React.createElement("div", { "data-thread": props.conversationId }, props.leadNode, React.createElement("div", { "data-live": true }, "live messages"), props.composerNode, React.createElement("textarea", null));
    },
  }));
  const toasts: string[] = [];
  const record = (kind: string) => (m: string, o?: { description?: string }) => toasts.push(`${kind}:${m}${o?.description ? ` / ${o.description}` : ""}`);
  mock.module("sonner", () => ({ toast: { error: record("error"), warning: record("warning"), success: record("success") } }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ProposalThread, AsksSheet } = await import("./ProposalThread");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } = await import("./orgStaffingFixture");
  const { proposalThread } = await import("./staffingRevise");
  const { proposalAsks } = await import("./staffingAsks");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", avatar: "owl", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const proposal = ORG_STAFFING_FIXTURE_REVISED_PROPOSAL;
  const thread = proposalThread(proposal, chiefTree)!;
  const asks = proposalAsks(proposal);
  const root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const text = () => document.body.textContent ?? "";
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };

  const said: string[] = [];
  const calls: string[] = [];
  const budget = proposal.changes.find((c) => c._id === "fixture-change-93")!;
  const renderThread = (extra: Record<string, unknown>) => act(async () => root.render(React.createElement(ProposalThread, {
    proposal, thread, layout: "lead", about: null, firstTime: true, now: Date.now(),
    onClearAbout: () => calls.push("clear"),
    onSay: (conv: string, shortId: string, on: { changeSeq: number | null; askIndex: number | null }, body: string) => said.push(`${conv}|${shortId}|${on.changeSeq}|${on.askIndex}|${body}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    ...extra,
  })));

  // ── the letter is the author's first bubble, above the live messages ──
  await renderThread({});
  assert.equal(q("[data-proposal-thread]")!.getAttribute("data-proposal-thread"), "fixture-chief-conv");
  assert.equal(embed.props.since, proposal.created_at, "the embed starts at the proposal");
  assert.equal(embed.props.initialDensity, "condensed", "the author's working turns fold away");
  assert.equal(embed.props.hideDiff, true);
  assert.equal(embed.props.hideHeader, true);
  const letter = q("[data-proposal-letter]")!;
  assert.ok(letter, "the letter renders as the lead node");
  assert.equal(letter.compareDocumentPosition(q("[data-live]")!) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING, "the letter sits above the live messages");
  assert.equal(q("[data-letter-author]")!.textContent, "Chief of Staff");
  assert.equal(q("[data-proposal-letter] [data-avatar]")!.getAttribute("data-avatar"), "owl");
  assert.match(letter.textContent!, /\d+[smhd] ago/);
  // The first time: one line of introduction, in the author's voice.
  assert.match(q("[data-letter-intro]")!.textContent!, /^I am your Chief of Staff, an agent that looks at how the work here is organized/);
  assert.match(q("[data-letter-lead]")!.textContent!, /The platform project has no owner/);
  assert.equal(q("[data-letter-toggle]"), null, "a short letter has no fold");
  // No header line of the thread's own: the bubble says who and when; the
  // full session is the icon on the name's line.
  assert.doesNotMatch(text(), /Talk to|who wrote this/);
  await click(q("[data-thread-open]"));
  assert.equal(calls.pop(), "open:fixture-chief-conv");
  // Nothing is about anything yet: no line above the box.
  assert.equal(q("[data-about-line]"), null);
  await embed.onSendOverride!("why is growth in there");
  assert.equal(said.pop(), "fixture-chief-conv|op-9|null|null|why is growth in there");
  // Not the first time: no introduction.
  await renderThread({ firstTime: false });
  assert.equal(q("[data-letter-intro]"), null);
  assert.ok(q("[data-letter-lead]"));

  // ── a long letter leads with its opening; the rest and the evidence fold ──
  const long = { ...proposal, summary_md: `${"Growth is past its limit and the platform project has no owner. ".repeat(16)}\n\nWhat I looked at: every plan and task under Growth.\n\nEvidence, what could not be verified, findings and escalations: https://codecast.sh/a/fixture` };
  await renderThread({ proposal: long });
  assert.doesNotMatch(q("[data-letter-lead]")!.textContent!, /What I looked at/);
  assert.equal(q("[data-letter-rest]"), null);
  assert.equal(q("[data-letter-evidence]"), null, "the evidence link waits with the rest");
  await click(q("[data-letter-toggle]"));
  assert.match(q("[data-letter-rest]")!.textContent!, /What I looked at: every plan and task under Growth/);
  assert.doesNotMatch(q("[data-letter-rest]")!.textContent!, /codecast\.sh/);
  assert.equal(q<HTMLAnchorElement>("[data-letter-evidence]")!.getAttribute("href"), "https://codecast.sh/a/fixture");

  // ── the next message names the ask, or the change, it is about ──
  await renderThread({ about: { kind: "ask", ask: asks[0] } });
  assert.equal(q("[data-about-line]")!.getAttribute("data-about-ask"), "0");
  assert.match(q("[data-about-line]")!.textContent!, new RegExp(`Asking about${asks[0].title}`));
  await embed.onSendOverride!("  that seems like a lot  ");
  assert.equal(said.pop(), "fixture-chief-conv|op-9|null|0|that seems like a lot");
  await click(q("[data-about-clear]"));
  assert.equal(calls.pop(), "clear");
  await renderThread({ about: { kind: "change", change: budget } });
  assert.equal(q("[data-about-line]")!.getAttribute("data-about-change"), "fixture-change-93");
  assert.match(q("[data-about-line]")!.textContent!, /Asking about.*800,?000/);
  await embed.onSendOverride!("that is too much");
  assert.equal(said.pop(), "fixture-chief-conv|op-9|3|null|that is too much");
  await embed.onSendOverride!("   ");
  assert.equal(said.length, 0, "a blank line sends nothing");
  // A picture alone is refused out loud; words with a picture send the words and say so.
  await embed.onSendOverride!("", [{ previewUrl: "blob:x", mime: "image/png", uploading: false }]);
  assert.equal(said.length, 0, "a picture alone sends nothing");
  assert.deepEqual(toasts.splice(0), ["error:The picture was not sent / This conversation takes text for now."]);
  await embed.onSendOverride!("see this", [{ previewUrl: "blob:x", mime: "image/png", uploading: false }]);
  assert.equal(said.pop(), "fixture-chief-conv|op-9|3|null|see this");
  assert.deepEqual(toasts.splice(0), ["warning:Sent your words, not the picture / This conversation takes text for now."]);

  // ── a session author is not a name ──
  await renderThread({ thread: { ...thread, name: "the agent that wrote this", named: false, role: null } });
  assert.equal(q("[data-letter-author]")!.textContent, "The agent that wrote this");
  assert.equal(q("[data-proposal-letter] [data-avatar]"), null);
  assert.match(q("[data-letter-intro]")!.textContent!, /^I am an agent that looked at how the work here is organized/);

  // ── a paused author is said above the thread, with Resume ──
  await renderThread({ thread: { ...thread, role: { ...thread.role!, status: "paused" } }, onResume: (id: string) => calls.push(`resume:${id}`) });
  assert.match(q("[data-chief-paused]")!.textContent!, /Chief of Staff is paused/);
  await click(qa("[data-chief-paused] button")[0]);
  assert.equal(calls.pop(), "resume:fixture-role-chief");

  // ── the phone: the conversation is the page, the bar at its foot opens the asks ──
  await renderThread({ layout: "phone", asksBar: { toDecide: 3, total: 3, updated: 2, onOpen: () => calls.push("asks") } });
  assert.equal(q("[data-proposal-thread]")!.getAttribute("data-thread-layout"), "phone");
  assert.match(q("[data-asks-bar]")!.textContent!, /^3 to decide2 updated$/);
  await click(q("[data-asks-bar]"));
  assert.equal(calls.pop(), "asks");
  await renderThread({ layout: "phone", asksBar: { toDecide: 0, total: 3, updated: 0, onOpen: () => {} } });
  assert.equal(q("[data-asks-bar]")!.textContent, "All 3 decided");
  assert.equal(q("[data-thread-back]"), null, "no list to go back to: the asks come to the conversation");
  // The sheet over it: the scrim and the handle both close it.
  await act(async () => root.render(React.createElement(AsksSheet, { onClose: () => calls.push("close") }, React.createElement("div", { "data-asks-inside": true }, "cards"))));
  assert.ok(q("[data-asks-sheet] [data-asks-inside]"));
  await click(q("[data-asks-scrim]"));
  assert.equal(calls.pop(), "close");

  // ── the DEV preview: the letter and a frame, no live session ──
  await renderThread({ preview: true });
  assert.ok(q("[data-thread-preview]"));
  assert.ok(q("[data-thread-preview] [data-proposal-letter]"));
  assert.equal(q("[data-thread]"), null);

  await act(async () => root.unmount());
  dom.window.close();
  console.log("proposal thread mount: passed");
}

if (import.meta.main) await verifyProposalThread();
