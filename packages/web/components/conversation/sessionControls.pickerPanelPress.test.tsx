// ct-101364: a press inside the open folder picker that lands on no folder (the
// "more folders on …" divider, a gap between chips, the hint row) must not
// close the picker, and reopening it must not collapse an expanded list.
//
// jsdom moves no focus on mousedown, so each press here does what a browser
// does: unless the handler called preventDefault, the focused filter input
// blurs. That blur is what closed the picker in the recording (rp-25096).
// Run: bun test components/conversation/sessionControls.pickerPanelPress.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { mockInboxStore } from "../__tests__/mockInboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "FocusEvent", "KeyboardEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

// Two folders the person uses, five the machine holds that they never opened:
// the resting row shows two, and the "5 more folders" expander holds the rest.
const PROJECTS = [
  { path: "/home/me/src/codecast", count: 9 },
  { path: "/home/me/src/outreach", count: 3 },
  ...["family", "eaiden", "video", "x-growth", "union-mobile"].map((n) => ({ path: `/home/me/${n}`, count: 0, suggested: true })),
];

mockInboxStore(() => ({
  sessions: {},
  resolveLiveSessionId: (id: string) => id,
  currentConversation: null,
  machineRosterLive: false,
  teamMachines: [],
  setCloudSessionMode: () => {},
  setSessionTargetDevice: () => {},
  updateClientUI: () => {},
}));
const stubModule = async (path: string, stubs: Record<string, unknown>) => {
  const real = { ...(await import(path)) };
  mock.module(path, () => ({ ...real, ...stubs }));
};
await stubModule("../../hooks/useScopedRecentProjects", { useScopedRecentProjects: () => PROJECTS });
await stubModule("../../hooks/useSessionMachines", { useSessionMachines: () => [] });
await stubModule("../../hooks/useLocalDeviceId", { useLocalDeviceId: () => null });
await stubModule("../../hooks/useLiveSessionMeta", { useLiveSessionMeta: () => undefined });
await stubModule("../../hooks/useHostLoads", { useHostLoads: () => ({}) });
await stubModule("../../hooks/useSyncTeamMachines", { useSyncTeamMachines: () => {} });
await stubModule("../../lib/fsBrowse", { useDirListing: () => ({ listing: undefined, home: undefined }) });
await stubModule("../cloudAgents/machine", { useCloudAgentStatus: () => ({ connected: false, problem: null, device: null }) });
await stubModule("../cloudAgents/credentials", { useCloudAgentConnectedTo: () => () => false });
await stubModule("../../lib/managedPolicy", { usePolicyRefusal: () => null });

const React = await import("react");
const { ConvexProvider } = await import("convex/react");
const { createRoot } = await import("react-dom/client");
const { ProjectSwitcher } = await import("./sessionControls");

const DIVIDER = "more folders on this machine";
// Expanded means the held-back folders are chips in the list ("eaiden" is one).
const expanded = (c: Element) => [...c.querySelectorAll("button")].some((b) => b.textContent?.trim() === "eaiden");

async function mountOpenExpanded() {
  const handleRef = { current: null as any };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => root.render(
    React.createElement(ConvexProvider, { client: offlineConvexClient() },
      React.createElement(ProjectSwitcher, {
        conversation: { _id: "stub-conv" } as any,
        handleRef,
        machineSlot: null,
        modeSlot: null,
      })),
  ));
  await React.act(async () => { handleRef.current.focus(); });
  const input = () => container.querySelector("input");
  expect(input()).not.toBeNull();
  expect(document.activeElement).toBe(input());
  const expander = [...container.querySelectorAll("button")].find((b) => /5 more folders/.test(b.textContent ?? ""));
  expect(expander).toBeDefined();
  await press(expander!);
  expect(input()).not.toBeNull();
  expect(expanded(container)).toBe(true);
  return { container, root, handleRef, input };
}

// A browser's mousedown: the handler runs, then (unless it prevented the
// default) focus leaves the input, because the pressed element isn't focusable.
async function press(el: Element) {
  await React.act(async () => {
    const ev = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    const notPrevented = el.dispatchEvent(ev);
    if (notPrevented && document.activeElement && document.activeElement !== document.body) {
      (document.activeElement as HTMLElement).blur();
    }
  });
}

test("pressing the 'more folders' divider keeps the picker open and expanded", async () => {
  const { container, root, input } = await mountOpenExpanded();
  const divider = [...container.querySelectorAll("span.w-full")].find((s) => s.textContent?.includes(DIVIDER));
  expect(divider).toBeDefined();
  await press(divider!);
  expect(input()).not.toBeNull();
  expect(expanded(container)).toBe(true);
  await React.act(async () => root.unmount());
  container.remove();
});

test("pressing the gap between chips or the hint row keeps the picker open", async () => {
  const { container, root, input } = await mountOpenExpanded();
  // The chip container itself (what a press between two chips lands on).
  const chipRow = input()!.closest("div")!.parentElement!.querySelector("div.flex-wrap.justify-center")!;
  expect(chipRow).not.toBeNull();
  await press(chipRow);
  expect(input()).not.toBeNull();
  // The hint row beside the filter input.
  const hints = input()!.nextElementSibling!;
  await press(hints);
  expect(input()).not.toBeNull();
  expect(expanded(container)).toBe(true);
  await React.act(async () => root.unmount());
  container.remove();
});

test("reopening the picker keeps the 'more folders' list expanded", async () => {
  const { container, root, handleRef, input } = await mountOpenExpanded();
  // Leave the picker the way a press outside it does (focus leaves the input).
  await React.act(async () => { input()!.blur(); });
  expect(input()).toBeNull();
  await React.act(async () => { handleRef.current.focus(); });
  expect(input()).not.toBeNull();
  expect(expanded(container)).toBe(true);
  await React.act(async () => root.unmount());
  container.remove();
});
