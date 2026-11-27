// The owners UI under the session_owners model, mounted per state with the
// flag on and off: the header's owners segment and menu, the composer strip
// and the inbox card faces.
// Flag off, every piece draws what main draws (nothing new).
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
(dom.window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(dom.window as any).HTMLElement.prototype.scrollIntoView ??= () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const convex = await import("convex/react");
const replies = new Map<string, any>();
mock.module("convex/react", () => ({
  ...convex,
  useQueries: (queries: Record<string, any>) => Object.fromEntries(Object.entries(queries).map(([key, request]) => [key, replies.get(getFunctionName(request.query))])),
  useMutation: () => async () => null,
}));
// Counts who reads the owners and the role rows: flag off, nobody may.
let ownerReads = 0;
const sessionOwnersHook = { ...(await import("../../hooks/useSessionOwners")) };
afterAll(() => mock.module("../../hooks/useSessionOwners", () => sessionOwnersHook));
mock.module("../../hooks/useSessionOwners", () => ({ ...sessionOwnersHook, useSessionOwners: (id: string) => { ownerReads++; return sessionOwnersHook.useSessionOwners(id); } }));
const { MemoryRouter } = await import("react-router");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");
const { withTeamRoster } = await import("../../test-helpers/teamRoster");
const { useInboxStore } = await import("../../store/inboxStore");
const { OwnersSegment, OwnersMenuItem, OwnersSheet } = await import("../OwnersMenu");
const { DropdownMenu, DropdownMenuContent } = await import("../ui/dropdown-menu");
const { ComposerOwnerStrip } = await import("../conversation/ComposerOwnerStrip");
const { CoOwnerFaces } = await import("../inbox/CoOwnerFaces");
const { coOwnersOf } = await import("../../lib/coOwners");
const { applySessionOwnersRead } = await import("../../hooks/useSyncSessionOwners");
const { ownerIdsOf } = await import("../../store/sessionOwnersSlice");
const { TmuxAttachPill } = await import("../TmuxAttachPill");
const { TerminalTitle } = await import("../terminal/ConversationTerminal");

const S = "s".repeat(32);
const ROLE = "r_evals";
const me = { _id: "me", name: "Jason Benn" };
const ashot = { _id: "ashot", name: "Ashot Petrosian" };
const armen = { _id: "armen", name: "Armen Petrosian" };
const roleRow = { _id: ROLE, short_id: "or-1", name: "Eval Suite lead", handle: "evals", status: "active", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "me" }, scope_type: "team", host_user_id: "me" };

const sent: Array<{ action: string; args: any[] }> = [];
const owner = {};
const container = document.getElementById("root")!;
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  useInboxStore.getState()._clearDispatch(owner);
  closeDomWindow(dom);
});

function seed(flagOn: boolean, read: Record<string, unknown> = {}) {
  sent.length = 0;
  useInboxStore.setState({
    currentUser: me as any,
    ...withTeamRoster([me, ashot, armen], { clientState: useInboxStore.getState().clientState }),
    pending: {},
    sessionOwners: {},
    orgTree: { roles: [roleRow], anchors: [], people: [], workspace: { kind: "team", id: "fixture-team" } } as any,
    sessions: { [S]: { _id: S, session_id: S, title: "Constitution propagation eval", user_id: "me", updated_at: 1, ...(flagOn ? { owners_model: true, owned_by_me: true, org_role_id: null, owner_session_id: null } : {}) } as any },
    conversations: { [S]: { _id: S, title: "Constitution propagation eval", user_id: "me" } as any },
  } as any);
  useInboxStore.getState()._setDispatch(async (action, args) => { sent.push({ action, args }); return null; }, { owner });
  replies.set("sessionOwnership:listOwnerCandidates", { team_members: [me, ashot, armen] });
  if (flagOn) applySessionOwnersRead(S, {
    session_owners: true, conversation_id: S, people: [{ user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 }],
    role: null, parent_session: null, implicit_starter: null, starter_id: "me", role_started: false, can_edit: true, owners_changed_at: 1, ...read,
  });
}

const render = async (node: React.ReactNode) => { await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>)); };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click(); }); };
const key = async (el: Element, k: string, opts: KeyboardEventInit = {}) => {
  await act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, ...opts })); });
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const rowText = (r: HTMLElement) => r.querySelector(".flex-col")!.textContent;
const ownersSent = () => sent.filter((x) => x.action === "applySessionOwners").map((x) => x.args[1]);

