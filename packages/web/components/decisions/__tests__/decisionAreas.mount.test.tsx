import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// The Team view's area controls (DecisionAreas.tsx). Change areas shows the
// current map, maps the words through the server (stubbed here) into a
// preview with the changed people marked, and only Apply writes it. Share out
// reads who would get what, shows it in the shared confirm, and writes
// nothing until the confirm.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/decisions" });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  HTMLElement: w.HTMLElement,
  HTMLInputElement: w.HTMLInputElement,
  HTMLTextAreaElement: w.HTMLTextAreaElement,
  HTMLButtonElement: w.HTMLButtonElement,
  Element: w.Element,
  Node: w.Node,
  MutationObserver: w.MutationObserver,
  DocumentFragment: w.DocumentFragment,
  KeyboardEvent: w.KeyboardEvent,
  Event: w.Event,
  CustomEvent: w.CustomEvent,
  NodeFilter: w.NodeFilter,
  localStorage: w.localStorage,
  getComputedStyle: w.getComputedStyle.bind(w),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { ChangeAreasView, ShareOutView, TeamAreaControls } = await import("../DecisionAreas");
const { ConvexProvider } = await import("convex/react");
// The controls only bind their server calls on mount; nothing here calls them.
const Controls = ({ workspace }: { workspace: string }) => <ConvexProvider client={{} as any}><TeamAreaControls workspace={workspace} /></ConvexProvider>;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
afterAll(async () => { await tick(); restoreGlobals(); });

const applied: any[] = [];
const shared: any[] = [];
beforeEach(() => {
  applied.length = 0;
  shared.length = 0;
  w.document.body.innerHTML = "";
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Ashot" },
    teamMembers: [
      { _id: "u1", name: "Ashot", role: "admin", focus_project_ids: [] },
      { _id: "u2", name: "Samvit", role: "member", focus_project_ids: ["p1"] },
      { _id: "u3", name: "Jason", role: "member", focus_project_ids: [] },
      { _id: "b1", name: "Mr Bot", role: "member", is_bot: true, focus_project_ids: ["p1"] },
    ],
    projects: { p1: { _id: "p1", title: "Deal flow" }, p2: { _id: "p2", title: "Desk" } },
    applyDecisionAreas: (...args: any[]) => applied.push(args),
    shareOutDecisions: (...args: any[]) => shared.push(args),
  } as any);
});

async function mount(ui: React.ReactNode) {
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: async () => { await act(async () => root.unmount()); await tick(); } };
}
const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new w.Event("input", { bubbles: true })); });
}

test("only an admin sees the area controls on the Team view", async () => {
  const a = await mount(<Controls workspace="team:t1" />);
  expect(q("[data-team-area-controls]")).not.toBeNull();
  await a.unmount();
  useInboxStore.setState({ currentUser: { _id: "u2", name: "Samvit" } } as any);
  const b = await mount(<Controls workspace="team:t1" />);
  expect(q("[data-team-area-controls]")).toBeNull();
  await b.unmount();
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Ashot" } } as any);
  const c = await mount(<Controls workspace="user:u1" />);
  expect(q("[data-team-area-controls]")).toBeNull();
  await c.unmount();
});

test("Change areas: the current map, then the words' map marked where it changes, and only Apply writes it", async () => {
  const calls: any[] = [];
  const mapWords = async (team: string, words: string) => {
    calls.push([team, words]);
    return {
      assignments: [
        { user_id: "u1", name: "Ashot", takes_decisions: true, projects: [] },
        { user_id: "u2", name: "Samvit", takes_decisions: true, projects: [{ id: "p1", title: "Deal flow" }] },
        { user_id: "u3", name: "Jason", takes_decisions: true, projects: [{ id: "p2", title: "Desk" }] },
      ],
      unplaced: ["calling"],
      text: "Samvit: Deal flow; Jason: Desk",
    };
  };
  const { container, unmount } = await mount(<ChangeAreasView teamId="t1" mapWords={mapWords} />);
  await click(container.querySelector("[data-change-areas]"));
  expect(q("[data-change-areas-dialog]")).not.toBeNull();
  // The current map: people, never bots, with what they cover; the box holds it in words.
  expect([...w.document.querySelectorAll("[data-areas-person]")].map((e: any) => e.getAttribute("data-areas-person"))).toEqual(["Ashot", "Samvit", "Jason"]);
  expect(q('[data-areas-person="Samvit"]')!.textContent).toContain("Deal flow");
  const box = q("[data-areas-words]") as HTMLTextAreaElement;
  expect(box.value).toBe("Samvit: Deal flow");
  expect((q("[data-areas-map-words]") as HTMLButtonElement).disabled).toBe(true);

  await type(box, "Samvit: deals and calling; Jason: desk");
  await click(q("[data-areas-map-words]"));
  expect(calls).toEqual([["t1", "Samvit: deals and calling; Jason: desk"]]);
  expect(q('[data-areas-person="Jason"]')!.getAttribute("data-changed")).toBe("true");
  expect(q('[data-areas-person="Samvit"]')!.getAttribute("data-changed")).toBeNull();
  expect(q("[data-areas-unplaced]")!.textContent).toContain("calling");
  expect(applied).toEqual([]);

  await click(q("[data-areas-apply]"));
  expect(applied).toEqual([["t1", [
    { user_id: "u1", project_ids: [], takes_decisions: true },
    { user_id: "u2", project_ids: ["p1"], takes_decisions: true },
    { user_id: "u3", project_ids: ["p2"], takes_decisions: true },
  ]]]);
  expect(q("[data-change-areas-dialog]")).toBeNull();
  await unmount();
});

