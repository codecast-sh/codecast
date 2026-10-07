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

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "DOMMatrixReadOnly"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => { delete process.env.DEV; closeDomWindow(dom); });

const React = await import("react");
const h = React.createElement;
const { act } = React;

// The screen's world: its address (written back through the router), its
// width, and what the tree feeder reports.
let search = "";
const replaced: string[] = [];
const router = { push(path: string) { replaced.push(path); }, replace(path: string) { replaced.push(path); search = path.split("?")[1] ?? ""; } };
const env = { width: 1440 as number | null, ready: true, missing: false, refused: false, error: null as { message: string } | null };
const calls: string[] = [];
const embeds: any[] = [];
let hover: ((id: string | null) => void) | null = null;

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(search), usePathname: () => "/org" }));
const realOpen = { ...(await import("../../hooks/useOpenLinkedSession")) };
mock.module("../../hooks/useOpenLinkedSession", () => ({ ...realOpen, useOpenLinkedSession: () => (row: { _id: string }) => calls.push(`open:${row._id}`) }));
mock.module("../../hooks/useMeasuredWidth", () => ({ useMeasuredWidth: () => ({ width: env.width, measureRef: () => {} }) }));
const realPhone = { ...(await import("../../hooks/useIsPhone")) };
mock.module("../../hooks/useIsPhone", () => ({ ...realPhone, useIsPhone: () => false, useMinWidth: () => true }));
const realSwitch = { ...(await import("../../hooks/useSwitchWorkspace")) };
mock.module("../../hooks/useSwitchWorkspace", () => ({ ...realSwitch, useSwitchWorkspace: () => async (teamId: string | null) => { calls.push(`switch:${teamId}`); } }));
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => ({ roles: [], proposals: 0 }) }));
const noThrow = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
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
// The map echoes what the screen hands it.
const realMap = { ...(await import("./OrgMap")) };
mock.module("./OrgMap", () => ({ ...realMap, OrgMap: (p: any) => h("div", { "data-org-map": p.filter, "data-map-proposed": p.asProposed ? "on" : "off", "data-map-highlight": p.highlightChangeId ?? "", "data-map-changes": p.proposal?.changes.length ?? 0, "data-map-focus": p.focusTarget ? `${p.focusTarget.id}#${p.focusTarget.seq}` : "" }) }));
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
const { ORG_FIXTURE, ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");

const HEAD = "fixture-head-conv";
const AUTHOR = { kind: "role" as const, id: "fixture-role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const T0 = 1_700_000_000_000;
const row = (n: number, extra: Record<string, unknown> = {}) => ({ _id: `p${n}`, short_id: `op-${n}`, team_id: "fixture-team", author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open", created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, counts: { total: 3, decided: 0, applied: 0, failed: 0, skipped: 0 }, ...extra });
const change = (proposal_id: string, seq: number) => ({ _id: `${proposal_id}-c${seq}`, proposal_id, seq, change: { kind: "role", name: `Role ${seq}`, handle: `role-${seq}`, reports_to: "me", scope: { projects: [] } }, rationale: "", evidence: [], status: "proposed" });
const MESSAGES = [
  { _id: "m1", role: "assistant", content: "Here is my review of the org.", timestamp: T0 },
  { _id: "m2", role: "assistant", content: "op-7", timestamp: T0 + 1 },
  { _id: "m3", role: "user", content: "Thanks, looking.", timestamp: T0 + 2 },
];
function seed(overrides: Record<string, unknown> = {}) {
  useInboxStore.setState({
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
    clientState: { ui: { org_intro_seen: true } },
    ...overrides,
  } as any);
}

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];
const lastEmbed = () => embeds.at(-1)!;
const jumpOf = (el: ParentNode) => q("[data-embed]", el)?.getAttribute("data-embed-jump") ?? null;
const findOf = (el: ParentNode) => q("[data-embed]", el)?.getAttribute("data-embed-find") ?? null;

const { TabParamsCtx } = await import("../../lib/tabParams");
type TabCtx = NonNullable<React.ContextType<typeof TabParamsCtx>>;
/** The pane scope a stage leaf (or a plain tab, with no leafId) hands the page. */
const tabScope = (tabId: string, leafId?: string): TabCtx => ({ tabId, pathname: "/org", params: {}, searchParams: new URLSearchParams(search), isActive: true, isVisible: true, leafId });

async function mount(address = "", scope: TabCtx | null = null) {
  search = address;
  replaced.length = 0;
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
  // The head row is the face and the name; the state line's one home is the thread's pinned panel.
  expect(q("[data-org-conversation-head]", el)!.textContent).toBe("Head of People");
  expect(q("[data-org-column='conversation']", el)).not.toBeNull();
  expect(q("[data-org-column='map']", el)).not.toBeNull();
  expect(useInboxStore.getState().conversations[HEAD]).toMatchObject({ _id: HEAD });
  // The strip is one line; its rows, behind the chevron, are the open proposals of
  // this workspace, oldest first; the resolved one and the other workspace's are not rows.
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("2 proposals wait on you·6 changes");
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
  // The header carries the three controls and nothing about hiring.
  expect(q("[data-org-health-link]", el)!.getAttribute("href")).toBe("/org?view=health");
  expect(q("[data-org-add-role]", el)).not.toBeNull();
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
  expect(replaced.some((p) => p.includes("view=health"))).toBe(false);
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
  expect(q("[data-org-strip-head]", leaf.el)!.textContent).toBe("2 proposals wait on you·6 changes·1 answered, waiting for your send");
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