describe("flag off: nothing new draws", () => {
  beforeEach(() => seed(false));
  test("no owners segment state, no strip, no card faces", async () => {
    await render(<>
      <ComposerOwnerStrip conversationId={S} active />
      <CoOwnerFaces owners={coOwnersOf(useInboxStore.getState() as any, S, "me", [me, ashot])} />
    </>);
    expect(container.innerHTML).toBe("");
  });

  const STALE = { _id: S, people_ids: ["me", "ashot"], people_info: {}, role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" }, parent_session: null, implicit_starter: null, starter_id: "me", role_started: false, can_edit: true, owners_changed_at: 1 };
  const everything = () => <>
    <OwnersSegment conversationId={S} />
    <ComposerOwnerStrip conversationId={S} active />
    <CoOwnerFaces owners={coOwnersOf(useInboxStore.getState() as any, S, "me", [me, ashot])} />
  </>;

  test("an inbox row cached before the flag turned on draws the owners UI once its read says the model; a read off drops it", async () => {
    useInboxStore.setState((s: any) => ({ sessionOwners: { [S]: STALE }, sessions: { [S]: { ...s.sessions[S], owners_model: null } } }));
    await render(everything());
    expect($("[data-owners-seg]")).not.toBeNull();
    await act(async () => applySessionOwnersRead(S, { conversation_id: S, short_id: "s1", owners: [] }));
    await render(everything());
    expect(container.innerHTML).toBe("");
  });

  test("with no inbox row, the read off the model drops the cached one and the owners UI goes", async () => {
    useInboxStore.setState({ sessionOwners: { [S]: STALE }, sessions: {} } as any);
    await render(everything());
    expect($("[data-owners-seg]")).not.toBeNull();
    await act(async () => applySessionOwnersRead(S, { conversation_id: S, short_id: "s1", owners: [] }));
    await render(everything());
    expect((useInboxStore.getState() as any).sessionOwners[S]).toBeUndefined();
    expect(container.innerHTML).toBe("");
  });

  test("the composer lines and the Owners item read no owners and no layout", async () => {
    const queryAll = document.querySelectorAll.bind(document);
    let layout = 0;
    ownerReads = 0;
    (document as any).querySelectorAll = (sel: string) => { if (sel.includes("data-owners-seg")) layout++; return queryAll(sel); };
    try {
      await render(<>
        <ComposerOwnerStrip conversationId={S} active />
        <DropdownMenu open><DropdownMenuContent><OwnersMenuItem conversationId={S} onOpen={() => {}} /></DropdownMenuContent></DropdownMenu>
      </>);
    } finally {
      (document as any).querySelectorAll = queryAll;
    }
    expect($("[data-owners-menu-item]")).toBeNull();
    expect({ ownerReads, layout }).toEqual({ ownerReads: 0, layout: 0 });
  });

  test("the tmux pill keeps its copy button and the terminal's title is the bare pane name", async () => {
    await render(<>
      <TmuxAttachPill tmuxSession="cc-resume-7ea05201" isLive conversationKey={S} />
      <TerminalTitle target="cc-resume-7ea05201" convKey={S} machineName="Mac-mini" ownersOn={false} />
    </>);
    expect($('[aria-label="Copy tmux attach command"]')).not.toBeNull();
    expect($("[data-terminal-attach]")).toBeNull();
    expect(container.textContent).not.toContain("Mac-mini");
  });
});

describe("flag on: the tmux copy moves into the terminal's title", () => {
  test("no copy button on the pill; the title names the machine and copies", async () => {
    seed(true);
    await render(<>
      <TmuxAttachPill tmuxSession="cc-resume-7ea05201" isLive conversationKey={S} />
      <TerminalTitle target="cc-resume-7ea05201" convKey={S} machineName="Mac-mini" ownersOn />
    </>);
    expect($('[aria-label="Copy tmux attach command"]')).toBeNull();
    expect($("[data-terminal-attach]")).not.toBeNull();
    expect(container.textContent).toContain("Mac-mini");
  });
});

describe("flag on: the header's owners segment and menu", () => {
  beforeEach(() => seed(true, { role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" }, people: [{ user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 }] }));

  test("the segment shows the people and the role tile, and names them", async () => {
    await render(<OwnersSegment conversationId={S} />);
    const seg = $("[data-owners-seg]")!;
    expect(seg.title).toBe("Owners: You, Eval Suite lead");
    expect(seg.querySelectorAll(".role-tile, [role=img]").length).toBeGreaterThan(0);
  });

  test("the menu lists each owner with ×, stages adds as chips, and Save sends one change", async () => {
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    const menu = $("[data-owners-menu]")!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Owners · whose inbox");
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner", "Eval Suite leadRole · answers for you"]);
    expect(menu.textContent).toContain("Teammates");
    expect(menu.textContent).toContain("Select all teammates");
    expect($("[data-owners-save]")!.hasAttribute("disabled")).toBe(true);
    await click($('[data-owner-candidate="p:ashot"] .own-plus'));
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["+ Ashot"]);
    expect($$("[data-owner-row]").map(rowText)).toContain("Ashot PetrosianOwner · new");
    await click($("[data-owners-save]"));
    await settle();
    expect(ownersSent()).toEqual([{ add: ["ashot"] }]);
    expect(ownerIdsOf(useInboxStore.getState() as any, S)).toEqual(["me", "ashot"]);
    expect($("[data-owners-menu]")).toBeNull();
  });

  test("× stages a remove; Select all adds every teammate; Cancel sends nothing", async () => {
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    await click($(`[data-owner-row="r:${ROLE}"] .own-x`));
    // The removed role is a candidate again, below the teammates: sharing with a person is the usual move.
    const kinds = $$("[data-owner-candidate]").map((c) => c.getAttribute("data-owner-candidate")!.slice(0, 2));
    expect([kinds.includes("r:"), kinds.includes("p:")]).toEqual([true, true]);
    expect(kinds.lastIndexOf("p:")).toBeLessThan(kinds.indexOf("r:"));
    const text = $("[data-owners-menu]")!.textContent!;
    expect(text.indexOf("Teammates")).toBeLessThan(text.search(/Suggested roles|Roles/));
    await click($("[data-select-all-teammates]"));
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["+ Ashot", "+ Armen", "Eval Suite lead"]);
    await click([...$$("[data-owners-foot] button")].find((b) => b.textContent === "Cancel")!);
    await settle();
    expect(ownersSent()).toEqual([]);
  });

  test("staged to leave, you are no candidate and Select all leaves you out", async () => {
    seed(true, { people: [{ user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 }, { user_id: "ashot", name: ashot.name, email: null, added_by: "me", added_at: 2 }] });
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    expect($('[data-owner-candidate="p:me"]')).toBeNull();
    await click($('[data-owner-row="p:me"] .own-x'));
    expect($('[data-owner-candidate="p:me"]')).toBeNull();
    // Select all shows only for two or more; the one left is Armen.
    expect($("[data-select-all-teammates]")).toBeNull();
    expect($$('[data-owner-candidate^="p:"]').map((c) => c.getAttribute("data-owner-candidate"))).toEqual(["p:armen"]);
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["You leave"]);
    await render(null);
  });

  test("keyboard: arrows walk, Enter adds, ⌘↵ saves", async () => {
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    const menu = $("[data-owners-menu]")!;
    const input = menu.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "armen");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect($("[data-own-hi]")?.getAttribute("data-owner-candidate")).toBe("p:armen");
    await key(input, "Enter");
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["+ Armen"]);
    await key(input, "Enter", { metaKey: true });
    await settle();
    expect(ownersSent()).toEqual([{ add: ["armen"] }]);
  });

  test("a viewer who may not edit reads the owners and may only add themselves", async () => {
    seed(true, { can_edit: false, people: [{ user_id: "ashot", name: ashot.name, email: null, added_by: "ashot", added_at: 1 }] });
    useInboxStore.setState((s: any) => ({ sessions: { [S]: { ...s.sessions[S], user_id: "ashot", owned_by_me: false } } }));
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    expect($("[data-owners-menu] input")).toBeNull();
    expect($("[data-owners-menu] .own-x")).toBeNull();
    await click($("[data-owners-menu] [data-owners-add-me]"));
    await settle();
    expect(ownersSent()).toEqual([{ add: ["me"] }]);
  });
});

