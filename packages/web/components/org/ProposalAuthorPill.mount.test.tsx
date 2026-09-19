// Mounts the author pill (org-staffing.md S15) in jsdom against mocked store
// hooks: a role author with the server's enrichment, a role the tree names,
// a session author resolved from the store row and opened through the linked
// session navigation, and a decision's origin line found from its context.
// Run: bun components/org/ProposalAuthorPill.mount.test.tsx
import assert from "node:assert/strict";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();

async function verifyAuthorPill() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const opened: unknown[] = [];
  const state = {
    sessions: { "conv-1": { _id: "conv-1", title: "Org review, September", short_id: "jx7rev1" } } as Record<string, any>,
    orgTree: null as any,
    orgProposals: { p8: { _id: "p8", short_id: "op-8", author: { kind: "session", id: "conv-1" } } } as Record<string, any>,
  };
  const roles: any[] = [{ _id: "role-1", name: "Growth", handle: "growth", short_id: "or-1", avatar: "owl" }];
  // orgProposals.origin, by proposal ref: a named author, null (unreadable), or an Error (the read failed).
  const origins: Record<string, any> = { "op-9": { short_id: "op-9", status: "open", author: { kind: "role", id: "role-x", name: "Platform", handle: "platform", short_id: "or-2" } }, "op-404": null, "op-500": new Error("boom") };
  const asked: string[] = [];
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useTrackedStore: () => state }));
  mock.module("../../hooks/useOrgRoles", () => ({ useOrgRoles: () => ({ roles, workspace: null }) }));
  mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: (_fn: unknown, args: any) => {
    if (args === "skip") return { data: undefined, error: undefined, retry: () => {} };
    asked.push(args.proposal);
    const v = args.proposal in origins ? origins[args.proposal] : undefined;
    return v instanceof Error ? { data: undefined, error: v, retry: () => {} } : { data: v, error: undefined, retry: () => {} };
  } }));
  mock.module("../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => (row: unknown) => opened.push(row) }));
  // Spread the real module: a substitution is process-global, and a stub that
  // drops avatarLength breaks every file that imports it afterwards.
  const realAvatars = { ...(await import("./avatars")) };
  mock.module("./avatars", () => ({ ...realAvatars, RoleAvatar: ({ avatar }: { avatar: string }) => React.createElement("i", { "data-avatar": avatar }) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ProposalAuthorPill, DecisionProposalOrigin } = await import("./ProposalAuthorPill");
  const root = createRoot(document.getElementById("root")!);
  const render = (el: React.ReactElement) => act(async () => root.render(el));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

  // A role the server named: name, handle, avatar, the scope page link.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "role", id: "role-9", name: "Chief of Staff", short_id: "or-9", handle: "chief-of-staff", avatar: "fox" } }));
  const rolePill = q<HTMLAnchorElement>('[data-proposal-author="role"]')!;
  assert.equal(rolePill.tagName, "A");
  assert.equal(rolePill.getAttribute("href"), "/org/or-9");
  assert.match(rolePill.textContent!, /Chief of Staff@chief-of-staff/);
  assert.equal(q("[data-avatar]")!.getAttribute("data-avatar"), "fox");

  // A role only the tree names: filled from the roles hook, its chosen avatar kept.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "role", id: "role-1" } }));
  assert.equal(q<HTMLAnchorElement>('[data-proposal-author="role"]')!.getAttribute("href"), "/org/or-1");
  assert.match(q('[data-proposal-author="role"]')!.textContent!, /Growth@growth/);
  assert.equal(q("[data-avatar]")!.getAttribute("data-avatar"), "owl");

  // A role neither the server nor the tree names: still a pill, no link, and
  // no query of the pill's own.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "role", id: "role-x" } }));
  assert.equal(q('[data-proposal-author="role"]')!.tagName, "SPAN");
  assert.match(q('[data-proposal-author="role"]')!.textContent!, /a role/);
  assert.deepEqual(asked, []);

  // A session author: title and short id from the store row; a click opens
  // the conversation through the linked session navigation.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "session", id: "conv-1" } }));
  const sessionPill = q<HTMLButtonElement>('[data-proposal-author="session"]')!;
  assert.equal(sessionPill.tagName, "BUTTON");
  assert.match(sessionPill.textContent!, /Org review, Septemberjx7rev1/);
  await act(async () => sessionPill.click());
  const { updated_at, ...openedRow } = opened.pop() as Record<string, unknown>;
  assert.equal(typeof updated_at, "number");
  assert.deepEqual(openedRow, { _id: "conv-1", title: "Org review, September", short_id: "jx7rev1" });

  // The pane hands its own opener; the pill uses it instead.
  const own: string[] = [];
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "session", id: "conv-1" }, onOpenSession: (id: string) => own.push(id) }));
  await act(async () => q<HTMLButtonElement>('[data-proposal-author="session"]')!.click());
  assert.deepEqual(own, ["conv-1"]);

  // A session the store does not hold still reads as a session and still opens.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "session", id: "conv-gone" } }));
  assert.match(q('[data-proposal-author="session"]')!.textContent!, /a session/);

  // A person.
  await render(React.createElement(ProposalAuthorPill, { author: { kind: "user", id: "u1", name: "Sam" } }));
  assert.equal(q('[data-proposal-author="user"]')!.textContent, "Sam");

  // The decision's origin line: found from `/org?proposal=op-N` in its context,
  // named from the proposal row, linked to the org page. Nothing for other decisions.
  await render(React.createElement(DecisionProposalOrigin, { contextMd: "Summary.\n\n[Open op-8 on the org page](https://codecast.sh/org?proposal=op-8)" }));
  const origin = q("[data-proposal-origin]")!;
  assert.equal(origin.getAttribute("data-proposal-origin"), "op-8");
  assert.match(origin.textContent!, /proposed byOrg review, Septemberjx7rev1/);
  assert.equal(q<HTMLAnchorElement>('[data-proposal-origin] a[href="/org?proposal=op-8"]')!.textContent, "op-8");
  assert.deepEqual(asked, [], "the store held the row, so nothing was asked");
  await render(React.createElement(DecisionProposalOrigin, { contextMd: "Ship it?" }));
  assert.equal(q("[data-proposal-origin]"), null);
  // Not in the store: one light read names the author (orgProposals.origin), never the full proposal.
  await render(React.createElement(DecisionProposalOrigin, { contextMd: "[x](/org?proposal=op-9)" }));
  assert.equal(q("[data-proposal-origin]")!.getAttribute("data-origin-state"), "named");
  assert.match(q("[data-proposal-origin]")!.textContent!, /proposed byPlatform/);
  assert.equal(q<HTMLAnchorElement>('[data-proposal-author="role"]')!.getAttribute("href"), "/org/or-2");
  assert.deepEqual(asked.splice(0).slice(-1), ["op-9"]);
  // No answer yet says so; an unreadable proposal or a failed read still links the proposal and never waits on a name.
  await render(React.createElement(DecisionProposalOrigin, { contextMd: "[x](/org?proposal=op-77)" }));
  assert.match(q("[data-proposal-origin]")!.textContent!, /looking up op-77/);
  for (const ref of ["op-404", "op-500"]) {
    await render(React.createElement(DecisionProposalOrigin, { contextMd: `[x](/org?proposal=${ref})` }));
    assert.equal(q("[data-proposal-origin]")!.getAttribute("data-origin-state"), "unnamed");
    assert.doesNotMatch(q("[data-proposal-origin]")!.textContent!, /looking up/);
    assert.equal(q<HTMLAnchorElement>(`[data-proposal-origin] a[href="/org?proposal=${ref}"]`)!.textContent, ref);
  }

  await act(async () => root.unmount());
  dom.window.close();
  console.log("proposal author pill mount: passed");
}

if (import.meta.main) await verifyAuthorPill();
