// The owners menu when the session that started this one is its role's own
// standing session: the role and that session are one agent, so the menu, the
// header faces and the "Owners:" line name it once, and removing it lets both go.
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
const { MemoryRouter } = await import("react-router");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");
const { withTeamRoster } = await import("../../test-helpers/teamRoster");
const { useInboxStore } = await import("../../store/inboxStore");
const { OwnersSegment } = await import("../OwnersMenu");
const { applySessionOwnersRead } = await import("../../hooks/useSyncSessionOwners");
const { coOwnersOf } = await import("../../lib/coOwners");

const S = "s".repeat(32);
const LEAD = "l".repeat(32);
const ROLE = "r_evals";
const me = { _id: "me", name: "Jason Benn" };
const ashot = { _id: "ashot", name: "Ashot Petrosian" };
const roleRow = { _id: ROLE, short_id: "or-1", name: "Eval Suite lead", handle: "evals", status: "active", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "me" }, scope_type: "team", host_user_id: "me" };
const role = { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" };
const myRow = { user_id: "me", name: me.name, email: null, added_by: "me", added_at: 1 };

const sent: Array<{ action: string; args: any[] }> = [];
const owner = {};
const container = document.getElementById("root")!;
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  useInboxStore.getState()._clearDispatch(owner);
  closeDomWindow(dom);
});

/** `seat`: the parent session is the role's standing session. */
/** `seat`: the parent's own row names the role; `orgSeat`: the org tree does. */
function seed(people: unknown[], seat: boolean, orgSeat = false) {
  sent.length = 0;
  useInboxStore.setState({
    currentUser: me as any,
    ...withTeamRoster([me, ashot], { clientState: useInboxStore.getState().clientState }),
    pending: {},
    sessionOwners: {},
    orgTree: { roles: [{ ...roleRow, standing: orgSeat ? { conversation_id: LEAD } : null }, roleTwo], anchors: [], people: [], workspace: { kind: "team", id: "fixture-team" } } as any,
    sessions: {
      [S]: { _id: S, session_id: S, title: "Polish the owners menu", user_id: "me", updated_at: 1, owners_model: true, owned_by_me: true, org_role_id: ROLE, owner_session_id: LEAD } as any,
      [LEAD]: { _id: LEAD, session_id: LEAD, title: "Eval Suite lead", user_id: "me", updated_at: 1, ...(seat ? { standing_role_id: ROLE } : {}) } as any,
    },
    conversations: { [S]: { _id: S, title: "Polish the owners menu", user_id: "me" } as any },
  } as any);
  useInboxStore.getState()._setDispatch(async (action, args) => { sent.push({ action, args }); return null; }, { owner });
  replies.set("sessionOwnership:listOwnerCandidates", { team_members: [me, ashot] });
  applySessionOwnersRead(S, {
    session_owners: true, conversation_id: S, people, role, parent_session: { conversation_id: LEAD, short_id: "l1", title: "Eval Suite lead" },
    implicit_starter: null, starter_id: "me", role_started: true, can_edit: true, owners_changed_at: 1,
  });
}

const render = async (node: React.ReactNode) => { await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>)); };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click(); }); };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const rowText = (r: HTMLElement) => r.querySelector(".flex-col")!.textContent;
beforeEach(async () => { await act(async () => root.render(null)); });
const ownersSent = () => sent.filter((x) => x.action === "applySessionOwners").map((x) => x.args[1]);

const roleTwo = { ...roleRow, _id: "r_design", short_id: "or-2", name: "Aesthetics lead", handle: "design" };

describe("the parent session is the role's standing session", () => {
  beforeEach(() => seed([], true));

  test("the role is named once: one face, one title entry, one row, and it is the only owner", async () => {
    await render(<OwnersSegment conversationId={S} />);
    const seg = $("[data-owners-seg]")!;
    expect(seg.title).toBe("Owners: Eval Suite lead");
    expect(seg.querySelector("[data-owner-session]")).toBeNull();
    await click(seg);
    expect($$("[data-owner-row]").map(rowText)).toEqual(["Eval Suite leadRole · answers for you"]);
    expect($('[data-owner-row="r:r_evals"] .own-x')!.hasAttribute("disabled")).toBe(true);
  });

  test("with a person beside it, removing the role lets its session go too", async () => {
    seed([myRow], true);
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner", "Eval Suite leadRole · answers for you"]);
    await click($('[data-owner-row="r:r_evals"] .own-x'));
    expect($$("[data-chip-label]").map((c) => c.textContent)).toEqual(["Eval Suite lead"]);
    await click($("[data-owners-save]"));
    await settle();
    expect(ownersSent()).toEqual([{ role: null, release_parent: true }]);
  });

  test("removing the role then adding it back changes nothing", async () => {
    seed([myRow], true);
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    await click($('[data-owner-row="r:r_evals"] .own-x'));
    await click($('[data-owner-candidate="r:r_evals"] .own-plus'));
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner", "Eval Suite leadRole · answers for you"]);
    expect($$("[data-chip-label]")).toEqual([]);
    expect($("[data-owners-save]")!.hasAttribute("disabled")).toBe(true);
  });

  test("staging another role brings the session it works for back as its own row", async () => {
    seed([myRow], true);
    await render(<OwnersSegment conversationId={S} />);
    await click($("[data-owners-seg]"));
    await click($('[data-owner-candidate="r:r_design"] .own-plus'));
    expect($$("[data-owner-row]").map(rowText)).toEqual(["YouOwner", "Aesthetics leadRole · answers for you · new", "Eval Suite leadSession it works for"]);
  });
});

test("the org tree alone names the seat when the store lacks the parent's row", async () => {
  seed([], false, true);
  await render(<OwnersSegment conversationId={S} />);
  expect($("[data-owners-seg]")!.title).toBe("Owners: Eval Suite lead");
  await click($("[data-owners-seg]"));
  expect($$("[data-owner-row]").map(rowText)).toEqual(["Eval Suite leadRole · answers for you"]);
});

test("a parent that is some other session keeps its own row", async () => {
  seed([], false);
  await render(<OwnersSegment conversationId={S} />);
  expect($("[data-owners-seg]")!.title).toBe("Owners: Eval Suite lead, Eval Suite lead");
  await click($("[data-owners-seg]"));
  expect($$("[data-owner-row]").map(rowText)).toEqual(["Eval Suite leadRole · answers for you", "Eval Suite leadSession it works for"]);
});

describe("the inbox card's co-owners", () => {
  const cardOf = () => coOwnersOf(useInboxStore.getState() as any, S, "me", [me, ashot])!;
  test("a seat parent, by its own row or by the org tree, is not a second owner", () => {
    for (const [seat, orgSeat] of [[true, false], [false, true]] as const) {
      seed([], seat, orgSeat);
      expect(cardOf().parentId).toBeNull();
      expect(cardOf().title).toBe("Owners: Eval Suite lead");
    }
  });
  test("any other parent stays a face of its own", () => {
    seed([], false);
    expect(cardOf().parentId).toBe(LEAD);
    expect(cardOf().title).toBe("Owners: Eval Suite lead, Eval Suite lead");
  });
});