describe("flag on: where it came from", () => {
  const LEAD = "p".repeat(32);
  const evals = { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" };
  beforeEach(() => seed(true, { released_parent: { conversation_id: LEAD, short_id: "jxlead1", title: "Lead session" }, released_role: evals }));

  test("a taken-over session offers its parent and its role first, and Put back sends restore_parent", async () => {
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    const menu = $("[data-owners-menu]")!;
    const text = menu.textContent!;
    expect(text.indexOf("Where it came from")).toBeGreaterThan(-1);
    expect(text.indexOf("Where it came from")).toBeLessThan(text.indexOf("Teammates"));
    expect($$("[data-owner-candidate]").slice(0, 2).map((c) => c.dataset.ownerCandidate)).toEqual([`s:${LEAD}`, `r:${ROLE}`]);
    expect($(`[data-owner-candidate="s:${LEAD}"]`)!.textContent).toContain("Worked for it before");
    expect($(`[data-owner-candidate="r:${ROLE}"]`)!.textContent).toContain("Owned it before");
    await click($(`[data-owner-candidate="s:${LEAD}"] .own-plus`));
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner", "Lead sessionSession it works for · new"]);
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["+ Lead session"]);
    expect($(`[data-owner-candidate="s:${LEAD}"]`)).toBeNull();
    await click($("[data-owners-save]"));
    await settle();
    expect(ownersSent()).toEqual([{ restore_parent: true }]);
    expect((useInboxStore.getState() as any).sessionOwners[S].parent_session?.conversation_id).toBe(LEAD);
  });
});

