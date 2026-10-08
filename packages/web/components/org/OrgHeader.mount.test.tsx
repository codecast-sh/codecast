// Mounts the org header with a mission only an open proposal would set: it
// reads as a ghost (the mission in violet, a quiet "proposed · op-N" tag), not
// as a lowercase "proposed mission:" prefix, and either part scrolls the
// conversation to the proposal's card (D8).
// Run: bun test components/org/OrgHeader.mount.test.tsx
import { expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

test("a proposed mission reads as a ghost in the header and opens its card", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { mock } = await import("bun:test");
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { createRoot } = await import("react-dom/client");
  const { OrgHeader } = await import("./OrgHeader");
  const asked: [string, number | undefined][] = [];
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => {
    root.render(React.createElement(OrgHeader, {
      tree: null, workspaceName: "Union", mission: null,
      proposedMission: { title: "Broker high-value introductions", proposal: "op-54", seq: 1 },
      onProposal: (ref: string, seq?: number) => { asked.push([ref, seq]); },
      isAdmin: false, phone: false, meId: "me", onCreateRole: () => {}, onHistory: () => {},
    }));
  });
  const header = document.querySelector("[data-org-header]")!;
  const ghost = header.querySelector("[data-org-mission-ghost]") as HTMLElement;
  expect(ghost.textContent).toBe("Broker high-value introductions");
  expect(ghost.style.color).toBe("var(--sol-violet)");
  expect(header.querySelector("[data-org-mission-tag]")!.textContent).toBe("proposed · op-54");
  expect(header.textContent).not.toContain("proposed mission:");
  await React.act(async () => { (header.querySelector("[data-org-mission-tag]") as HTMLElement).dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  await React.act(async () => { ghost.dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  expect(asked).toEqual([["op-54", 1], ["op-54", 1]]);
  await React.act(async () => root.unmount());
  closeDomWindow(dom);
});
