// The Org screen (essence spec §3.2, §5) mounted in jsdom against a seeded
// store, the surface, the sheets and the embed stubbed: the header, one
// resizable panel beside the surface that the address alone opens (an
// object, `?session=`, `?proposal=`), opens that push history and a close
// that pushes the view, Esc, the panel's stored size and its reset, the
// narrow screen where the panel fills, the read views' addresses, History,
// compose, the link line, and New ▸ Goal.
// Run: bun test --timeout 240000 components/org/OrgScreen.mount.test.tsx
process.env.DEV = "1";
import { test, expect, afterAll, afterEach, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The avatar art is image files. Re-evaluating a module graph for a later
// mock.module, bun can read one as code and fail the whole file, so the
// module holding the art is stubbed before anything loads it.
const { AVATAR_KEYS } = await import("@codecast/shared/contracts/orgAvatars");
const byKey = <T,>(f: (k: string) => T) => Object.fromEntries(AVATAR_KEYS.map((k) => [k, f(k)]));
mock.module("../../lib/orgAvatars", () => ({ AVATAR_URLS: byKey((k) => `/avatars/${k}.webp`), AVATAR_LABELS: byKey((k) => k), AVATAR_ART: byKey(() => () => null), avatarLength: (size: number | string) => (typeof size === "number" ? `${size}px` : size) }));

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "DOMMatrixReadOnly", "DOMRect"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
// The split's Group builds its observer from the element's own window.
(dom.window as any).ResizeObserver ??= (globalThis as any).ResizeObserver;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
// jsdom lays nothing out; the Group needs a width to take a layout.
Object.defineProperty((dom.window as any).HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 1440; } });
afterAll(() => { delete process.env.DEV; closeDomWindow(dom); });

const React = await import("react");
const h = React.createElement;
const { act } = React;

