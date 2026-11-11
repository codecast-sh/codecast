// Mods in the Modern style: a mod's enable button, the object's status picker
// and the object cards wear the primitives' looks (components/ui/modernLook.ts).
// Classic draws exactly the classes it drew before the Modern looks (the
// snapshot was taken from the unmodified pages; `modern:` classes are left out).
import { describe, expect, mock, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../../test-helpers/modernDom";

installModernDom("https://codecast.test/mods");
mock.module("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const { useInboxStore } = await import("../../../store/inboxStore");
const { ThemeContext } = await import("../../ThemeProvider");
const { ModsPage } = await import("../ModsPage");
const { ObjectPage } = await import("../ObjectPage");
const { ObjectsPage } = await import("../ObjectsPage");
const { modernChip } = await import("../../ui/modernLook");

(globalThis as any).__inboxStore = useInboxStore;
const client = offlineConvexClient("https://example.convex.cloud");

const seed = () => useInboxStore.setState({
  currentUser: { _id: "u1", name: "Me" },
  clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: undefined } },
  mods: { m1: { _id: "m1", name: "bug-desk", title: "Bug Desk", is_mine: true, enabled: true, code: "", rev: 1, version: 0, updated_at: 1,
    manifest: { name: "bug-desk", objects: [{ prefix: "bug", title: "Bug", plural: "Bugs", statuses: ["triage", "open", "fixed"], fields: {} }] } } },
  modObjects: {
    o1: { _id: "o1", user_id: "u1", workspace: "user:u1", short_id: "bug-1", prefix: "bug", title: "First bug", status: "triage", fields: {}, updated_at: 2, created_at: 1 },
  },
} as any);

async function render(style: "classic" | "modern", node: React.ReactNode) {
  seed();
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ThemeContext.Provider value={styleValue(style)}>
      <ConvexProvider client={client}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>
    </ThemeContext.Provider>,
  ));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const pages = () => <><ModsPage /><ObjectsPage prefix="bug" /><ObjectPage id="bug-1" /></>;

describe("Mods in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, unmount } = await render("classic", pages());
    expect(host.textContent).toContain("First bug");
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("the status picker is the filter chip", async () => {
    const { host, unmount } = await render("modern", pages());
    const statuses = [...host.querySelectorAll("button")].filter((b) => ["triage", "open", "fixed"].includes((b.textContent ?? "").trim()));
    expect(statuses.length).toBe(3);
    expect(wears(statuses[0], modernChip({ active: true }))).toBe(true);
    expect(wears(statuses[1], modernChip({ active: false }))).toBe(true);
    await unmount();
  });
});
