// Review scaffold for ct-52246: mount the staffing pane the way the org page
// does and print every word it puts on the screen, in DOM order, so a cold
// read can be judged without a browser. Not a test; delete after the review.
// Run: bun components/org/coldread.dump.tsx [op12.json]
import fs from "node:fs";

async function main() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><div id='thread'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  mock.module("../anchor/AnchorConversation", () => ({
    AnchorConversation: (props: any) => React.createElement("div", { "data-thread": props.conversationId }, React.createElement("p", null, "[conversation messages render here]"), props.composerNode, React.createElement("textarea", { placeholder: "Message" })),
  }));
  mock.module("sonner", () => ({ toast: { error: () => {}, warning: () => {}, success: () => {} } }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("./ProposalAuthorPill", () => ({ ProposalAuthorPill: ({ author }: any) => React.createElement("span", { "data-proposal-author": author.kind }, author.name) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { ProposalThread } = await import("./ProposalThread");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } = await import("./orgStaffingFixture");
  const { proposalThread, revisedSince } = await import("./staffingRevise");

  const file = process.argv[2];
  const proposal = file ? JSON.parse(fs.readFileSync(file, "utf8")) : ORG_STAFFING_FIXTURE_REVISED_PROPOSAL;
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const thread = proposalThread(proposal, chiefTree);
  const root = createRoot(document.getElementById("root")!);
  const troot = createRoot(document.getElementById("thread")!);

  const dump = (el: Element, depth = 0, out: string[] = []): string[] => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) { const t = (n.textContent ?? "").replace(/\s+/g, " ").trim(); if (t) out.push("  ".repeat(depth) + t); continue; }
      if (n.nodeType !== 1) continue;
      const e = n as HTMLElement;
      const tag = e.tagName.toLowerCase();
      if (tag === "svg") continue;
      if (tag === "button" || tag === "a" || tag === "select" || tag === "textarea") {
        const label = e.getAttribute("aria-label") || e.getAttribute("title") || e.getAttribute("placeholder");
        const t = (e.textContent ?? "").replace(/\s+/g, " ").trim();
        out.push("  ".repeat(depth) + `[${tag}${label ? ` "${label}"` : ""}] ${t}`);
        continue;
      }
      if (e.classList.contains("sr-only")) continue;
      const marker = [...e.attributes].filter((a) => a.name.startsWith("data-") && !["data-md"].includes(a.name)).map((a) => a.value ? `${a.name}=${a.value}` : a.name).join(" ");
      if (marker) out.push("  ".repeat(depth) + `<${marker}>`);
      dump(e, marker ? depth + 1 : depth, out);
    }
    return out;
  };

  const render = async (opts: { selected?: string | null; intro?: boolean; phone?: boolean; revised?: boolean }) => {
    const revised = opts.revised ? revisedSince(proposal.changes, 0) : [];
    const about = opts.selected ? proposal.changes.find((c: any) => c._id === opts.selected) ?? null : null;
    await act(async () => root.render(React.createElement(StaffingPane, {
      tree: chiefTree, health: ORG_STAFFING_FIXTURE_HEALTH, proposals: [proposal], proposal,
      selectedChangeId: opts.selected ?? null, chief: chiefTree.roles[chiefTree.roles.length - 1], reviewing: false, now: Date.now(),
      onSelectChange: () => {}, onDecide: () => {}, onAcceptAll: () => {}, onEditRole: () => {}, onSelectNode: () => {}, onOpenSession: () => {}, onPickProposal: () => {}, onHireChief: () => {}, onProposeNow: () => {},
      threadNode: opts.phone ? null : null,
      discuss: opts.phone && thread ? { name: thread.name, updated: revised.length, onOpen: () => {} } : null,
      onAskAbout: () => {},
      revised: revised.length ? { rows: revised, who: thread?.name ?? "the author", onSeen: () => {} } : undefined,
      meId: "me", introSeen: !(opts.intro ?? true), onIntroSeen: () => {}, onOpenGlossary: () => {},
    })));
    if (thread && !opts.phone) {
      await act(async () => troot.render(React.createElement(ProposalThread, {
        proposal, thread, layout: "side", about, onClearAbout: () => {}, onSay: () => {}, onOpenSession: () => {}, revisedRows: revised,
      })));
    } else {
      await act(async () => troot.render(null));
    }
  };

  const show = (title: string) => {
    console.log(`\n######## ${title}\n`);
    console.log("---- LIST COLUMN ----");
    console.log(dump(document.getElementById("root")!).join("\n"));
    const t = document.getElementById("thread")!;
    if (t.childNodes.length) { console.log("---- CONVERSATION COLUMN ----"); console.log(dump(t).join("\n")); }
  };

  await render({ intro: true, revised: true });
  show("FIRST SCREEN, desktop, nothing selected, intro on, author revised since last look");
  const first = proposal.changes.find((c: any) => c.status === "proposed");
  await render({ intro: false, selected: first?._id, revised: false });
  show(`ROW SELECTED (${first?._id}), intro dismissed`);
  await render({ intro: true, phone: true, revised: true });
  show("PHONE, list view with discuss bar");
  // Group headers by title attribute (the description a hover shows).
  console.log("\n---- GROUP HEADER TITLES (hover text) ----");
  for (const h of Array.from(document.querySelectorAll("[data-group-header]"))) console.log(`${h.getAttribute("data-group-header")}: ${h.getAttribute("title")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