describe("flag on: a session not created yet", () => {
  const STUB = "stubsession01";
  test("draws the owners segment with you as the owner, read-only until it starts", async () => {
    seed(false);
    useInboxStore.setState((s: any) => ({
      teams: [{ _id: "fixture-team", name: "Team", features: { session_owners: true } }],
      sessions: { ...s.sessions, [STUB]: { _id: STUB, session_id: STUB, title: "New session", updated_at: 1 } },
    }));
    await render(<OwnersSegment conversationId={STUB} />);
    expect($("[data-owners-seg]")!.title).toBe("Owners: You");
    await click($("[data-owners-seg]"));
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner"]);
    expect($("[data-owners-pending]")!.textContent).toBe("Owners can change once it starts");
    expect($("[data-owner-candidates]")).toBeNull();
    expect($("[data-owners-add-me]")).toBeNull();
  });
});

describe("a narrow header: Owners in the session menu opens the owners sheet", () => {
  const menu = (open: () => void) => <DropdownMenu open><DropdownMenuContent><OwnersMenuItem conversationId={S} onOpen={open} /></DropdownMenuContent></DropdownMenu>;

  test("flag off: no Owners item", async () => {
    seed(false);
    await render(menu(() => {}));
    expect($("[data-owners-menu-item]")).toBeNull();
  });

  test("flag on with no owners segment on screen: Owners opens the sheet with the owners menu", async () => {
    seed(true);
    let opened = false;
    await render(menu(() => { opened = true; }));
    await click($("[data-owners-menu-item]"));
    expect(opened).toBe(true);
    await render(<OwnersSheet conversationId={S} open onOpenChange={() => {}} />);
    expect($("[data-owners-sheet] [data-owners-menu]")).not.toBeNull();
    expect($$("[data-owners-sheet] [data-owner-row]").map(rowText)).toEqual(["YouOwner"]);
  });
});

describe("flag on: the composer strip", () => {
  test("an agent owner: the strip shows only while the composer is active, and Take it over sends take_over", async () => {
    seed(true, { people: [{ user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 }], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } });
    await render(<ComposerOwnerStrip conversationId={S} active={false} />);
    expect(container.innerHTML).toBe("");
    await render(<ComposerOwnerStrip conversationId={S} active />);
    expect($("[data-cc-owner-strip]")!.textContent).toContain("Eval Suite lead answers here too");
    await click($("[data-owner-take-over]"));
    await settle();
    expect(ownersSent()).toEqual([{ take_over: true }]);
    expect((useInboxStore.getState().sessions[S] as any).org_role_id).toBeNull();
    expect($("[data-cc-owner-strip]")).toBeNull();
  });

  test("people only: no strip", async () => {
    seed(true);
    await render(<ComposerOwnerStrip conversationId={S} active />);
    expect(container.innerHTML).toBe("");
  });
});

describe("flag on: the card faces", () => {
  test("a card shows the other owners' faces; a session only you own shows none", async () => {
    seed(true);
    seed(true, { people: [{ user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 }, { user_id: "ashot", name: ashot.name, email: null, added_by: "me", added_at: 2 }], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } });
    await render(<CoOwnerFaces owners={coOwnersOf(useInboxStore.getState() as any, S, "me", [me, ashot])} />);
    expect($("[data-card-owners]")!.title).toBe("Owners: You, Ashot Petrosian, Eval Suite lead");
    seed(true);
    await render(<CoOwnerFaces owners={coOwnersOf(useInboxStore.getState() as any, S, "me", [me])} />);
    expect(container.innerHTML).toBe("");
  });
});