test("Change areas: a refusal is shown, and nothing is written", async () => {
  const { container, unmount } = await mount(<ChangeAreasView teamId="t1" mapWords={async () => ({ error: "The team's model budget has no room this month" })} />);
  await click(container.querySelector("[data-change-areas]"));
  await type(q("[data-areas-words]") as HTMLTextAreaElement, "Jason: desk");
  await click(q("[data-areas-map-words]"));
  expect(q("[data-areas-error]")!.textContent).toBe("The team's model budget has no room this month");
  expect(q("[data-areas-apply]")).toBeNull();
  expect(applied).toEqual([]);
  await unmount();
});

const PREVIEW = {
  moves: [
    { decision_id: "d1", from: "u1", to: "u2", short_id: "sd-1", question: "Which buyer first?" },
    { decision_id: "d2", from: "u1", to: "u3", short_id: "sd-2", question: "Desk rota?" },
    { decision_id: "d3", from: null, to: "u2", short_id: "sd-3", question: "Intro to Marex?" },
  ],
  to: [{ user_id: "u2", name: "Samvit", count: 2 }, { user_id: "u3", name: "Jason", count: 1 }],
  considered: 5,
  unmatched: 1,
};

test("Share out: reads who gets what, shows it in the confirm, and moves nothing until the confirm", async () => {
  let reads = 0;
  const { container, unmount } = await mount(<ShareOutView teamId="t1" readPreview={async () => { reads++; return PREVIEW; }} />);
  expect(q("[data-switch-review]")).toBeNull();
  await click(container.querySelector("[data-share-out]"));
  expect(reads).toBe(1);
  const review = q("[data-switch-review]")!;
  expect(review.getAttribute("data-switch-review")).toBe("Share out");
  expect(q('[data-switch-figure="move"]')!.textContent).toBe("3");
  expect(q('[data-switch-figure="people"]')!.textContent).toBe("2");
  expect(q('[data-switch-figure="stay"]')!.textContent).toBe("2");
  expect(q('[data-switch-row="Samvit"]')!.textContent).toContain("2");
  expect(q("[data-switch-confirm]")!.textContent).toContain("Share out 3");
  expect(shared).toEqual([]);

  // Backing out writes nothing.
  await click(q("[data-switch-cancel]"));
  await tick();
  expect(q("[data-switch-review]")).toBeNull();
  expect(shared).toEqual([]);

  await click(container.querySelector("[data-share-out]"));
  await click(q("[data-switch-confirm]"));
  expect(shared).toEqual([["t1", [{ decision_id: "d1", to: "u2" }, { decision_id: "d2", to: "u3" }, { decision_id: "d3", to: "u2" }]]]);
  await unmount();
});

test("Share out: nothing to move cannot be confirmed; a refusal shows beside the button", async () => {
  const empty = { moves: [], to: [], considered: 2, unmatched: 2 };
  const a = await mount(<ShareOutView teamId="t1" readPreview={async () => empty} />);
  await click(a.container.querySelector("[data-share-out]"));
  expect((q("[data-switch-confirm]") as HTMLButtonElement).disabled).toBe(true);
  await a.unmount();
  w.document.body.innerHTML = "";
  const b = await mount(<ShareOutView teamId="t1" readPreview={async () => ({ error: "Only a team admin shares decisions out" })} />);
  await click(b.container.querySelector("[data-share-out]"));
  expect(q("[data-switch-review]")).toBeNull();
  expect(q("[data-share-out-error]")!.textContent).toBe("Only a team admin shares decisions out");
  await b.unmount();
});
