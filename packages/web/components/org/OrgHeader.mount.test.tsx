// The Org header (essence spec §4.1, §4.3): "Org", New and a menu of
// History, Review the org now and Reset org. No workspace name, no mission,
// no hiring words.
// Run: bun test components/org/OrgHeader.mount.test.tsx
import { expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

test("the header is Org, New and the menu; the menu holds History, Review the org now and Reset org", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const React = await import("react");
  const { mock } = await import("bun:test");
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { createRoot } = await import("react-dom/client");
  const { OrgHeader } = await import("./OrgHeader");
  const did: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const draw = (extra: Record<string, unknown>) => React.act(async () => {
    root.render(React.createElement(OrgHeader, {
      tree: null, isAdmin: true, meId: "me", onCreateRole: () => {}, onHistory: () => did.push("history"),
      onOpen: () => {}, ...extra,
    }));
  });
  await draw({ onReview: () => did.push("review"), onReset: () => did.push("reset") });
  const header = document.querySelector("[data-org-header]")!;
  expect(header.querySelector("[data-org-title]")!.textContent).toBe("Org");
  expect(header.querySelector("[data-org-new]")).not.toBeNull();
  expect(header.textContent).not.toMatch(/exists to|Personal|Team|Hire|This week|Words/);
  // The menu opens on a key, as Radix's trigger does.
  const more = header.querySelector("[data-org-more]") as HTMLElement;
  await React.act(async () => { more.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const items = [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);
  expect(items).toEqual(["History", "Review the org now", "Reset org…"]);
  await React.act(async () => { (document.querySelector("[data-org-review-now]") as HTMLElement).click(); });
  expect(did).toEqual(["review"]);
  // Without a review (the org feature off) or a reset (not an admin), those items are absent.
  await draw({});
  await React.act(async () => { more.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect([...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent)).toEqual(["History"]);
  await React.act(async () => root.unmount());
  closeDomWindow(dom);
});
