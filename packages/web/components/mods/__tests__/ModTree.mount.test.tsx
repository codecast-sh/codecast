import { test, expect, describe, mock } from "bun:test";

// Every element a mod can return, drawn in jsdom through the real renderer
// and the real store: the regression net for the element table (contract:
// shared/contracts/mods.ts MOD_ELEMENTS). No convex/react mock: nothing here
// queries, and bun shares module mocks across the files of one run.
mock.module("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const { JSDOM } = await import("jsdom");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { replaceGlobals } = await import("../../../test-helpers/globals");
const { useInboxStore } = await import("../../../store/inboxStore");
const { MOD_ELEMENTS } = await import("@codecast/shared/contracts/mods");
const { ConvexProvider, ConvexReactClient } = await import("convex/react");
const { ModTree } = await import("../ModTree");
const { ObjectsPage } = await import("../ObjectsPage");
const { ObjectPage } = await import("../ObjectPage");

(globalThis as any).__inboxStore = useInboxStore;

async function mount(node: React.ReactNode): Promise<{ html: string; root: HTMLElement; done: () => Promise<void> }> {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://codecast.test/m/x/main" });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver });
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  await act(() => root.render(<ConvexProvider client={client}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>));
  return { html: el.innerHTML, root: el as unknown as HTMLElement, done: async () => { await act(() => root.unmount()); restore(); } };
}

const fn = (id: string) => ({ $fn: id });

// A Ref is the real entity pill, which subscribes to queries: a client whose
// socket never opens lets it render its fallback, as it does offline.
class NoSocket { readyState = 0; onopen = null; onclose = null; onmessage = null; onerror = null; send() {} close() {} }
const client = new ConvexReactClient("https://example.convex.cloud", { webSocketConstructor: NoSocket as any, unsavedChangesWarning: false });

const EVERY: any = {
  t: "Column", p: { gap: 3 }, c: [
    { t: "Row", p: { gap: 2 }, c: [{ t: "Text", p: { tone: "blue", weight: "bold" }, c: ["hello"] }, { t: "Badge", p: { tone: "green", dot: true }, c: ["ok"] }] },
    { t: "Box", p: { direction: "row", border: true, onPress: fn("k#1") }, c: ["box"] },
    { t: "Grid", p: { columns: 2 }, c: [{ t: "Stat", p: { label: "Working", value: 7, tone: "blue", delta: "+2" } }, { t: "Stat", p: { label: "Done", value: 3 } }] },
    { t: "Card", p: { title: "Card title", subtitle: "sub", actions: { t: "Button", p: { label: "Act", onPress: fn("k#2") } } }, c: [{ t: "Heading", p: { level: 2 }, c: ["Heading"] }] },
    { t: "Button", p: { label: "Primary", variant: "primary", icon: "plus", onPress: fn("k#3") } },
    { t: "Input", p: { value: "typed", placeholder: "p", onSubmit: fn("k#4") } },
    { t: "TextArea", p: { value: "area", rows: 2 } },
    { t: "Select", p: { value: "b", options: ["a", { value: "b", label: "Bee" }] } },
    { t: "Toggle", p: { value: true, label: "Toggle me" } },
    { t: "Table", p: { rows: [{ _id: "1", name: "row one", n: 1200, at: Date.now() - 60_000 }], columns: [{ key: "name" }, { key: "n", as: "number" }, { key: "at", as: "time" }], onRowPress: fn("k#5") } },
    { t: "Tabs", c: [{ t: "Tab", p: { id: "a", label: "First", count: 2 }, c: ["first tab"] }, { t: "Tab", p: { id: "b", label: "Second" }, c: ["second tab"] }] },
    { t: "Ref", p: { id: "ct-1", label: "a task" } },
    { t: "Markdown", p: { text: "**bold** text" } },
    { t: "Code", p: { code: "const x = 1;", lang: "ts" } },
    { t: "Progress", p: { value: 40, label: "Progress" } },
    { t: "Divider", p: { label: "section" } },
    { t: "Spacer", p: { size: 2 } },
    { t: "Icon", p: { name: "bug" } },
    { t: "Link", p: { href: "/tasks" }, c: ["tasks"] },
    { t: "Link", p: { href: "javascript:alert(1)" }, c: ["evil"] },
    { t: "Image", p: { src: "https://example.com/x.png", alt: "pic" } },
    { t: "Image", p: { src: "http://insecure.example.com/x.png", alt: "nope" } },
    { t: "Kbd", p: { keys: "Ctrl+K" } },
    { t: "Empty", p: { title: "Nothing", hint: "hint" } },
    { t: "List", p: { divided: true }, c: [{ t: "Item", p: { title: "item", subtitle: "s", icon: "box", trailing: { t: "Badge", c: ["t"] }, onPress: fn("k#6") } }] },
    { t: "Time", p: { at: Date.now() - 3_600_000 } },
    { t: "Avatar", p: { name: "Ada Lovelace" } },
    { t: "Sparkline", p: { values: [1, 3, 2, 5] } },
    { t: "Chart", p: { spec: { marks: [] } } },
    { t: "Canvas", p: { html: "<b>canvas</b><script>alert(1)</script>" } },
    { t: "Marquee", c: ["not an element"] },
  ],
};

describe("ModTree", () => {
  test("the fixture uses every element the contract lists", () => {
    const used = new Set<string>();
    const walk = (n: any) => { if (n && typeof n === "object") { used.add(n.t); (n.c ?? []).forEach(walk); for (const v of Object.values(n.p ?? {})) walk(v); } };
    walk(EVERY);
    expect(MOD_ELEMENTS.filter((e) => !used.has(e))).toEqual([]);
  });

  test("every element draws, handlers press through to the mod, and unsafe input is dropped", async () => {
    const pressed: [string, unknown[]][] = [];
    const m = await mount(<ModTree tree={EVERY} invoke={(f, a) => pressed.push([f, a])} navigate={() => {}} />);
    try {
      for (const text of ["hello", "Card title", "Heading", "Primary", "row one", "1,200", "first tab", "Toggle me", "Bee", "Nothing", "item", "Progress", "section"]) {
        expect(m.html).toContain(text);
      }
      expect(m.html).not.toContain("second tab");
      expect(m.html).toContain("unknown element");
      expect(m.html).toContain("Marquee");
      expect(m.html).not.toContain("javascript:");
      expect(m.html).not.toContain("http://insecure");
      expect(m.html).not.toContain("<script");
      const doc = (globalThis as any).document as Document;
      const click = (el: Element | null) => el?.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true }));
      await act(async () => { click([...doc.querySelectorAll("button")].find((b) => b.textContent?.includes("Act")) ?? null); });
      await act(async () => { click(doc.querySelector("tbody tr")); });
      expect(pressed.map(([f]) => f)).toContain("k#2");
      const row = pressed.find(([f]) => f === "k#5");
      expect((row?.[1][0] as any)?.name).toBe("row one");
    } finally {
      await m.done();
    }
  });
});

