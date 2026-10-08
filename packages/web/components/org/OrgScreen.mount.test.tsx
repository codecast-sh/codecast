// The org screen (docs/architecture/org-staffing.md S41) mounted in jsdom
// against a seeded store, the embed and the map stubbed: the two columns and
// what each gets, the strip and its click scrolling the thread to the card,
// `?proposal=` and `&focus=` on arrival, a foreign proposal expanded in the
// strip, the link line, the no-head column, the read states, the stacked
// layout and its switch, the map alone beside the head's own thread, the
// history and compose links, hover to the map, and the dev preview.
// Run: bun test --timeout 240000 components/org/OrgScreen.mount.test.tsx
process.env.DEV = "1";
import { test, expect, afterAll, mock } from "bun:test";
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
// The seam's Group builds its observer from the element's own window.
(dom.window as any).ResizeObserver ??= (globalThis as any).ResizeObserver;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => { delete process.env.DEV; closeDomWindow(dom); });

const React = await import("react");
const h = React.createElement;
const { act } = React;

// The screen's world: its address (written back through the router), its
// width, and what the tree feeder reports.
let search = "";
/** The object the address names (`/org/<ref>`), as useParams reads it. */
let routeId: string | undefined;
const replaced: string[] = [];
const pushed: string[] = [];
const router = {
  push(path: string) { pushed.push(path); },
  replace(path: string) {
    // Every replace moves the address: the path's ref and the query.
    const [base, query = ""] = path.split("?");
    routeId = base.startsWith("/org/") ? decodeURIComponent(base.slice("/org/".length)) : undefined;
    search = query;
    replaced.push(path);
  },
};
const env = { width: 1440 as number | null, orgOn: true, ready: true, missing: false, refused: false, error: null as { message: string } | null };
const calls: string[] = [];
const embeds: any[] = [];
let hover: ((id: string | null) => void) | null = null;

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(search), usePathname: () => (routeId ? `/org/${routeId}` : "/org"), useParams: () => (routeId ? { id: routeId } : {}) }));
const realOpen = { ...(await import("../../hooks/useOpenLinkedSession")) };
mock.module("../../hooks/useOpenLinkedSession", () => ({ ...realOpen, useOpenLinkedSession: () => (row: { _id: string }) => calls.push(`open:${row._id}`) }));
mock.module("../../hooks/useMeasuredWidth", () => ({ useMeasuredWidth: () => ({ width: env.width, measureRef: () => {} }) }));
const realPhone = { ...(await import("../../hooks/useIsPhone")) };
mock.module("../../hooks/useIsPhone", () => ({ ...realPhone, useIsPhone: () => false, useMinWidth: () => true }));
// The org feature gates the conversation pane only (D11); on unless a test turns it off.
const realGate = { ...(await import("../../hooks/useOrgFeatureOn")) };
mock.module("../../hooks/useOrgFeatureOn", () => ({ ...realGate, useOrgFeatureOn: () => env.orgOn }));
const realSwitch = { ...(await import("../../hooks/useSwitchWorkspace")) };
mock.module("../../hooks/useSwitchWorkspace", () => ({ ...realSwitch, useSwitchWorkspace: () => async (teamId: string | null) => { calls.push(`switch:${teamId}`); } }));
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => ({ roles: [], proposals: 0 }) }));
const noThrow = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
// The decision queue the strip and the sidebar's Org count both read.
let queue: any[] = [];
const realQueue = { ...(await import("../../hooks/useDecisionQueue")) };
mock.module("../../hooks/useDecisionQueue", () => ({ ...realQueue, useDecisionQueue: () => queue }));
const { useInboxStore } = await import("../../store/inboxStore");
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree: useInboxStore((s) => s.orgTree), ready: env.ready, missing: env.missing, refused: env.refused, error: env.error, retry: () => calls.push("retry") }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
// The get feeder answers "no such proposal" for a ref the store does not hold.
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: (ref: string | null) => ({ ready: !!ref, missing: !!ref && !Object.values(useInboxStore.getState().orgProposals).some((p: any) => p.short_id === ref) }), useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
const realHealth = { ...(await import("../../hooks/useSyncOrgHealth")) };
mock.module("../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: () => ({ health: null, ready: true, missing: false, refresh: async () => {} }) }));
// The embed reports what it was handed; the hire card keeps its one button.
const realAnchor = { ...(await import("../anchor/AnchorConversation")) };
mock.module("../anchor/AnchorConversation", () => ({
  ...realAnchor,
  AnchorConversation: (props: any) => { embeds.push(props); return h("div", { "data-embed": props.conversationId, "data-embed-jump": props.jump ? `${props.jump.messageId ?? ""}|${props.jump.timestamp ?? ""}|${props.jump.nonce}` : "", "data-embed-find": props.jump?.find ?? "" }); },
  HireHeadOfPeopleCard: () => h("div", { "data-hire-card": true }, h("button", { type: "button" }, "Hire Head of People")),
}));
// The map echoes what the screen hands it, and lends the test its gestures.
const mapProps: any[] = [];
const realMap = { ...(await import("./OrgMap")) };
mock.module("./OrgMap", () => ({ ...realMap, OrgMap: (p: any) => { mapProps.push(p); return h("div", { "data-org-map": p.filter, "data-map-proposed": p.asProposed ? "on" : "off", "data-map-highlight": p.highlightChangeId ?? "", "data-map-changes": p.proposal?.changes.length ?? 0, "data-map-focus": p.focusTarget ? `${p.focusTarget.id}#${p.focusTarget.seq}` : "", "data-map-ring": p.ring ? `${p.ring.kind}:${p.ring.id}` : "", "data-map-panel": p.panelWidth ?? 0 }); } }));
// The document is the lines worker's: a stub that says what it was asked to show.
mock.module("../company/CompanyDocument", () => ({ CompanyDocument: (p: any) => h("div", { "data-doc": p.filter, "data-doc-selected": p.selected ?? "" }) }));
// The sheets' bodies are the sheet workers'; the frame is the screen's own.
const { SheetFrame } = await import("./company/SheetFrame");
const renames: string[] = [];
const stubSheet = (kind: string) => ({ sheet }: any) => h(SheetFrame, { kind, idRef: sheet.ref, glyph: null, title: `Sheet ${sheet.ref}`, onRename: (t: string) => renames.push(`${sheet.ref}:${t}`), crumbs: [{ kind: "initiative", ref: "", title: "Fixture" }] } as any, h("p", { "data-stub-sheet": sheet.ref }, sheet.ref));
mock.module("./company/sheetRegistry", () => ({ SHEETS: { initiative: stubSheet("initiative"), project: stubSheet("project"), role: stubSheet("role"), person: stubSheet("person") } }));
mock.module("./OrgGraph", () => ({ OrgGraph: () => h("div", { "data-graph": true }) }));
// The feeders report their refs; the stub also lends the test the hover channel the cards use.
const { useOrgHover } = await import("./proposalContexts");
mock.module("./OrgProposalFeeders", () => ({ OrgProposalFeeders: ({ refs }: { refs: string[] }) => { calls.push(`feed:${refs.join(",")}`); hover = useOrgHover(); return null; } }));
// The card internals are the cards worker's; the preview draws one stub per proposal.
const realCard = { ...(await import("./ProposalCard")) };
mock.module("./ProposalCard", () => ({ ...realCard, ProposalBody: ({ proposal }: any) => h("div", { "data-proposal-body": proposal.short_id }) }));
mock.module("../EntityObjectCard", () => ({ EntityObjectCard: ({ refId }: { refId: string }) => h("div", { "data-card-stub": refId }) }));
mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => h("p", null, content) }));

