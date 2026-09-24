// Mounts the waiting-burst group row and checks what the popup promises: one
// line for the whole burst, the sessions hidden until asked for, and every
// member reachable in one click once it opens.
// Run: bun test components/__tests__/notificationGroupRow.mount.test.tsx
import { describe, expect, test } from "bun:test";

const conv = (id: string, title: string) => ({ _id: id, title, agent_type: "claude_code" });
const idle = (id: string, title: string, at: number) => ({
  _id: id,
  type: "session_idle",
  message: `${title} is waiting`,
  created_at: at,
  read: false,
  conversation_id: id,
  conversation: conv(id, title),
});

describe("NotificationGroupRow", () => {
  test("collapses a burst to one line, opens to its sessions, and each opens", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    const DOM_GLOBAL = /^(window|document|navigator|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|Node|NodeFilter|Element|Text|Range|Selection|Document\w*|MutationObserver|DOMRect\w*|HTML\w*Element|SVG\w*Element|\w*Event)$/;
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (DOM_GLOBAL.test(key)) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    const { NotificationGroupRow } = await import("../notifications/NotificationRow");
    const { groupIdleNotifications } = await import("@codecast/shared/contracts");

    const rows = [
      { _id: "d1", type: "sessions_need_input", message: "old text", created_at: 3000, read: false },
      idle("i3", "Ship the CLI", 2500),
      idle("i2", "Auth refactor", 2200),
      idle("i1", "Fix the parser", 2000),
    ];
    const entries = groupIdleNotifications(rows as any, (n: any) => String(n._id));
    expect(entries.length).toBe(1);
    const group = entries[0] as any;

    const opened: string[] = [];
    let open = false;
    const root = createRoot(document.getElementById("root")!);
    const render = () =>
      act(async () => {
        root.render(
          React.createElement(NotificationGroupRow, {
            group,
            open,
            onToggle: () => { open = !open; },
            onOpen: (n: any) => opened.push(n._id),
          })
        );
      });

    await render();
    // One line for the burst, worded from the sessions it actually holds —
    // not the fold-up row's frozen text.
    const text = document.body.textContent || "";
    expect(text).toContain("3 sessions");
    expect(text).toContain("Ship the CLI, Auth refactor and 1 other need your attention");
    expect(text).not.toContain("old text");
    // Collapsed: the members are not rendered.
    expect(text).not.toContain("Fix the parser is waiting");

    // The header toggles rather than navigating.
    const header = document.querySelector("button[aria-expanded]") as any;
    expect(header).toBeTruthy();
    // A session with no character still shows a mark in its face, not an
    // empty circle: the agent icon the single rows wear.
    const faces = [...header.querySelectorAll("[data-group-face]")];
    expect(faces.length).toBe(3);
    for (const face of faces) expect(face.querySelector("svg")).toBeTruthy();
    await act(async () => { header.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    expect(open).toBe(true);
    expect(opened).toEqual([]);

    await render();
    const afterOpen = document.body.textContent || "";
    expect(afterOpen).toContain("Fix the parser is waiting");
    // Every member is one click from the open group.
    const memberButtons = [...document.querySelectorAll("button")].filter((b) => !b.hasAttribute("aria-expanded"));
    expect(memberButtons.length).toBe(3);
    await act(async () => { memberButtons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    expect(opened).toEqual(["i3"]);

    await act(async () => { root.unmount(); });
  }, 30000);
});
