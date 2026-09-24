import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/team/activity", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  location: dom.window.location, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  indexedDB: new IDBFactory(), IDBKeyRange,
});
afterAll(() => { closeDomWindow(dom); restore(); });

const convexReact = { ...(await import("convex/react")) };
const client = { query: async () => ({ conversations: [], nextCursor: null }), mutation: async () => null };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => client, useMutation: () => async () => null }));
const navigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...navigation, useRouter: () => ({ push() {}, replace() {} }) }));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const cache = await import("../../store/idbCache");
let hydrated!: () => void;
const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
const setHydrating = cache.setHydrating;
const hydrationSpy = spyOn(cache, "setHydrating").mockImplementation((value) => {
  setHydrating(value);
  if (!value) hydrated();
});
const { useInboxStore } = await import("../../store/inboxStore");
await hydration;
hydrationSpy.mockRestore();
const { ActivityFeed } = await import("../ActivityFeed");
const { settingsDataKey } = await import("../../lib/settingsData");

const TEAM = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";
const ME = "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7";
const ROSTER = settingsDataKey("teamMembers", ME, TEAM)!;
const NOW = Date.now();
const row = (_id: string, user_id: string, author_name: string, extra = {}) => ({
  _id, user_id, author_name, title: `${author_name} session`, updated_at: NOW, started_at: NOW - 60_000,
  duration_ms: 60_000, message_count: 2, is_active: false, is_own: user_id === ME, ...extra,
});
const roster = (ids: string[]) => ({ [ROSTER]: { _id: ROSTER, value: ids.map((_id) => ({ _id })) } });

test("current membership and org settings govern old cached feed cards, people and totals", async () => {
  const cached = [row("mine", ME, "Alexander"), row("gone", "jonathan", "Jonathan"), row("chief", ME, "Chief", { acting_user_id: "chief" })];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Alexander" }, clientStateInitialized: true,
    clientState: { ui: { active_team_id: TEAM } }, teams: [{ _id: TEAM, features: { org: true } }],
    settingsData: roster([ME, "jonathan", "chief"]), sessions: {}, externalEvents: {},
    feedConversations: { [`${TEAM}|`]: cached }, feedHasMore: { [`${TEAM}|`]: false }, feedCursors: { [`${TEAM}|`]: null },
    pendingInput: { untouched: { text: "keep my draft" } },
  } as any);
  const el = document.createElement("div"); document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => root.render(<MemoryRouter><ActivityFeed mode="team" /></MemoryRouter>));
    expect(el.textContent).toContain("Jonathan session");
    expect(el.textContent).toContain("Chief session");
    expect(el.textContent).toMatch(/3\s*people/);
    const selectPerson = async (name: string) => {
      const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    await selectPerson("Jonathan");

    await act(async () => useInboxStore.setState({ settingsData: roster([ME, "chief"]) } as any));
    expect(el.textContent).not.toContain("Jonathan");
    expect(el.textContent).toContain("Chief session");
    expect(el.textContent).toMatch(/2\s*people/);
    await selectPerson("Chief");

    await act(async () => useInboxStore.setState({ teams: [{ _id: TEAM, features: { org: false } }] } as any));
    expect(el.textContent).not.toContain("Chief");
    expect(el.textContent).toContain("Alexander session");
    expect(el.textContent).toMatch(/1\s*session/);
    expect(el.textContent).not.toContain("people");
    expect(useInboxStore.getState().feedConversations[`${TEAM}|`]).toEqual(cached);
    expect(useInboxStore.getState().pendingInput.untouched).toEqual({ text: "keep my draft" });

    await act(async () => useInboxStore.setState({
      teams: [{ _id: TEAM, features: { org: true } }], settingsData: roster([ME, "chief"]),
      sessions: { ownRole: { ...row("ownRole", ME, "Own role"), team_id: TEAM, acting_user_id: "chief", is_private: true } },
    } as any));
    expect(el.textContent).toContain("Own role session");
    await act(async () => useInboxStore.setState({ teams: [{ _id: TEAM, features: { org: false } }] } as any));
    expect(el.textContent).not.toContain("Own role session");

    await act(async () => useInboxStore.setState({ clientState: { ui: { active_team_id: "another-team" } } } as any));
    expect(el.textContent).not.toContain("Alexander session");
  } finally {
    await act(async () => root.unmount()); el.remove();
  }
}, 30_000);