const { createRoot } = await import("react-dom/client");
const { OrgScreen } = await import("./OrgPage");
const { OrgNeedsYouBadge } = await import("./OrgNeedsYouBadge");
const { ORG_FIXTURE, ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");

const HEAD = "fixture-head-conv";
const AUTHOR = { kind: "role" as const, id: "fixture-role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const T0 = 1_700_000_000_000;
/** The active team, as a real id: the screen reads proposals for the
 *  workspace the sidebar names (activeOrgWorkspace), so the tree and the
 *  proposals live in it. */
const TEAM = "k57fixture0000000000000000000000";
const row = (n: number, extra: Record<string, unknown> = {}) => ({ _id: `p${n}`, short_id: `op-${n}`, team_id: TEAM, author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open", created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, counts: { total: 3, decided: 0, applied: 0, failed: 0, skipped: 0 }, ...extra });
const change = (proposal_id: string, seq: number) => ({ _id: `${proposal_id}-c${seq}`, proposal_id, seq, change: { kind: "role", name: `Role ${seq}`, handle: `role-${seq}`, reports_to: "me", scope: { projects: [] } }, rationale: "", evidence: [], status: "proposed" });
const MESSAGES = [
  { _id: "m1", role: "assistant", content: "Here is my review of the org.", timestamp: T0 },
  { _id: "m2", role: "assistant", content: "op-7", timestamp: T0 + 1 },
  { _id: "m3", role: "user", content: "Thanks, looking.", timestamp: T0 + 2 },
];
function seed(overrides: Record<string, unknown> = {}) {
  const state: Record<string, any> = {
    orgTree: ORG_FIXTURE_WITH_HEAD,
    orgProposals: { p7: row(7), p8: row(8, { thread: { conversation_id: "other-conv" } }), p9: row(9, { status: "resolved" }), p10: row(10, { team_id: "other-team" }) },
    orgProposalChanges: Object.fromEntries([1, 2, 3].map((n) => [`p7-c${n}`, change("p7", n)])),
    messages: { [HEAD]: MESSAGES },
    conversations: {},
    sessions: {},
    reviewComments: {},
    orgFocusChangeId: null,
    currentUser: undefined,
    clientStateInitialized: true,
    clientState: { ui: { org_intro_seen: true, org_view: "map" } },
    ...overrides,
  };
  const ui = state.clientState?.ui ?? {};
  if (!("active_team_id" in ui)) state.clientState = { ...state.clientState, ui: { ...ui, active_team_id: TEAM } };
  if (state.orgTree && state.clientState.ui.active_team_id === TEAM) state.orgTree = { ...state.orgTree, workspace: { ...state.orgTree.workspace, id: TEAM } };
  useInboxStore.setState(state as any);
}

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];
/** The props the shown conversation last rendered with: the Head of People's
 *  thread stays mounted, hidden, while a seat is on the left. */
const lastEmbed = () => {
  const shown = document.querySelector("[data-org-conversation] [data-embed]")?.getAttribute("data-embed");
  return [...embeds].reverse().find((e) => !shown || e.conversationId === shown)!;
};
const jumpOf = (el: ParentNode) => q("[data-embed]", el)?.getAttribute("data-embed-jump") ?? null;
const findOf = (el: ParentNode) => q("[data-embed]", el)?.getAttribute("data-embed-find") ?? null;

const { TabParamsCtx } = await import("../../lib/tabParams");
type TabCtx = NonNullable<React.ContextType<typeof TabParamsCtx>>;
/** The pane scope a stage leaf (or a plain tab, with no leafId) hands the page. */
const tabScope = (tabId: string, leafId?: string): TabCtx => ({ tabId, pathname: "/org", params: {}, searchParams: new URLSearchParams(search), isActive: true, isVisible: true, leafId });

async function mount(address = "", scope: TabCtx | null = null, ref?: string) {
  search = address;
  routeId = ref;
  mapProps.length = 0;
  replaced.length = 0;
  pushed.length = 0;
  embeds.length = 0;
  calls.length = 0;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => act(async () => { root.render(scope ? h(TabParamsCtx.Provider, { value: scope }, h(OrgScreen)) : h(OrgScreen)); });
  await render();
  return { el, render, unmount: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}
const openRows = (el: ParentNode) => act(async () => { q("[data-org-strip-toggle]", el)!.click(); });

test("wide: the head row and the strip paint from the tree, the embed gets the standing conversation whole, and the row is seeded for a cold open", async () => {
  seed();
  const { el, unmount } = await mount();
  expect(el.firstElementChild!.getAttribute("data-org-screen")).toBe("wide");
  expect(q("[data-org-conversation]", el)!.getAttribute("data-org-conversation-state")).toBe("live");
  expect(q("[data-org-conversation-head]", el)!.textContent).toContain("Head of People");
  expect(q("[data-org-header]", el)).not.toBeNull();
  const embed = lastEmbed();
  expect(embed.conversationId).toBe(HEAD);
  expect(embed.foldWorkingTurns).toBe(true);
  expect(embed.foldBootstrap).toBe(true);
  expect("since" in embed).toBe(false);
  expect("openAtTop" in embed).toBe(false);
  expect(embed.composerPlaceholder).toBe("Ask Head of People");
  // The strip is the pinned context: the thread's sticky last prompt stays off.
  expect(embed.stickyPrompt).toBe(false);
  // The head row is the face, the name and what it is for (its charter's first
  // sentence); the state line's one home is the thread's pinned panel.
  expect(q("[data-org-conversation-name]", el)!.textContent).toBe("Head of People");
  expect(q("[data-org-conversation-caption]", el)!.textContent).toBe("Owns organic search, paid search and the weekly growth review");
  // One frame: the strip's head and the company's head share one band, so
  // their rules meet across the seam, and every frame rule is the panel rule.
  // (jsdom lays nothing out, so offsetHeight is checked alongside the band itself.)
  const stripHead = q("[data-org-strip-head]", el)!;
  const companyHead = q("[data-company-head]", el)!;
  expect(stripHead.offsetHeight).toBe(companyHead.offsetHeight);
  for (const band of [stripHead, companyHead, q("[data-org-conversation-head]", el)!]) expect(band.className).toContain("box-content h-11");
  for (const ruled of [q("[data-org-header]", el)!, q("[data-org-strip]", el)!, companyHead, q("[data-org-conversation-head]", el)!]) expect(ruled.style.borderColor).toBe("var(--cc-panel-rule)");
  expect(q("[data-org-column='conversation']", el)).not.toBeNull();
  expect(q("[data-org-column='map']", el)).not.toBeNull();
  expect(useInboxStore.getState().conversations[HEAD]).toMatchObject({ _id: HEAD });
  // The strip is one line; its rows, behind the chevron, are the open proposals of
  // this workspace, oldest first; the resolved one and the other workspace's are not rows.
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("2 proposals wait on you");
  expect(q("[data-org-strip-row]", el)).toBeNull();
  await openRows(el);
  expect(qa("[data-org-strip-row]", el).map((r) => r.getAttribute("data-org-strip-row"))).toEqual(["op-7", "op-8"]);
  expect(q("[data-org-strip-row='op-8']", el)!.getAttribute("data-org-strip-foreign")).toBe("true");
  expect(q("[data-org-strip-row='op-7']", el)!.getAttribute("data-org-strip-foreign")).toBeNull();
  // One change feeder per open proposal.
  expect(calls.filter((c) => c.startsWith("feed:")).at(-1)).toBe("feed:op-7,op-8");
  // The map draws the newest open proposal on this thread, with every filter off and the overlay on.
  expect(q("[data-org-map]", el)!.getAttribute("data-org-map")).toBe("everything");
  expect(q("[data-org-map]", el)!.getAttribute("data-map-proposed")).toBe("on");
  expect(q("[data-org-map]", el)!.getAttribute("data-map-changes")).toBe("3");
  // Seeing the screen sells the feature once.
  expect(useInboxStore.getState().clientState.ui?.org_upsell_seen).toBe(true);
  // The header carries New and the menu, and nothing about hiring: Health
  // and Add a role are gone (D9, D12).
  expect(q("[data-org-health-link]", el)).toBeNull();
  expect(q("[data-org-add-role]", el)).toBeNull();
  expect(q("[data-org-new]", el)).not.toBeNull();
  expect(q("[data-org-more]", el)).not.toBeNull();
  expect(q("[data-org-header]", el)!.textContent).not.toMatch(/Propose an org now|Hire/);
  await unmount();
});

test("a strip pick scrolls the thread to the card's message, names the proposal in the address and on the line, and closes the rows; a second pick asks again; the breadcrumb's x forgets it", async () => {
  seed();
  const { el, render, unmount } = await mount();
  await openRows(el);
  await act(async () => { q("[data-org-strip-row='op-7']", el)!.click(); });
  expect(jumpOf(el)).toBe("m2||1");
  expect(replaced.at(-1)).toBe("/org?proposal=op-7");
  expect(q("[data-org-strip-row]", el)).toBeNull();
  await render();
  expect(jumpOf(el)).toBe("m2||1");
  expect(q("[data-org-strip-current]", el)!.getAttribute("data-org-strip-current")).toBe("op-7");
  expect(q("[data-org-strip-current]", el)!.textContent).toContain("Proposal 7");
  await openRows(el);
  expect(q("[data-org-strip-row='op-7']", el)!.getAttribute("aria-current")).toBe("true");
  await act(async () => { q("[data-org-strip-row='op-7']", el)!.click(); });
  expect(jumpOf(el)).toBe("m2||2");
  await act(async () => { q("[data-org-strip-clear]", el)!.click(); });
  expect(replaced.at(-1)).toBe("/org");
  await render();
  expect(q("[data-org-strip-current]", el)).toBeNull();
  await unmount();
});

test("?proposal=op-7&focus=2 on arrival: one jump, the change lit for the cards and the map, and no second jump on a re-render", async () => {
  seed();
  const { el, render, unmount } = await mount("proposal=op-7&focus=2");
  expect(jumpOf(el)).toBe("m2||1");
  // The embed lands on the card itself after the thread settles on the message (W1): the request carries the landing.
  expect(typeof lastEmbed().jump.onSettled).toBe("function");
  expect(() => lastEmbed().jump.onSettled()).not.toThrow();
  expect(useInboxStore.getState().orgFocusChangeId).toBe("p7-c2");
  expect(q("[data-org-map]", el)!.getAttribute("data-map-highlight")).toBe("p7-c2");
  expect(q("[data-org-map]", el)!.getAttribute("data-map-focus")).toMatch(/^p7-c2#\d+$/);
  await render();
  expect(jumpOf(el)).toBe("m2||1");
  // Escape in the conversation clears the focus and strips the parameter.
  await act(async () => { q("[data-org-conversation]", el)!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(useInboxStore.getState().orgFocusChangeId).toBeNull();
  expect(replaced.at(-1)).toBe("/org?proposal=op-7");
  await unmount();
});

test("the thread's rows decide the jump: before they reach the proposal's time the click waits for them, and the card's message then lands by id; a tail past that time without the card lands on the time and names the card", async () => {
  seed({ messages: { [HEAD]: [MESSAGES[0]] } });
  const { el, unmount } = await mount();
  await openRows(el);
  await act(async () => { q("[data-org-strip-row='op-7']", el)!.click(); });
  // The one loaded row is older than op-7: nothing to jump to yet.
  expect(jumpOf(el)).toBe("");
  await act(async () => { useInboxStore.setState((s: any) => ({ messages: { [HEAD]: [...s.messages[HEAD], MESSAGES[1]] } })); });
  expect(jumpOf(el)).toBe("m2||1");
  await unmount();
  // Rows past the proposal's time, none of them the card: the time, with the card named for the embed's window.
  seed({ messages: { [HEAD]: [MESSAGES[0], { _id: "m9", role: "assistant", content: "Later words.", timestamp: T0 + 9 * 60_000 }] } });
  const second = await mount();
  await openRows(second.el);
  await act(async () => { q("[data-org-strip-row='op-7']", second.el)!.click(); });
  expect(jumpOf(second.el)).toBe(`|${T0 + 7 * 60_000}|1`);
  expect(findOf(second.el)).toBe("op-7");
  await second.unmount();
});

test("a proposal from another thread opens its card under the line and never scrolls; its row toggles it closed; a pick on this thread closes it too", async () => {
  seed();
  const { el, render, unmount } = await mount("proposal=op-8");
  expect(q("[data-org-strip-expanded]", el)!.getAttribute("data-org-strip-expanded")).toBe("op-8");
  expect(q("[data-card-stub]", el)!.getAttribute("data-card-stub")).toBe("op-8");
  expect(q("[data-org-strip-current]", el)!.getAttribute("data-org-strip-current")).toBe("op-8");
  expect(jumpOf(el)).toBe("");
  await openRows(el);
  await act(async () => { q("[data-org-strip-row='op-8']", el)!.click(); });
  await render();
  expect(q("[data-org-strip-expanded]", el)).toBeNull();
  await openRows(el);
  await act(async () => { q("[data-org-strip-row='op-8']", el)!.click(); });
  await render();
  expect(q("[data-org-strip-expanded]", el)!.getAttribute("data-org-strip-expanded")).toBe("op-8");
  await openRows(el);
  await act(async () => { q("[data-org-strip-row='op-7']", el)!.click(); });
  await render();
  expect(q("[data-org-strip-expanded]", el)).toBeNull();
  expect(jumpOf(el)).toBe("m2||1");
  await unmount();
});

test("a link the rows do not hold: unreadable, or in another workspace with a Switch", async () => {
  seed();
  const first = await mount("proposal=op-77");
  expect(q("[data-org-link-line]", first.el)!.getAttribute("data-org-link-line")).toBe("unreadable");
  expect(q("[data-org-link-line]", first.el)!.textContent).toBe("op-77 is not a proposal you can read.");
  await first.unmount();
  useInboxStore.setState({ teams: [{ _id: "other-team", name: "Union" }] } as any);
  const second = await mount("proposal=op-10");
  const line = q("[data-org-link-line]", second.el)!;
  expect(line.getAttribute("data-org-link-line")).toBe("foreign");
  expect(line.textContent).toBe("op-10 is in Union.Switch");
  await act(async () => { (line.querySelector("button") as HTMLButtonElement).click(); });
  expect(calls).toContain("switch:other-team");
  await second.unmount();
});

test("no Head of People: the hire card and one Propose an org now, none in the header; a head that has not started", async () => {
  seed({ orgTree: ORG_FIXTURE, orgProposals: {}, orgProposalChanges: {} });
  const noHead = await mount();
  expect(q("[data-org-conversation]", noHead.el)!.getAttribute("data-org-conversation-state")).toBe("no-head");
  expect(q("[data-hire-card] button", noHead.el)!.textContent).toBe("Hire Head of People");
  expect(qa("[data-org-propose-now]", noHead.el).length).toBe(1);
  expect(q("[data-org-header] [data-org-propose-now]", noHead.el)).toBeNull();
  expect(q("[data-org-propose-now-line]", noHead.el)!.textContent).toContain("Or have a fresh session review the org once:");
  expect(q("[data-embed]", noHead.el)).toBeNull();
  await noHead.unmount();
  const notStarted = { ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => r.handle === "head-of-people" ? { ...r, standing: null } : r) };
  seed({ orgTree: notStarted, orgProposals: {}, orgProposalChanges: {} });
  const started = await mount();
  expect(q("[data-org-conversation]", started.el)!.getAttribute("data-org-conversation-state")).toBe("not-started");
  expect(started.el.textContent).toContain("Head of People has not started yet. Its conversation appears here when it does.");
  await started.unmount();
});

test("the read states: refused in both columns with no hire card, an error with Try again, a stale banner over a cached tree", async () => {
  seed({ orgTree: null, orgProposals: {}, orgProposalChanges: {} });
  env.refused = true;
  const refused = await mount();
  expect(qa("[data-org-read='refused']", refused.el).length).toBe(2);
  expect(q("[data-org-conversation]", refused.el)!.getAttribute("data-org-conversation-state")).toBe("refused");
  expect(q("[data-hire-card]", refused.el)).toBeNull();
  await refused.unmount();
  env.refused = false;
  env.error = { message: "Server Error\nUncaught Error: Too many reads in a single function execution" };
  const errored = await mount();
  expect(qa("[data-org-read='error']", errored.el).length).toBe(2);
  expect(errored.el.textContent).toContain("Too many reads in a single function execution");
  await act(async () => { (q("[data-org-conversation] button", errored.el) as HTMLButtonElement).click(); });
  expect(calls).toContain("retry");
  await errored.unmount();
  seed();
  const stale = await mount();
  expect(q("[data-org-read='stale']", stale.el)!.textContent).toContain("this is the last copy");
  expect(q("[data-org-map]", stale.el)).not.toBeNull();
  expect(q("[data-embed]", stale.el)).not.toBeNull();
  await stale.unmount();
  env.error = null;
});

test("under 980px the columns stack behind a switch; show=map opens on the map and a new ?proposal= flips back", async () => {
  seed();
  env.width = 1000;
  const wide = await mount();
  expect(wide.el.firstElementChild!.getAttribute("data-org-screen")).toBe("wide");
  await wide.unmount();
  env.width = 960;
  const stacked = await mount();
  expect(stacked.el.firstElementChild!.getAttribute("data-org-screen")).toBe("stacked");
  expect(q("[data-org-switch]", stacked.el)!.getAttribute("data-org-switch")).toBe("conversation");
  // The switch rides the header's own row: no bar of its own, and it counts what waits.
  expect(q("[data-org-header] [data-org-switch]", stacked.el)).not.toBeNull();
  expect(q("[data-org-switch-pick='conversation']", stacked.el)!.textContent).toBe("Conversation2");
  expect(q("[data-org-map]", stacked.el)).toBeNull();
  expect(q("[data-embed]", stacked.el)).not.toBeNull();
  // A pick writes the proposal and the column in ONE address.
  await openRows(stacked.el);
  await act(async () => { q("[data-org-strip-row='op-7']", stacked.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?proposal=op-7&show=conversation");
  search = "";
  await stacked.render();
  await act(async () => { q("[data-org-switch-pick='map']", stacked.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?show=map");
  await stacked.render();
  expect(q("[data-org-map]", stacked.el)).not.toBeNull();
  // The thread stays mounted behind the map (hidden, not gone), so a flip never loses its place.
  expect(q("[data-org-column='conversation']", stacked.el)!.classList.contains("hidden")).toBe(true);
  await stacked.unmount();
  const onMap = await mount("show=map");
  expect(q("[data-org-map]", onMap.el)).not.toBeNull();
  expect(q("[data-org-column='conversation']", onMap.el)!.classList.contains("hidden")).toBe(true);
  search = "show=map&proposal=op-7";
  await onMap.render();
  expect(replaced.at(-1)).toBe("/org?show=conversation&proposal=op-7");
  await onMap.render();
  expect(q("[data-org-conversation]", onMap.el)).not.toBeNull();
  expect(jumpOf(onMap.el)).toBe("m2||1");
  await onMap.unmount();
  env.width = 1440;
});

test("beside the head's own thread only the map draws", async () => {
  seed();
  const { el, unmount } = await mount(`beside=${HEAD}&show=map`);
  expect(el.firstElementChild!.getAttribute("data-org-screen")).toBe("map-only");
  expect(q("[data-org-switch]", el)).toBeNull();
  expect(q("[data-org-strip]", el)).toBeNull();
  expect(q("[data-embed]", el)).toBeNull();
  expect(q("[data-org-header]", el)).toBeNull();
  expect(q("[data-org-map]", el)).not.toBeNull();
  expect(q("[data-chart-follow]", el)!.getAttribute("data-chart-follow")).toBe("on");
  // The thread's next pointer re-points the map.
  await act(async () => { useInboxStore.setState((s: any) => ({ messages: { [HEAD]: [...s.messages[HEAD], { _id: "m4", role: "assistant", content: "Look here: /org?proposal=op-7&focus=3", timestamp: T0 + 9 }] } })); });
  expect(replaced.at(-1)).toBe(`/org?beside=${HEAD}&show=map&proposal=op-7&focus=3`);
  await unmount();
});

test("?panel=history opens the sheet and leaves the address; ?compose= seeds the head's draft once", async () => {
  seed();
  const history = await mount("panel=history");
  expect(q("[data-org-history-sheet]")).not.toBeNull();
  expect(replaced.at(-1)).toBe("/org");
  await history.unmount();
  const compose = await mount("compose=hello%20there");
  expect(useInboxStore.getState().getDraft(HEAD)?.draft_message).toBe("hello there");
  expect(replaced.at(-1)).toBe("/org");
  await compose.unmount();
});

test("a hovered card lights the map; leaving falls back to the focused change", async () => {
  seed();
  const { el, unmount } = await mount("proposal=op-7&focus=2");
  expect(q("[data-org-map]", el)!.getAttribute("data-map-highlight")).toBe("p7-c2");
  await act(async () => { hover!("p7-c3"); });
  expect(q("[data-org-map]", el)!.getAttribute("data-map-highlight")).toBe("p7-c3");
  await act(async () => { hover!(null); });
  expect(q("[data-org-map]", el)!.getAttribute("data-map-highlight")).toBe("p7-c2");
  await unmount();
});

test("the dev preview: the fixtures as the thread, one bubble per proposal, no pref written, and the preview batch cleared on the way in and out", async () => {
  seed({ orgTree: null, orgProposals: {}, orgProposalChanges: {}, clientState: { ui: { org_intro_seen: true } }, reviewComments: { "preview:org": [{ id: "stale", messageId: "", blockIndex: 0, quote: "", body: "", createdAt: T0, proposal: { id: "p7", card: "role:1", verdict: "approve", change_ids: [], seqs: [1] } }] } });
  const { el, unmount } = await mount("preview=1");
  expect(useInboxStore.getState().reviewComments["preview:org"]).toBeUndefined();
  expect(q("[data-org-conversation]", el)!.getAttribute("data-org-conversation-state")).toBe("preview");
  expect(qa("[data-preview-card]", el).map((c) => c.getAttribute("data-preview-card"))).toEqual(["op-7", "op-9", "op-8"]);
  await openRows(el);
  expect(qa("[data-org-strip-row]", el).length).toBeGreaterThan(0);
  // The preview column draws every fixture itself: no row is foreign, and a click never opens a live card.
  expect(qa("[data-org-strip-row][data-org-strip-foreign]", el).length).toBe(0);
  await act(async () => { q("[data-org-strip-row='op-8']", el)!.click(); });
  expect(q("[data-org-strip-expanded]", el)).toBeNull();
  expect(q("[data-card-stub]", el)).toBeNull();
  // The preview is said once, as the banner.
  expect(qa("[data-org-preview-banner]", el).length).toBe(1);
  expect(q("[data-org-header]", el)!.textContent).not.toMatch(/preview/i);
  expect(q("[data-thread-preview]", el)!.textContent).toContain("Reply to the Head of People");
  expect(useInboxStore.getState().clientState.ui?.org_upsell_seen).toBeUndefined();
  expect(calls.filter((c) => c.startsWith("feed:")).at(-1)).toBe("feed:");
  await unmount();
});

test("the staged answers join the line; inside a tab the screen takes the width while mounted, not beside a conversation", async () => {
  seed({ reviewComments: { [HEAD]: [{ id: "a1", messageId: "", blockIndex: 0, quote: "", body: "", createdAt: T0, proposal: { id: "p7", card: "role:1", verdict: "approve", change_ids: ["p7-c1"], seqs: [1] } }] } });
  const leaf = await mount("", tabScope("tab-1", "leaf-1"));
  expect(q("[data-org-strip-answered-line]", leaf.el)!.textContent).toBe("1 answered, waiting for your send");
  expect(q("[data-org-strip-head]", leaf.el)!.textContent).toBe("2 proposals wait on you·1 answered, waiting for your send");
  expect(lastEmbed().composerPlaceholder).toBe("Ask Head of People, or send your answers as they are");
  // A stage leaf: the tab and the leaf are named for as long as the screen is here.
  expect(useInboxStore.getState().stageWide).toEqual({ tabId: "tab-1", leafId: "leaf-1" });
  await leaf.unmount();
  expect(useInboxStore.getState().stageWide).toBeNull();
  // A plain tab names the tab alone.
  const plain = await mount("", tabScope("tab-2"));
  expect(useInboxStore.getState().stageWide).toEqual({ tabId: "tab-2", leafId: null });
  // The person took the split back: the screen does not insist until it mounts again.
  await act(async () => { useInboxStore.getState().setStageWide(null); });
  await plain.render();
  expect(useInboxStore.getState().stageWide).toBeNull();
  await plain.unmount();
  // Opened beside a conversation on purpose, side by side stands.
  const beside = await mount("beside=other-conv", tabScope("tab-3", "leaf-3"));
  expect(useInboxStore.getState().stageWide).toBeNull();
  await beside.unmount();
  // Outside any tab (a test, a bare route) nothing is claimed.
  const bare = await mount();
  expect(useInboxStore.getState().stageWide).toBeNull();
  await bare.unmount();
});

test("the seam: one separator between the thread and the map, the stored split, hidden but present when stacked so the thread never remounts, none beside the head's own thread, and a double-click puts it back even", async () => {
  seed({ clientState: { ui: { org_intro_seen: true }, layouts: { org: { conversation: 62, company: 38 } } } });
  // jsdom lays nothing out; the Group needs a width to take a layout.
  const proto = (dom.window as any).HTMLElement.prototype;
  const realWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 720; } });
  const grow = (el: ParentNode, id: string) => q(`#${id}[data-panel]`, el)!.style.flexGrow;
  const screen = await mount();
  const seams = () => qa("[role=separator]", screen.el);
  expect(seams().length).toBe(1);
  expect(seams()[0]!.classList.contains("cc-split")).toBe(true);
  expect(seams()[0]!.classList.contains("is-hidden")).toBe(false);
  // The split is the person's, read from layouts.org.
  expect([grow(screen.el, "org-left"), grow(screen.el, "org-right")]).toEqual(["62", "38"]);
  // Under the stack width the same tree stays: the map folds away, the seam hides, the thread is the same node.
  const thread = q("[data-embed]", screen.el);
  env.width = 960;
  await screen.render();
  expect(screen.el.firstElementChild!.getAttribute("data-org-screen")).toBe("stacked");
  expect(seams().length).toBe(1);
  expect(seams()[0]!.classList.contains("is-hidden")).toBe(true);
  expect(grow(screen.el, "org-right")).toBe("0");
  expect(q("[data-embed]", screen.el)).toBe(thread);
  // Wide again: the seam comes back where the person left it.
  env.width = 1440;
  await screen.render();
  expect(seams()[0]!.classList.contains("is-hidden")).toBe(false);
  expect([grow(screen.el, "org-left"), grow(screen.el, "org-right")]).toEqual(["62", "38"]);
  expect(q("[data-embed]", screen.el)).toBe(thread);
  // A split from elsewhere (another window, the role page) moves the live seam.
  await act(async () => { useInboxStore.getState().updateClientLayout("org", { conversation: 45, company: 55 }); });
  expect([grow(screen.el, "org-left"), grow(screen.el, "org-right")]).toEqual(["45", "55"]);
  // Double-click resets to even, and the even split is what is kept.
  await act(async () => { seams()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(useInboxStore.getState().clientState.layouts?.org).toEqual({ conversation: 50, company: 50 });
  await screen.unmount();
  const alone = await mount(`beside=${HEAD}&show=map`);
  expect(alone.el.firstElementChild!.getAttribute("data-org-screen")).toBe("map-only");
  expect(qa("[role=separator]", alone.el).length).toBe(0);
  expect(q("[data-org-map]", alone.el)).not.toBeNull();
  await alone.unmount();
  Object.defineProperty(proto, "offsetWidth", realWidth);
});

test("a folded side cannot be dragged open: the boundary at the folded edge takes no pointer, stacked or map-only", async () => {
  seed({ clientState: { ui: { org_intro_seen: true }, layouts: { org: { conversation: 62, company: 38 } } } });
  const W = 720;
  const proto = (dom.window as any).HTMLElement.prototype;
  const elProto = (dom.window as any).Element.prototype;
  const realWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
  const realRect = elProto.getBoundingClientRect;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return W; } });
  // jsdom lays nothing out, and the library hit-tests from rectangles: each panel gets the share its flex-grow says.
  const share = (el: Element, id: string) => (W * Number((el.ownerDocument.getElementById(id) as HTMLElement | null)?.style.flexGrow || 0)) / 100;
  elProto.getBoundingClientRect = function (this: Element) {
    const Rect = (dom.window as any).DOMRect;
    if (this.id === "org-left") return new Rect(0, 0, share(this, "org-left"), 600);
    if (this.id === "org-right") return new Rect(share(this, "org-left"), 0, share(this, "org-right"), 600);
    if (this.getAttribute("role") === "separator") return new Rect(share(this, "org-left"), 0, 0, 600);
    return new Rect(0, 0, W, 600);
  };
  const pointer = (type: string, x: number, buttons: number) =>
    document.dispatchEvent(new (dom.window as any).MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300, button: 0, buttons }));
  // Press at the folded edge and drag across the page, the way a hand reaching for the thread's scrollbar would.
  const drag = async (from: number, to: number) => {
    await act(async () => { pointer("pointerdown", from, 1); });
    await act(async () => { pointer("pointermove", (from + to) / 2, 1); pointer("pointermove", to, 1); });
    await act(async () => { pointer("pointerup", to, 0); });
  };
  const grow = (el: ParentNode, id: string) => q(`#${id}[data-panel]`, el)!.style.flexGrow;
  // Stacked on the conversation: the map is folded at the thread's right edge.
  env.width = 960;
  const stacked = await mount();
  expect(stacked.el.firstElementChild!.getAttribute("data-org-screen")).toBe("stacked");
  expect([grow(stacked.el, "org-left"), grow(stacked.el, "org-right")]).toEqual(["100", "0"]);
  await drag(W - 2, W / 2);
  expect([grow(stacked.el, "org-left"), grow(stacked.el, "org-right")]).toEqual(["100", "0"]);
  // Wide again, the same seam drags as before.
  env.width = 1440;
  await stacked.render();
  expect([grow(stacked.el, "org-left"), grow(stacked.el, "org-right")]).toEqual(["62", "38"]);
  await drag(share(stacked.el, "org-left"), share(stacked.el, "org-left") - 36);
  expect(grow(stacked.el, "org-left")).not.toBe("62");
  await stacked.unmount();
  // Map-only: the conversation is folded at the map's left edge, with no separator rendered at all.
  env.width = 1440;
  const alone = await mount(`beside=${HEAD}&show=map`);
  expect(alone.el.firstElementChild!.getAttribute("data-org-screen")).toBe("map-only");
  expect([grow(alone.el, "org-left"), grow(alone.el, "org-right")]).toEqual(["0", "100"]);
  await drag(2, W / 2);
  expect([grow(alone.el, "org-left"), grow(alone.el, "org-right")]).toEqual(["0", "100"]);
  await alone.unmount();
  elProto.getBoundingClientRect = realRect;
  Object.defineProperty(proto, "offsetWidth", realWidth);
});

test("only this Group's own seam opens the drag gate: a layout change while another seam is held (the session list, the sidebar) is never written to layouts.org", async () => {
  seed({ clientState: { ui: { org_intro_seen: true }, layouts: { org: { conversation: 40, company: 60 } } } });
  const proto = (dom.window as any).HTMLElement.prototype;
  const realWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 720; } });
  // A seam of another Group on the page, the way DashboardLayout renders its own.
  const outer = document.createElement("div");
  outer.setAttribute("data-group", "");
  outer.innerHTML = `<div role="separator"></div>`;
  document.body.appendChild(outer);
  const foreign = q("[role=separator]", outer)!;
  const screen = await mount();
  const own = q("[role=separator]", screen.el)!;
  const realUpdate = useInboxStore.getState().updateClientLayout;
  const writes: unknown[] = [];
  useInboxStore.setState({ updateClientLayout: ((key: string, value: any) => { if (key === "org") writes.push(value); return realUpdate(key as any, value); }) as any });
  const gesture = async (sep: HTMLElement, split: { conversation: number; company: number }) => {
    writes.length = 0;
    await act(async () => { sep.dispatchEvent(new (dom.window as any).Event("pointerdown", { bubbles: true })); });
    // An imperative move of the live Group while the pointer is down: the library fires onLayoutChange for it,
    // the same as when another seam narrows the page and the Group clamps to its minimums.
    await act(async () => { useInboxStore.getState().updateClientLayout("org", split); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { window.dispatchEvent(new (dom.window as any).Event("pointerup")); });
    return [...writes];
  };
  // Another Group's seam: only the move itself is written; its echo is not written back on release.
  expect(await gesture(foreign, { conversation: 45, company: 55 })).toEqual([{ conversation: 45, company: 55 }]);
  // The Group's own seam opens the gate, so the same sequence persists the live layout on release.
  expect(await gesture(own, { conversation: 52, company: 48 })).toEqual([{ conversation: 52, company: 48 }, { conversation: 52, company: 48 }]);
  useInboxStore.setState({ updateClientLayout: realUpdate });
  await screen.unmount();
  outer.remove();
  Object.defineProperty(proto, "offsetWidth", realWidth);
});

test("the org feature off (D11): the company alone, no conversation, no strip, no seam and no off landing; people come from the roster, never from a refused tree", async () => {
  env.orgOn = false;
  env.refused = true;
  seed({
    orgTree: null,
    currentUser: { _id: "u-ash", name: "Ashot" },
    teamMembers: [{ _id: "u-ash", name: "Ashot", role: "owner" }, { _id: "u-sam", name: "Samvit", role: "admin" }, { _id: "bot-1", name: "Outbound lead", is_bot: true, bot_kind: "role" }],
    teams: [{ _id: "k57team0000000000000000000000000", name: "Union" }],
    clientState: { ui: { org_intro_seen: false, active_team_id: "k57team0000000000000000000000000" } },
  });
  const screen = await mount();
  expect(screen.el.firstElementChild!.getAttribute("data-org-screen")).toBe("company-only");
  expect(q("[data-org-column='conversation']", screen.el)).toBeNull();
  expect(q("[data-org-strip]", screen.el)).toBeNull();
  expect(q("[data-embed]", screen.el)).toBeNull();
  expect(qa("[role=separator]", screen.el).length).toBe(0);
  expect(q("[data-org-switch]", screen.el)).toBeNull();
  // The company draws (the document, the pane's default lens), not a refusal and not the feature's landing.
  expect(q("[data-company-pane]", screen.el)).not.toBeNull();
  expect(q("[data-doc]", screen.el)).not.toBeNull();
  expect(screen.el.textContent).not.toMatch(/turned off|not available/i);
  expect(q("[data-org-intro]", screen.el)).toBeNull();
  // Hiring is the agents half: an owner sees no way to add a role, and the
  // menu, opened, offers History and Words but not the gallery.
  expect(q("[data-org-add-role]", screen.el)).toBeNull();
  const more = q("[data-org-more]", screen.el)!;
  await act(async () => { more.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(q("[data-org-history-open]")).not.toBeNull();
  // This week reaches the health view from the menu.
  expect(q("[data-org-this-week]")!.getAttribute("href")).toBe("/org?lens=people&week=1");
  expect(q("[data-org-hire-gallery]")).toBeNull();
  expect(q("[data-org-add-role]")).toBeNull();
  await act(async () => { document.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await screen.unmount();
  env.orgOn = true;
  env.refused = false;
});

test("a stuck role row opens its object's sheet as an in-screen open (D5b): the address names it in place", async () => {
  const tree = { ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => r.short_id === "or-1" ? { ...r, standing: { ...r.standing!, state_status: "blocked" as const, state_line: "Needs a budget call" } } : r) };
  seed({ orgTree: tree });
  const screen = await mount();
  await act(async () => { q("[data-org-strip-toggle]", screen.el)!.click(); });
  const ask = q("[data-org-strip-ask='blocked:" + tree.roles.find((r) => r.short_id === "or-1")!._id + "']", screen.el)!;
  expect(ask).not.toBeNull();
  await act(async () => { ask.click(); });
  expect(replaced).toEqual(["/org/or-1"]);
  await screen.render();
  expect(q("[data-company-sheet='role:or-1']", screen.el)).not.toBeNull();
  // An in-screen open never swaps the conversation on the left.
  expect(lastEmbed().conversationId).toBe(HEAD);
  await screen.unmount();
});

// A decision the Head of People asked in its own thread, citing no goal or
// project: its subject is the head, already on the left.
const DECISION_ID = "k97decision00000000000000000000a";
const ASK = { _id: "m-ask", role: "assistant", content: "", timestamp: T0 + 3, tool_calls: [{ id: "tu-1", name: "Bash", input: `cast decide "Hire a design lead?" -o Yes -o No` }], tool_results: [] };
const decision = (extra: Record<string, unknown> = {}) => ({ key: `decide:${DECISION_ID}`, source: "decide", conversationId: HEAD, question: "Hire a design lead?", options: [{ label: "Yes" }, { label: "No" }, { label: "Later" }, { label: "Never" }, { label: "Ask me" }], blocking: true, createdAt: T0 + 3, decisionId: DECISION_ID, ...extra });

test("the sidebar's Org count and the strip's lead read the same number from the same world", async () => {
  queue = [decision()];
  seed({ teams: [{ _id: TEAM, name: "Fixture", features: { org: true } }] });
  const screen = await mount();
  const strip = q("[data-org-strip]", screen.el)!.getAttribute("data-org-strip");
  expect(strip).toBe("3");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(h(OrgNeedsYouBadge)); });
  expect(q("[data-org-nav-count]", host)!.getAttribute("data-org-nav-count")).toBe(strip);
  expect(host.textContent).toBe(strip);
  // Nothing waiting: the strip and the badge both go.
  queue = [];
  await act(async () => { useInboxStore.setState({ orgProposals: {} } as any); });
  expect(q("[data-org-strip-head]", screen.el)).toBeNull();
  expect(host.innerHTML).toBe("");
  await act(async () => { root.unmount(); });
  host.remove();
  await screen.unmount();
});

test("a decision asked in the head's own thread scrolls that thread to the ask, wide and stacked, and opens nothing", async () => {
  queue = [decision()];
  for (const width of [1440, 700]) {
    env.width = width;
    seed({ messages: { [HEAD]: [...MESSAGES, ASK] } });
    const screen = await mount(width < 980 ? "show=map" : "");
    await openRows(screen.el);
    await act(async () => { q(`[data-org-strip-ask='decide:${DECISION_ID}']`, screen.el)!.click(); });
    expect(jumpOf(screen.el)).toMatch(/^m-ask\|\|\d+$/);
    expect(replaced.filter((p) => p.startsWith("/org/"))).toEqual([]);
    if (width < 980) expect(new URLSearchParams(search).get("show")).toBe("conversation");
    await screen.unmount();
  }
  // The ask is not among the loaded rows and no server can name it: the thread lands on the time it was asked.
  env.width = 1440;
  seed();
  const screen = await mount();
  await openRows(screen.el);
  await act(async () => { q(`[data-org-strip-ask='decide:${DECISION_ID}']`, screen.el)!.click(); });
  expect(jumpOf(screen.el)).toMatch(new RegExp(`^\\|${T0 + 3}\\|\\d+$`));
  await screen.unmount();
  queue = [];
});

// ---------------------------------------------------------------- the company pane and its sheets (cohesive build spec §4, §5.1)

const GROWTH = "fixture-role-growth";
const press = (key: string) => act(async () => { window.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

test("the company pane reads as a document or draws the map, the choice the person's own; four filters, shared by both lenses", async () => {
  seed({ clientState: { ui: { org_intro_seen: true } } });
  const screen = await mount();
  // Read is the default: the document, no map.
  expect(q("[data-company-lens='read']", screen.el)).not.toBeNull();
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc")).toBe("everything");
  expect(q("[data-org-map]", screen.el)).toBeNull();
  expect(qa("[data-company-filter-pick]", screen.el).map((b) => b.textContent)).toEqual(["Everything", "Goals", "Projects", "People"]);
  // A filter is the address's, and narrows the document.
  await act(async () => { q("[data-company-filter-pick='projects']", screen.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?lens=projects");
  await screen.render();
  expect(q("[data-doc]", screen.el)!.getAttribute("data-doc")).toBe("projects");
  // Map: the choice is kept in the person's prefs, and the same filter draws on the map.
  await act(async () => { q("[data-company-lens-pick='map']", screen.el)!.click(); });
  expect(useInboxStore.getState().clientState.ui?.org_view).toBe("map");
  expect(q("[data-org-map]", screen.el)!.getAttribute("data-org-map")).toBe("projects");
  expect(q("[data-doc]", screen.el)).toBeNull();
  await screen.unmount();
});

test("This week (D12): the People map carries each role's week, toggled in its corner; the address that asks for it shows the map, and Read or another filter leaves it", async () => {
  seed({ clientState: { ui: { org_intro_seen: true, org_view: "read" } } });
  const screen = await mount("lens=people&week=1");
  // The person keeps Read, but the week is the map's: the map draws, with the week on.
  expect(q("[data-company-pane]", screen.el)!.getAttribute("data-company-pane")).toBe("map");
  expect(mapProps.at(-1)!.filter).toBe("people");
  expect(mapProps.at(-1)!.week).toBe(true);
  expect(q("[data-map-week]", screen.el)!.getAttribute("data-map-week")).toBe("on");
  // The corner's toggle turns it off in the address.
  await act(async () => { q("[data-map-week]", screen.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?lens=people");
  // Turning the week off keeps the map in view: the saved Read does not snap back.
  await screen.render();
  expect(q("[data-company-pane]", screen.el)!.getAttribute("data-company-pane")).toBe("map");
  expect(useInboxStore.getState().clientState.ui?.org_view).toBe("map");
  await screen.unmount();

  // Off, it turns on; it is offered only on People.
  seed({ clientState: { ui: { org_intro_seen: true, org_view: "map" } } });
  const people = await mount("lens=people");
  expect(mapProps.at(-1)!.week).toBe(false);
  await act(async () => { q("[data-map-week='off']", people.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?lens=people&week=1");
  await people.unmount();
  const goals = await mount("lens=goals&week=1");
  expect(q("[data-map-week]", goals.el)).toBeNull();
  expect(mapProps.at(-1)!.week).toBe(false);
  await goals.unmount();

  // Read leaves the week behind; so does another filter.
  seed({ clientState: { ui: { org_intro_seen: true, org_view: "map" } } });
  const read = await mount("lens=people&week=1");
  await act(async () => { q("[data-company-lens-pick='read']", read.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?lens=people");
  expect(useInboxStore.getState().clientState.ui?.org_view).toBe("read");
  await read.unmount();
  // Another filter drops the week but keeps the map, even for a person who keeps Read.
  seed({ clientState: { ui: { org_intro_seen: true, org_view: "read" } } });
  const other = await mount("lens=people&week=1");
  await act(async () => { q("[data-company-filter-pick='goals']", other.el)!.click(); });
  expect(replaced.at(-1)).toBe("/org?lens=goals");
  await other.render();
  expect(q("[data-company-pane]", other.el)!.getAttribute("data-company-pane")).toBe("map");
  await other.unmount();
});

test("a click on a map card opens its sheet over the company; the card stays ringed beside it; a second open stacks, Back and Esc step back, the address holds only the top", async () => {
  seed();
  const screen = await mount();
  expect(q("[data-company-sheet]", screen.el)).toBeNull();
  await act(async () => { mapProps.at(-1).onOpenObject({ kind: "role", id: GROWTH }); });
  expect(replaced.at(-1)).toBe("/org/or-1");
  await screen.render();
  const sheet = q("[data-company-sheet='role:or-1']", screen.el)!;
  expect(sheet).not.toBeNull();
  // 1440px of pane: the sheet takes 560 and the map keeps the rest, the open card ringed in it.
  expect(sheet.style.width).toBe("560px");
  expect(q("[data-org-map]", screen.el)!.getAttribute("data-map-ring")).toBe(`role:${GROWTH}`);
  expect(q("[data-org-map]", screen.el)!.getAttribute("data-map-panel")).toBe("560");
  // The sheet's bar is the screen's band under the frame rule, so its rule
  // meets the conversation head's across the seam.
  const bar = q("[data-sheet-bar]", sheet)!;
  expect(bar.className).toContain("box-content h-11");
  expect(bar.style.borderColor).toBe("var(--cc-panel-rule)");
  // One sheet: no Back. The left pane did not move.
  expect(q("[data-sheet-back]", screen.el)).toBeNull();
  expect(lastEmbed().conversationId).toBe(HEAD);
  // A person's card pushes a second sheet; Back appears and names the one under it.
  await act(async () => { mapProps.at(-1).onOpenObject({ kind: "person", id: "fixture-user-sam" }); });
  expect(replaced.at(-1)).toBe("/org/@fixture-user-sam");
  await screen.render();
  expect(q("[data-company-sheet='person:fixture-user-sam']", screen.el)).not.toBeNull();
  expect(q("[data-sheet-back]", screen.el)!.textContent).toContain((await import("./orgStaffingTypes")).roleWords((useInboxStore.getState().orgTree as any).roles.find((r: any) => r.short_id === "or-1")).name);
  // Esc steps back to the role, then closes; the address follows each step.
  await press("Escape");
  expect(replaced.at(-1)).toBe("/org/or-1");
  await screen.render();
  expect(q("[data-company-sheet='role:or-1']", screen.el)).not.toBeNull();
  expect(q("[data-sheet-back]", screen.el)).toBeNull();
  await press("Escape");
  expect(replaced.at(-1)).toBe("/org");
  await screen.render();
  expect(q("[data-company-sheet]", screen.el)).toBeNull();
  expect(q("[data-org-map]", screen.el)!.getAttribute("data-map-ring")).toBe("");
  // An id that is no address (a fixture's project) opens nothing: the map
  // selects the card instead, and the screen never leaves for a scope page.
  const before = replaced.length;
  let answer: unknown;
  await act(async () => { answer = mapProps.at(-1).onOpenObject({ kind: "project", id: "proj-org" }); });
  expect(answer).toBe(false);
  expect(replaced.length).toBe(before);
  // Through it all the conversation never swapped (D5b).
  expect(embeds.every((e) => e.conversationId === HEAD)).toBe(true);
  await screen.unmount();
});

test("a narrow company pane: the sheet covers the lens, which stays mounted underneath and inert", async () => {
  env.width = 600;
  seed();
  const screen = await mount("show=map", null, "or-1");
  const sheet = q("[data-company-sheet='role:or-1']", screen.el)!;
  expect(sheet.getAttribute("data-sheet-covers")).toBe("");
  expect(q("[data-company-lens-body]", screen.el)!.hasAttribute("inert")).toBe(true);
  expect(q("[data-org-map]", screen.el)).not.toBeNull();
  // Wrapped, the map's corner rides the lens row and the filters take the row under it.
  expect(q("[data-company-head]", screen.el)!.hasAttribute("data-company-head-wraps")).toBe(true);
  expect(q("[data-map-filter-row]", screen.el)!.className).toContain("order-2 basis-full");
  // A filter picked over a covering sheet shows its result: the stack closes, then the filter applies.
  const closed: number = replaced.length;
  await act(async () => { q("[data-company-filter-pick='goals']", screen.el)!.click(); });
  expect(replaced.length).toBeGreaterThan(closed);
  expect(replaced.at(-1)).not.toContain("or-1");
  expect(replaced.at(-1)).toContain("lens=goals");
  await screen.unmount();
  env.width = 1440;
});

test("one read gate over both lenses: on a cold load the Read lens says it is reading, never a bare Personal heading", async () => {
  seed({ orgTree: null, orgProposals: {}, orgProposalChanges: {} });
  env.ready = false;
  const cold = await mount();
  try {
    await act(async () => { q("[data-company-lens-pick='read']", cold.el)!.click(); });
    const pane = q("[data-company-pane]", cold.el)!;
    expect(pane.getAttribute("data-company-pane")).toBe("read");
    expect(q("[data-org-read='loading']", pane)!.textContent).toBe("Reading the company…");
    expect(q("[data-company-document]", pane)).toBeNull();
    // The Map lens stands behind the same gate.
    await act(async () => { q("[data-company-lens-pick='map']", cold.el)!.click(); });
    expect(q("[data-company-pane='map'] [data-org-read='loading']", cold.el)).not.toBeNull();
    expect(q("[data-org-map]", cold.el)).toBeNull();
  } finally {
    await cold.unmount();
    env.ready = true;
  }
});

test("arriving by address puts the object's responsible party on the left; talking to another swaps on purpose; the chip and a proposal pick take it back to the Head of People", async () => {
  seed();
  const screen = await mount("", null, "or-1");
  // The role's own conversation, with the talking-to chip (D5a, D5d).
  expect(q("[data-company-sheet='role:or-1']", screen.el)).not.toBeNull();
  expect(lastEmbed().conversationId).toBe("fixture-growth-conv");
  // The seat is named as the map names the role.
  const growthName = (await import("./orgStaffingTypes")).roleWords((useInboxStore.getState().orgTree as any).roles.find((r: any) => r.short_id === "or-1")).name;
  expect(lastEmbed().composerPlaceholder).toBe(`Ask ${growthName}`);
  expect(q("[data-org-talking-to]", screen.el)!.textContent).toBe(`Talking to ${growthName}`);
  // Its sheet offers no Talk and no Ask: the left pane already is that seat (D6).
  expect(q("[data-sheet-talk]", screen.el)).toBeNull();
  // Back to the Head of People.
  await act(async () => { q("[data-org-back-to-head]", screen.el)!.click(); });
  expect(lastEmbed().conversationId).toBe(HEAD);
  expect(q("[data-org-talking-to]", screen.el)).toBeNull();
  // A double click on the role's card is Talk (D5c): the column swaps on purpose.
  await act(async () => { mapProps.at(-1).onTalk({ kind: "role", id: GROWTH }); });
  expect(lastEmbed().conversationId).toBe("fixture-growth-conv");
  // Picking a proposal in the strip goes back to the Head of People first, then lands on the card (D5e).
  await openRows(screen.el);
  await act(async () => { q("[data-org-strip-row='op-7'] [data-org-strip-pick]", screen.el)?.click() ?? q("[data-org-strip-row='op-7']", screen.el)!.click(); });
  expect(lastEmbed().conversationId).toBe(HEAD);
  expect(jumpOf(screen.el)).toMatch(/^m2\|/);
  await screen.unmount();
});

test("an address that names a proposal keeps the Head of People on the left, where its card is, whatever sheet it opens (D5e over D5a)", async () => {
  seed();
  const screen = await mount("proposal=op-7", null, "or-1");
  expect(q("[data-company-sheet='role:or-1']", screen.el)).not.toBeNull();
  expect(lastEmbed().conversationId).toBe(HEAD);
  expect(q("[data-org-talking-to]", screen.el)).toBeNull();
  await screen.unmount();
});

test("New ▸ Goal writes the goal at once and opens its sheet with the name ready to type, before the server answers", async () => {
  seed({ currentUser: { _id: "fixture-user-me", name: "Ashot" } });
  const screen = await mount();
  const created: any[] = [];
  const real = useInboxStore.getState().createInitiative;
  useInboxStore.setState({ createInitiative: (input: any) => { created.push(input); real(input); } } as any);
  const trigger = q("[data-org-new]", screen.el)!;
  await act(async () => { trigger.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { q("[data-org-new-goal]")!.click(); });
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ title: "Untitled goal", owner: { kind: "user", user_id: "fixture-user-me" }, workspace: "team" });
  // The stub is in the store under its key, and the sheet opens on it.
  expect(useInboxStore.getState().initiatives[created[0].client_key]).toMatchObject({ title: "Untitled goal", short_id: "" });
  expect(replaced.at(-1)).toBe(`/org/${created[0].client_key}`);
  useInboxStore.setState({ createInitiative: real } as any);
  await screen.unmount();
});

test("New ▸ Goal: a name typed while the server answers survives the stub becoming its row; once named, the title opens as a heading", async () => {
  seed({ currentUser: { _id: "fixture-user-me", name: "Ashot" } });
  const screen = await mount();
  renames.length = 0;
  await act(async () => { q("[data-org-new]", screen.el)!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { q("[data-org-new-goal]")!.click(); });
  await screen.render();
  // The closing menu lets go of focus; the name takes it on the next frame.
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  // The sheet is open on the stub, by its key.
  const key = routeId!;
  expect(useInboxStore.getState().initiatives[key]).toMatchObject({ short_id: "" });
  const sheet = q("[data-company-sheet]", screen.el)!;
  const input = q("[data-sheet-title-input]", screen.el) as HTMLInputElement;
  expect(input).not.toBeNull();
  expect(document.activeElement === input).toBe(true);
  // The person types the name.
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
  expect(routeId).toBe("in-12");
  expect(q("[data-company-sheet]", screen.el)!.getAttribute("data-company-sheet")).toBe("initiative:in-12");
  // The same sheet, the same field, the typed name still in it.
  expect(q("[data-company-sheet]", screen.el) === sheet).toBe(true);
  expect(q("[data-sheet-title-input]", screen.el) === input).toBe(true);
  expect(input.value).toBe("Grow the pipeline");
  // Enter names it; the title is a heading from then on, here and on a return.
  await act(async () => { input.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(renames).toEqual(["in-12:Grow the pipeline"]);
  expect(q("[data-sheet-title-input]", screen.el)).toBeNull();
  await act(async () => { mapProps.at(-1)?.onOpenObject?.({ kind: "role", id: GROWTH }); });
  await screen.render();
  await press("Escape");
  await screen.render();
  expect(q("[data-company-sheet]", screen.el)!.getAttribute("data-company-sheet")).toBe("initiative:in-12");
  expect(q("[data-sheet-title-input]", screen.el)).toBeNull();
  await screen.unmount();
});
