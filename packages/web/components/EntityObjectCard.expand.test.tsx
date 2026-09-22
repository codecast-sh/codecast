// Mounts ObjectCardFrame in jsdom and checks what expanding changes: the
// surface keeps its colour and shape (only the border raise says open), and
// the corner controls collapse to the chevron because the footer carries
// Open and the full-page toggle once the card is open.
// Run: bun test --timeout 120000 components/EntityObjectCard.expand.test.tsx
import { test, expect, beforeAll, mock } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("./EntityObjectCard");
let ACCENT: typeof import("../lib/entityCardAccent").ACCENT;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  const h = React.createElement;
  mock.module("./RoutePane", () => ({ RoutePane: () => h("div", null, "page") }));
  mock.module("./stage/SessionPane", () => ({ SessionPane: () => h("div", null, "session") }));
  const realShortcuts = { ...(await import("../shortcuts")) };
  mock.module("../shortcuts", () => ({ ...realShortcuts, hasOpenModal: () => false, isEditableTarget: () => false }));
  mock.module("../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
  const realStage = { ...(await import("../lib/stage")) };
  mock.module("../lib/stage", () => ({ ...realStage, canOpenBeside: () => true }));
  const realOpenIntent = { ...(await import("../lib/openIntent")) };
  mock.module("../lib/openIntent", () => ({ ...realOpenIntent, openIn() {} }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
  mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }) }));
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./EntityObjectCard");
  ({ ACCENT } = await import("../lib/entityCardAccent"));
}, 120_000);

function mount(ui: React.ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(ui));
  return root;
}

const card = () => document.querySelector<HTMLElement>(".entity-card")!;
const openLinks = (scope: Element) => scope.querySelectorAll(".object-reveal-open-compact").length;
const expand = () => React.act(() => card().dispatchEvent(new MouseEvent("click", { bubbles: true })));

function frame(flat: boolean) {
  const h = React.createElement;
  return h(mod.ObjectCardFrame, {
    accent: ACCENT.session,
    count: 1,
    ariaLabel: "Read-only incident investigation",
    href: "/conversation/jx7cwtb",
    openLabel: "Open session",
    footerId: "jx7cwtb",
    resolved: true,
    served: true,
    header: flat ? undefined : { icon: h("i"), title: "Read-only incident investigation" },
    flatBody: flat ? () => h("div", null, "body") : undefined,
    snippet: h("div", null, "snippet"),
    detail: h("div", null, "detail"),
  });
}

for (const flat of [true, false]) {
  test(`${flat ? "a flat" : "a header"} card keeps its surface when it opens; the corner drops to the chevron and the footer carries Open`, () => {
    const root = mount(frame(flat));
    const closed = card().className;
    expect(closed).toContain("bg-sol-card");
    expect(closed).toContain("rounded-md");
    const corner = card().firstElementChild!;
    expect(openLinks(corner)).toBe(1);

    expand();
    expect(card().getAttribute("aria-expanded")).toBe("true");
    const open = card().className;
    expect(open).toContain("bg-sol-card");
    expect(open).toContain("rounded-md");
    expect(open).not.toContain("bg-sol-bg");
    expect(open).not.toContain("shadow-xl");
    expect(open).toContain(ACCENT.session.borderOpen);

    const cornerOpen = card().firstElementChild!;
    expect(openLinks(cornerOpen)).toBe(0);
    expect(cornerOpen.querySelector("svg")).not.toBeNull(); // the chevron stays
    expect(openLinks(card().querySelector(".entity-card-expand")!)).toBe(1);
    React.act(() => root.unmount());
  });
}
