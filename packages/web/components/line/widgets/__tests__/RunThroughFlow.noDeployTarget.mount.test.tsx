// ct-101499: a repository with no published deploy target. Once the targets feed
// has answered empty, the Ship picker says the change lands but goes live
// nowhere, and its control asks the session's agent to declare a target (a
// message into the session), never guessing one from the thread.
// Run: bun test components/line/widgets/__tests__/RunThroughFlow.noDeployTarget.mount.test.tsx
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const CONV = "conv_ship_target";
const TEAM = "team_ship_target";
const REMOTE = "https://github.com/acme/legislative-red-team-demo.git";

const realFeatures = { ...(await import("../../../../lib/teamFeatures")) };
mock.module("../../../../lib/teamFeatures", () => ({ ...realFeatures, useWorkspaceFeature: () => true }));
const realWorkflows = { ...(await import("../../../../hooks/useSyncWorkflows")) };
mock.module("../../../../hooks/useSyncWorkflows", () => ({ ...realWorkflows, usePoolFlowRows: () => [], useSessionFlowRuns: () => [] }));
const realRepoFlows = { ...(await import("../../../../hooks/useRepoFlows")) };
mock.module("../../../../hooks/useRepoFlows", () => ({ ...realRepoFlows, useRepoFlows: () => [] }));
const realReach = { ...(await import("../../../../hooks/useDeployReach")) };
mock.module("../../../../hooks/useDeployReach", () => ({ ...realReach, useDeployReach: () => undefined }));
const realApproval = { ...(await import("../../../../hooks/usePressApproval")) };
mock.module("../../../../hooks/usePressApproval", () => ({ ...realApproval, usePressApproval: () => ({ files: null, record: async () => true }) }));
const realPhone = { ...(await import("../../../../hooks/useIsPhone")) };
const realTargets = { ...(await import("../../../../hooks/useSyncDeployTargets")) };
mock.module("../../../../hooks/useSyncDeployTargets", () => ({ ...realTargets, useDeployTargets: () => ({ targets: [], deploys: [], productions: [], ready: true }) }));
mock.module("../../../../hooks/useIsPhone", () => ({ ...realPhone, useMediaQuery: () => false }));

let dom: any;
let root: any;
let act: any;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle", "DocumentFragment", "NodeFilter", "HTMLInputElement", "FocusEvent"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  try { act?.(() => root?.unmount()); } catch {}
  if (dom) closeDomWindow(dom);
});

test("with no target the picker says the change goes live nowhere, and asks the agent to declare one", async () => {
  const React = await import("react");
  act = React.act;
  const { createRoot } = await import("react-dom/client");
  const { ConvexProvider } = await import("convex/react");
  const { offlineConvexClient } = await import("../../../../test-helpers/offlineConvex");
  const { useInboxStore } = await import("../../../../store/inboxStore");
  const { RunThroughFlow } = await import("../RunThroughFlow");

  const sent: Array<[string, string]> = [];
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    sessions: { ...s.sessions, [CONV]: { _id: CONV, git_remote_url: REMOTE, git_root: "/w/legislative-red-team-demo", team_id: TEAM } },
    sendMessage: (id: string, text: string) => { sent.push([id, text]); },
  } as any);

  root = createRoot(document.getElementById("root")!);
  act(() => {
    root.render(React.createElement(ConvexProvider, { client: offlineConvexClient() },
      React.createElement(RunThroughFlow, { conversationId: CONV, sessionTitle: "Publish the demo" })));
  });
  const chip = document.querySelector("[data-run-through]") as HTMLElement;
  act(() => {
    chip.dispatchEvent(new (window as any).PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    chip.click();
  });
  const none = document.querySelector('[data-ship-targets="none"]') as HTMLElement | null;
  expect(none).not.toBeNull();
  expect(none!.textContent ?? "").toContain("No deploy target");
  const declare = none!.querySelector("[data-ship-declare-target]") as HTMLButtonElement;
  act(() => { declare.click(); });
  expect(sent.length).toBe(1);
  expect(sent[0][0]).toBe(CONV);
  expect(sent[0][1]).toContain(".codecast/deploy.toml");
  expect(sent[0][1]).toContain("cast line deploy targets --publish");
});