describe("object pages", () => {
  const seed = () => useInboxStore.setState({
    currentUser: { _id: "u1", name: "Me" },
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: undefined } },
    mods: { m1: { _id: "m1", name: "bug-desk", title: "Bug Desk", is_mine: true, enabled: true, code: "", rev: 1, version: 0, updated_at: 1,
      manifest: { name: "bug-desk", objects: [{ prefix: "bug", title: "Bug", plural: "Bugs", statuses: ["triage", "open", "fixed"], fields: { severity: { type: "enum", options: ["p0", "p1"] }, area: { type: "text" } } }] } } },
    modObjects: {
      o1: { _id: "o1", user_id: "u1", workspace: "user:u1", short_id: "bug-1", prefix: "bug", title: "First bug", status: "triage", fields: { severity: "p0", area: "web" }, updated_at: 2, created_at: 1 },
      o2: { _id: "o2", user_id: "u1", workspace: "user:u1", short_id: "bug-2", prefix: "bug", title: "Done bug", status: "fixed", fields: {}, updated_at: 1, created_at: 1 },
      o3: { _id: "o3", user_id: "u9", workspace: "team:other", short_id: "bug-1", prefix: "bug", title: "Someone else's", status: "open", fields: {}, updated_at: 5, created_at: 5 },
    },
  } as any);

  test("a kind's list shows this workspace's objects as a board by status", async () => {
    seed();
    const m = await mount(<ObjectsPage prefix="bug" />);
    try {
      expect(m.html).toContain("Bugs");
      expect(m.html).toContain("First bug");
      expect(m.html).toContain("Done bug");
      expect(m.html).not.toContain("Someone else");
      expect(m.html).toContain("triage");
    } finally { await m.done(); }
  });

  test("an object's page edits through the store at once", async () => {
    seed();
    const m = await mount(<ObjectPage id="bug-1" />);
    try {
      expect(m.html).toContain("p0");
      const doc = (globalThis as any).document as Document;
      const open = [...doc.querySelectorAll("button")].find((b) => b.textContent === "open")!;
      await act(async () => { open.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true })); });
      const row = Object.values((useInboxStore.getState() as any).modObjects).find((r: any) => r.short_id === "bug-1" && r.workspace === "user:u1") as any;
      expect(row.status).toBe("open");
    } finally { await m.done(); }
  });
});