// The screen's world: its address (written back through the router) and its width.
let path = "/org";
let search = "";
const pushed: string[] = [];
const replaced: string[] = [];
const go = (to: string) => { const [p, qs = ""] = to.split("?"); path = p; search = qs; };
const router = { push(to: string) { pushed.push(to); go(to); }, replace(to: string) { replaced.push(to); go(to); } };
/** The route params the tables hand the page: `org/:id` or `org/:view/:id`. */
const paramsOf = () => {
  const [, a, b] = /^\/org(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path) ?? [];
  return b ? { view: a, id: b } : a ? { id: a } : {};
};
const env = { width: 1440 as number | null, orgOn: true, ready: true, missing: false, refused: false, error: null as { message: string } | null };
const calls: string[] = [];
const embeds: any[] = [];

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(search), usePathname: () => path, useParams: () => paramsOf() }));
mock.module("../../hooks/useMeasuredWidth", () => ({ useMeasuredWidth: () => ({ width: env.width, measureRef: () => {} }) }));
const realPhone = { ...(await import("../../hooks/useIsPhone")) };
mock.module("../../hooks/useIsPhone", () => ({ ...realPhone, useIsPhone: () => false, useMinWidth: () => true }));
const realGate = { ...(await import("../../hooks/useOrgFeatureOn")) };
mock.module("../../hooks/useOrgFeatureOn", () => ({ ...realGate, useOrgFeatureOn: () => env.orgOn }));
const realSwitch = { ...(await import("../../hooks/useSwitchWorkspace")) };
mock.module("../../hooks/useSwitchWorkspace", () => ({ ...realSwitch, useSwitchWorkspace: () => async (teamId: string | null) => { calls.push(`switch:${teamId}`); } }));
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => ({ roles: [], proposals: 0 }), useConvex: () => undefined }));
const noThrow = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
const { useInboxStore } = await import("../../store/inboxStore");
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree: useInboxStore((s) => s.orgTree), ready: env.ready, missing: env.missing, refused: env.refused, error: env.error, retry: () => calls.push("retry") }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
// The get feeder answers "no such proposal" for a ref the store does not hold.
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: (ref: string | null) => ({ ready: !!ref, missing: !!ref && !Object.values(useInboxStore.getState().orgProposals).some((p: any) => p.short_id === ref) }), useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
// The embed reports what it was handed.
const realAnchor = { ...(await import("../anchor/AnchorConversation")) };
mock.module("../anchor/AnchorConversation", () => ({
  ...realAnchor,
  AnchorConversation: (props: any) => { embeds.push(props); return h("div", { "data-embed": props.conversationId, "data-embed-jump": props.jump ? `${props.jump.messageId ?? ""}|${props.jump.timestamp ?? ""}` : "", "data-embed-find": props.jump?.find ?? "" }); },
}));
// The surface is the canvas worker's: a stub that says what it was asked to show.
mock.module("../company/CompanyDocument", () => ({ CompanyDocument: (p: any) => h("div", { "data-doc": p.filter, "data-doc-selected": p.selected ?? "" }) }));
// The sheets' bodies are the sheet workers'; the frame is the panel's own.
const { SheetFrame } = await import("./company/SheetFrame");
const { useSheetHost } = await import("./company/sheetHost");
const renames: string[] = [];
const SEAT = { conversationId: "fixture-growth-conv", name: "Head of Growth", role: null, caption: null };
const stubSheet = (kind: string) => function Stub({ sheet }: any) {
  const host = useSheetHost();
  return h(SheetFrame, { kind, idRef: sheet.ref, glyph: null, title: `Sheet ${sheet.ref}`, onRename: (t: string) => renames.push(`${sheet.ref}:${t}`), crumbs: [{ kind: "initiative", ref: "", title: "Fixture" }], talk: kind === "project" ? SEAT : null } as any,
    h("p", { "data-stub-sheet": sheet.ref, "data-stub-intent": host?.intent ?? "" }, sheet.ref),
    h("button", { type: "button", "data-stub-talk": sheet.ref, onClick: () => host?.talk(sheet) }, "talk"),
    h("button", { type: "button", "data-stub-talk-role": sheet.ref, onClick: () => host?.talk({ kind: "role", ref: "or-1" }) }, "talk to growth"),
    h("button", { type: "button", "data-stub-open-session": sheet.ref, onClick: () => host?.open({ kind: "session", id: "fixture-anchor-conv" }) }, "session"),
    h("button", { type: "button", "data-stub-pick-lead": sheet.ref, onClick: () => host?.open({ kind: "project", ref: "pj-k3x9", intent: "pick-lead" }) }, "pick"));
};
mock.module("./company/sheetRegistry", () => ({ SHEETS: { initiative: stubSheet("initiative"), project: stubSheet("project"), role: stubSheet("role"), person: stubSheet("person") } }));
mock.module("./OrgProposalFeeders", () => ({ OrgProposalFeeders: ({ refs }: { refs: string[] }) => { calls.push(`feed:${refs.join(",")}`); return null; } }));
const realCard = { ...(await import("./ProposalCard")) };
mock.module("./ProposalCard", () => ({ ...realCard, ProposalBody: ({ proposal }: any) => h("div", { "data-proposal-body": proposal.short_id }) }));
const { useReviewComposer } = await import("../reviewContext");
const realObjectCard = { ...(await import("../EntityObjectCard")) };
mock.module("../EntityObjectCard", () => ({ ...realObjectCard, EntityObjectCard: ({ refId }: { refId: string }) => h("div", { "data-card-stub": refId, "data-card-batch": useReviewComposer()?.conversationId ?? "" }) }));
mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => h("p", null, content) }));

const { createRoot } = await import("react-dom/client");
const { OrgScreen } = await import("./OrgPage");
const { LinkLine } = await import("./OrgDetailPanel");
const { ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");

const HEAD = "fixture-head-conv";
const AUTHOR = { kind: "role" as const, id: "fixture-role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const T0 = 1_700_000_000_000;
/** The active team, as a real id: the screen reads proposals for the
 *  workspace the sidebar names (activeOrgWorkspace). */
const TEAM = "k57fixture0000000000000000000000";
const row = (n: number, extra: Record<string, unknown> = {}) => ({ _id: `p${n}`, short_id: `op-${n}`, team_id: TEAM, author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open", created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, counts: { total: 3, decided: 0, applied: 0, failed: 0, skipped: 0 }, ...extra });
const change = (proposal_id: string, seq: number) => ({ _id: `${proposal_id}-c${seq}`, proposal_id, seq, change: { kind: "role", name: `Role ${seq}`, handle: `role-${seq}`, reports_to: "me", scope: { projects: [] } }, rationale: "", evidence: [], status: "proposed" });
const MESSAGES = [
  { _id: "m1", role: "assistant", content: "Here is my review of the org.", timestamp: T0 },
  { _id: "m2", role: "assistant", content: "op-7", timestamp: T0 + 1 },
  { _id: "m3", role: "user", content: "Thanks, looking.", timestamp: T0 + 10 * 60_000 },
];
function seed(overrides: Record<string, unknown> = {}) {
  const state: Record<string, any> = {
    orgTree: { ...ORG_FIXTURE_WITH_HEAD, workspace: { ...ORG_FIXTURE_WITH_HEAD.workspace, id: TEAM } },
    orgProposals: { p7: row(7), p8: row(8, { thread: { conversation_id: "other-conv" } }), p9: row(9, { thread: null }), p10: row(10, { team_id: "other-team" }) },
    orgProposalChanges: Object.fromEntries([1, 2, 3].map((n) => [`p7-c${n}`, change("p7", n)])),
    messages: { [HEAD]: MESSAGES },
    conversations: {},
    sessions: { "fixture-anchor-conv": { _id: "fixture-anchor-conv", title: "Fix the deploy" } },
    reviewComments: {},
    orgFocusChangeId: null,
    currentUser: undefined,
    clientStateInitialized: true,
    clientState: { ui: { org_intro_seen: true, active_team_id: TEAM } },
    ...overrides,
  };
  useInboxStore.setState(state as any);
}

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];
const grow = (el: ParentNode, id: string) => q(`#${id}[data-panel]`, el)!.style.flexGrow;
const press = (key: string) => act(async () => { window.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

/** Screens a failed test left mounted: they would keep answering the shared address. */
const live = new Set<() => Promise<void>>();
afterEach(async () => { for (const off of [...live]) await off(); live.clear(); });

async function mount(address = "/org") {
  go(address);
  pushed.length = 0;
  replaced.length = 0;
  embeds.length = 0;
  calls.length = 0;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => act(async () => { root.render(h(OrgScreen)); });
  await render();
  // The split moves a microtask after it renders.
  await render();
  const unmount = async () => { if (!live.delete(unmount)) return; await act(async () => { root.unmount(); }); el.remove(); };
  live.add(unmount);
  return { el, render, unmount };
}

test("/org: the header is Org, New and the menu; the canvas alone, no separator showing, no strip and no conversation", async () => {
  seed();
  const screen = await mount();
  expect(q("[data-org-title]", screen.el)!.textContent).toBe("Org");
  expect(q("[data-org-new]", screen.el)).not.toBeNull();
  expect(q("[data-org-more]", screen.el)).not.toBeNull();
  expect(q("[data-org-header]", screen.el)!.textContent).not.toMatch(/exists to|Fixture|Personal/);
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc")).toBe("everything");
  expect(q("[data-org-split]", screen.el)!.getAttribute("data-org-split")).toBe("closed");
  expect(qa("[role=separator]", screen.el).every((s) => s.classList.contains("is-hidden"))).toBe(true);
  expect(grow(screen.el, "org-detail")).toBe("0");
  expect(q("[data-org-panel]", screen.el)).toBeNull();
  expect(q("[data-embed]", screen.el)).toBeNull();
  expect(q("[data-org-strip]", screen.el)).toBeNull();
  // The proposals' change rows are still fed (Waits on you reads them).
  expect(calls.filter((c) => c.startsWith("feed:")).at(-1)).toBe("feed:op-7,op-8,op-9");
  await screen.unmount();
});

test("/org/<ref>: the object opens beside the canvas, never over it, at the stored size; the canvas marks it", async () => {
  seed({ clientState: { ui: { org_intro_seen: true, active_team_id: TEAM }, layouts: { org_detail: { detail: 40 } } } });
  const screen = await mount("/org/in-2");
  expect(screen.el.firstElementChild!.getAttribute("data-org-screen")).toBe("wide");
  expect(q("[data-org-split]", screen.el)!.getAttribute("data-org-split")).toBe("open");
  expect(q("[data-org-panel]", screen.el)!.getAttribute("data-org-panel")).toBe("initiative:in-2");
  expect(q("[data-stub-sheet='in-2']", screen.el)).not.toBeNull();
  // Beside: the canvas is still drawn, at the width the panel leaves it.
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc-selected")).toBe("in-2");
  expect([grow(screen.el, "org-canvas"), grow(screen.el, "org-detail")]).toEqual(["60", "40"]);
  const seam = qa("[role=separator]", screen.el)[0]!;
  expect(seam.classList.contains("cc-split")).toBe(true);
  expect(seam.classList.contains("is-hidden")).toBe(false);
  // No slide replays: the panel crossfades in, and nothing animates its own entrance.
  expect(q("[data-org-panel]", screen.el)!.className).toContain("org-panel-swap");
  expect(q(".org-sheet", screen.el)).toBeNull();
  // The bar: the crumb leads with Org, which closes, and the close; no Back.
  expect(q("[data-sheet-crumb-workspace]", screen.el)!.textContent).toBe("Org");
  expect(q("[data-sheet-back]", screen.el)).toBeNull();
  await screen.unmount();
});

test("the split: a drag's end is the person's size, a double-click puts back 44%, a scope page's seam is never written", async () => {
  seed({ clientState: { ui: { org_intro_seen: true, active_team_id: TEAM }, layouts: { org: { conversation: 62, company: 38 } } } });
  const screen = await mount("/org/in-2");
  // No stored size yet: 44%.
  expect(grow(screen.el, "org-detail")).toBe("44");
  // A size from elsewhere (another window) moves the live panel.
  await act(async () => { useInboxStore.getState().updateClientLayout("org_detail", { detail: 52 }); });
  await screen.render();
  expect(grow(screen.el, "org-detail")).toBe("52");
  await act(async () => { qa("[role=separator]", screen.el)[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(useInboxStore.getState().clientState.layouts?.org_detail).toEqual({ detail: 44 });
  expect(useInboxStore.getState().clientState.layouts?.org).toEqual({ conversation: 62, company: 38 });
  await screen.unmount();
});

test("every open pushes history; Back is the previous object; Esc and the crumb close by pushing the view", async () => {
  seed();
  const screen = await mount("/org/in-2");
  // A Talk on a project opens its lead's conversation in the panel.
  go("/org/pj-k3x9");
  await screen.render();
  await act(async () => { q("[data-sheet-talk]", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org?session=fixture-growth-conv");
  await screen.render();
  expect(q("[data-org-panel]", screen.el)!.getAttribute("data-org-panel")).toBe("session:fixture-growth-conv");
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed")).toBe("fixture-growth-conv");
  // The browser's Back: the address goes back, and so does the panel.
  go("/org/pj-k3x9");
  await screen.render();
  expect(q("[data-org-panel]", screen.el)!.getAttribute("data-org-panel")).toBe("project:pj-k3x9");
  // A project with no lead has no one to talk to: its Talk opens nothing.
  const before = pushed.length;
  await act(async () => { q("[data-stub-talk='pj-k3x9']", screen.el)!.click(); });
  expect(pushed.length).toBe(before);
  // A Talk to a role opens the role itself: its head over its conversation.
  await act(async () => { q("[data-stub-talk-role='pj-k3x9']", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org/or-1");
  await screen.render();
  // The role already open: nothing moves.
  await act(async () => { q("[data-stub-talk-role='or-1']", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org/or-1");
  expect(pushed.filter((p) => p === "/org/or-1")).toHaveLength(1);
  // Esc closes: the view itself is pushed.
  pushed.length = 0;
  await press("Escape");
  expect(pushed).toEqual(["/org"]);
  await screen.render();
  // The panel folds away still showing what it held, then lets it go.
  expect(q("[data-org-split]", screen.el)!.getAttribute("data-org-split")).toBe("closed");
  expect(q("[data-org-split]", screen.el)!.hasAttribute("data-org-split-moving")).toBe(true);
  await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
  expect(q("[data-org-split]", screen.el)!.hasAttribute("data-org-split-moving")).toBe(false);
  expect(q("[data-org-panel]", screen.el)).toBeNull();
  // Esc with nothing open does nothing.
  await press("Escape");
  expect(pushed).toEqual(["/org"]);
  // The crumb's Org closes too.
  go("/org/in-2");
  await screen.render();
  await act(async () => { q("[data-sheet-crumb-workspace]", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org");
  await screen.unmount();
});

test("a role opens as its head above its conversation, in one panel", async () => {
  seed();
  const screen = await mount("/org/or-9");
  expect(q("[data-org-role-head] [data-stub-sheet='or-9']", screen.el)).not.toBeNull();
  expect(q("[data-org-role-conversation]", screen.el)!.getAttribute("data-org-role-conversation")).toBe(HEAD);
  expect(embeds.at(-1).conversationId).toBe(HEAD);
  expect(embeds.at(-1).composerPlaceholder).toBe("Ask Head of People");
  // A role has no Talk of its own: the panel is its conversation.
  expect(q("[data-sheet-talk]", screen.el)).toBeNull();
  // The Head of People is a role like any other: nothing redirects its address.
  expect(replaced).toEqual([]);
  await screen.unmount();
});

test("?session= opens that conversation, named in the bar, with a cold row seeded", async () => {
  seed();
  const screen = await mount("/org/in-2?session=fixture-anchor-conv");
  expect(q("[data-org-panel]", screen.el)!.getAttribute("data-org-panel")).toBe("session:fixture-anchor-conv");
  expect(q("[data-org-panel-title]", screen.el)!.textContent).toBe("Fix the deploy");
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed")).toBe("fixture-anchor-conv");
  await act(async () => { q("[data-org-panel-close]", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org");
  // A standing conversation the inbox never seeded gets its minimal row.
  go("/org?session=fixture-growth-conv");
  await screen.render();
  expect(useInboxStore.getState().conversations["fixture-growth-conv"]).toMatchObject({ _id: "fixture-growth-conv" });
  expect(q("[data-org-panel-title]", screen.el)!.textContent).toBe("Head of Growth");
  await screen.unmount();
});

test("?proposal= opens its thread at its card; one from another thread opens that thread; one a person posted is its card alone", async () => {
  seed();
  const screen = await mount("/org?proposal=op-7&focus=2");
  expect(q("[data-org-panel-title]", screen.el)!.textContent).toBe("Proposal 7");
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed")).toBe(HEAD);
  // The thread's rows already reach past the proposal: it lands on the card's message.
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed-jump")).toMatch(/^m2\|/);
  // The focus lights the change for the cards.
  expect(useInboxStore.getState().orgFocusChangeId).toBe("p7-c2");
  go("/org?proposal=op-8");
  await screen.render();
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed")).toBe("other-conv");
  // Its thread's rows have not arrived: the landing waits for them rather than jump by time.
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed-jump")).toBe("");
  // They arrive, past the proposal's time and without its card: it jumps by time and names the card to find.
  await act(async () => { useInboxStore.setState((st: any) => ({ messages: { ...st.messages, "other-conv": [{ _id: "o1", role: "assistant", content: "Later.", timestamp: T0 + 20 * 60_000 }] } })); });
  await screen.render();
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed-find")).toBe("op-8");
  expect(q("[data-embed]", screen.el)!.getAttribute("data-embed-jump")).toBe(`|${T0 + 8 * 60_000}`);
  go("/org?proposal=op-9");
  await screen.render();
  expect(q("[data-embed]", screen.el)).toBeNull();
  expect(q("[data-card-stub='op-9']", screen.el)!.getAttribute("data-card-batch")).toBe(HEAD);
  await screen.unmount();
});

test("a proposal the screen does not hold says so in the bar: in another workspace with a Switch, or unreadable", async () => {
  seed({ orgProposals: { p10: row(10, { team_id: "k57other0000000000000000000000000" }) } });
  const screen = await mount("/org?proposal=op-77");
  expect(q("[data-org-link-line='unreadable']", screen.el)!.textContent).toBe("This is not a proposal you can read.");
  expect(q("[data-embed]", screen.el)).toBeNull();
  go("/org?proposal=op-10");
  await screen.render();
  const line = q("[data-org-link-line='foreign']", screen.el)!;
  expect(line.textContent).toContain("This proposal is in");
  await act(async () => { q("[data-org-link-switch]", line)!.click(); });
  expect(calls).toContain("switch:k57other0000000000000000000000000");
  await screen.unmount();
});

test("the link line in its three kinds", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const switched: (string | null)[] = [];
  const draw = (line: any) => act(async () => { root.render(h(LinkLine, { line, onSwitchWorkspace: (t: string | null) => switched.push(t) })); });
  await draw({ kind: "foreign", shortId: "op-77", workspaceName: "Union", teamId: "team-union" });
  expect(q("[data-org-link-line='foreign']", el)!.textContent).toBe("This proposal is in Union.Switch");
  await act(async () => { q("[data-org-link-switch]", el)!.click(); });
  expect(switched).toEqual(["team-union"]);
  await draw({ kind: "unreadable", shortId: "op-77" });
  expect(q("[data-org-link-line='unreadable']", el)!.textContent).toBe("This is not a proposal you can read.");
  await draw({ kind: "loading", shortId: "op-77" });
  expect(q("[data-org-link-line='loading']", el)!.textContent).toBe("Looking for it…");
  await act(async () => { root.unmount(); });
  el.remove();
});

test("under 900px an open panel fills the content area with ← Org; the canvas folds, still mounted", async () => {
  seed();
  env.width = 820;
  const screen = await mount("/org/in-2");
  expect(screen.el.firstElementChild!.getAttribute("data-org-screen")).toBe("narrow");
  expect(q("[data-org-split]", screen.el)!.getAttribute("data-org-split")).toBe("fills");
  expect([grow(screen.el, "org-canvas"), grow(screen.el, "org-detail")]).toEqual(["0", "100"]);
  expect(q("[data-doc]", screen.el)).not.toBeNull();
  expect(q("[data-sheet-crumb-workspace]", screen.el)!.textContent).toBe("← Org");
  go("/org?session=fixture-anchor-conv");
  await screen.render();
  expect(q("[data-org-panel-crumb-org]", screen.el)!.textContent).toBe("← Org");
  // Closed, the canvas is the whole screen again.
  go("/org");
  await screen.render();
  await screen.render();
  expect([grow(screen.el, "org-canvas"), grow(screen.el, "org-detail")]).toEqual(["100", "0"]);
  env.width = 1440;
  await screen.unmount();
});

test("the read views: /org/goals and /org/projects/<ref> are the screen, the object opens in the panel and closes to the view", async () => {
  seed();
  const screen = await mount("/org/goals");
  expect(screen.el.firstElementChild!.getAttribute("data-org-view")).toBe("goals");
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc")).toBe("goals");
  expect(q("[data-org-panel]", screen.el)).toBeNull();
  go("/org/projects/pj-k3x9");
  await screen.render();
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc")).toBe("projects");
  expect(q("[data-org-panel]", screen.el)!.getAttribute("data-org-panel")).toBe("project:pj-k3x9");
  await act(async () => { q("[data-stub-open-session='pj-k3x9']", screen.el)!.click(); });
  expect(pushed.at(-1)).toBe("/org/projects?session=fixture-anchor-conv");
  await press("Escape");
  expect(pushed.at(-1)).toBe("/org/projects");
  await screen.unmount();
});

test("a project opened to pick its lead carries the intent to its sheet, for this visit only", async () => {
  seed();
  const screen = await mount("/org/in-2");
  expect(q("[data-stub-intent]", screen.el)!.getAttribute("data-stub-intent")).toBe("");
  await act(async () => { q("[data-stub-pick-lead='in-2']", screen.el)!.click(); });
  // The intent is not in the address.
  expect(pushed.at(-1)).toBe("/org/pj-k3x9");
  await screen.render();
  expect(q("[data-stub-intent]", screen.el)!.getAttribute("data-stub-intent")).toBe("pick-lead");
  // Any later open lets it go.
  await act(async () => { q("[data-stub-open-session='pj-k3x9']", screen.el)!.click(); });
  go("/org/pj-k3x9");
  await screen.render();
  expect(q("[data-stub-intent]", screen.el)!.getAttribute("data-stub-intent")).toBe("");
  await screen.unmount();
});

test("?panel=history opens History and leaves the address; ?compose= seeds the Head of People's draft once and opens its conversation", async () => {
  seed();
  const screen = await mount("/org/in-2?panel=history");
  expect(q("[data-org-history-sheet]")).not.toBeNull();
  expect(replaced.at(-1)).toBe("/org/in-2");
  await screen.unmount();
  const composing = await mount("/org?compose=hello%20there");
  expect(useInboxStore.getState().getDraft(HEAD)?.draft_message).toBe("hello there");
  expect(replaced.at(-1)).toBe(`/org?session=${HEAD}`);
  await composing.render();
  expect(q("[data-embed]", composing.el)!.getAttribute("data-embed")).toBe(HEAD);
  await composing.unmount();
});

test("the read states: a refused read and an error say so on the surface; a stale tree draws under a banner", async () => {
  seed({ orgTree: null });
  env.refused = true;
  let screen = await mount();
  expect(q("[data-doc]", screen.el)).toBeNull();
  expect(screen.el.textContent).not.toContain("Hire Head of People");
  await screen.unmount();
  env.refused = false;
  env.error = { message: "boom" };
  screen = await mount();
  expect(q("[data-doc]", screen.el)).toBeNull();
  await screen.unmount();
  env.error = null;
  seed();
  screen = await mount();
  expect(q("[data-doc]", screen.el)).not.toBeNull();
  await screen.unmount();
});

test("the org feature off: the company alone, with no review in the menu and people from the roster", async () => {
  seed({ orgTree: null, teamMembers: [{ _id: "u-sam", name: "Samvit Jain" }], currentUser: { _id: "u-me", name: "Ashot" } });
  env.orgOn = false;
  const screen = await mount();
  expect(q("[data-doc]", screen.el)).not.toBeNull();
  expect(q("[data-org-review-now]")).toBeNull();
  env.orgOn = true;
  await screen.unmount();
});

test("New ▸ Goal writes the goal at once and opens it in the panel with the name ready to type; the name survives the stub becoming its row", async () => {
  seed({ currentUser: { _id: "fixture-user-me", name: "Ashot" } });
  const screen = await mount();
  renames.length = 0;
  const created: any[] = [];
  const real = useInboxStore.getState().createInitiative;
  useInboxStore.setState({ createInitiative: (input: any) => { created.push(input); real(input); } } as any);
  await act(async () => { q("[data-org-new]", screen.el)!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { q("[data-org-new-goal]")!.click(); });
  useInboxStore.setState({ createInitiative: real } as any);
  expect(created).toHaveLength(1);
  const key = created[0].client_key;
  expect(useInboxStore.getState().initiatives[key]).toMatchObject({ title: "Untitled goal", short_id: "" });
  expect(pushed.at(-1)).toBe(`/org/${key}`);
  await screen.render();
  // The closing menu lets go of focus; the name takes it on the next frame.
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  const panel = q("[data-org-panel]", screen.el)!;
  const input = q("[data-sheet-title-input]", screen.el) as HTMLInputElement;
  expect(input).not.toBeNull();
  expect(document.activeElement === input).toBe(true);
  const setValue = Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(input, "Grow the pipeline"); input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  // The server row supersedes the stub with its short id; the address moves to it in place.
  const stub = useInboxStore.getState().initiatives[key];
  await act(async () => {
    useInboxStore.setState((s: any) => {
      const { [key]: _gone, ...rest } = s.initiatives;
      return { initiatives: { ...rest, k57goal000000000000000000000012: { ...stub, _id: "k57goal000000000000000000000012", short_id: "in-12" } } };
    });
  });
  await screen.render();
  await screen.render();
  expect(path).toBe("/org/in-12");
  expect(replaced.at(-1)).toBe("/org/in-12");
  // The same panel, the same field, the typed name still in it.
  expect(q("[data-org-panel]", screen.el) === panel).toBe(true);
  expect(q("[data-sheet-title-input]", screen.el) === input).toBe(true);
  expect(input.value).toBe("Grow the pipeline");
  await act(async () => { input.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(renames).toEqual(["in-12:Grow the pipeline"]);
  expect(q("[data-sheet-title-input]", screen.el)).toBeNull();
  await screen.unmount();
});
