// ct-101499: the Ship picker names where the change goes live. A team that has
// recorded a deploy target for the session's repository (.codecast/deploy.toml,
// published, synced as `deployTargets`) must see that target in the picker
// before pressing Ship; today the picker draws only the generic flows and never
// reads the targets.
// Run: bun test components/line/widgets/__tests__/RunThroughFlow.deployTarget.mount.test.tsx
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const CONV = "conv_ship_target";
const TEAM = "team_ship_target";
const REMOTE = "https://github.com/acme/legislative-red-team-demo.git";
const TARGET = "gh-pages-demo";

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

test("the Ship picker names the deploy target recorded for the session's repository", async () => {
  const React = await import("react");
  act = React.act;
  const { createRoot } = await import("react-dom/client");
  const { ConvexProvider } = await import("convex/react");
  const { offlineConvexClient } = await import("../../../../test-helpers/offlineConvex");
  const { useInboxStore } = await import("../../../../store/inboxStore");
  const { repositoryOfRemote } = await import("../../../../hooks/useRepoFlows");
  const { RunThroughFlow } = await import("../RunThroughFlow");

  const repository = repositoryOfRemote(REMOTE)!;
  const target = {
    _id: `${repository}#${TARGET}`, workspace: `team:${TEAM}`, team_id: TEAM, name: TARGET, repository,
    runs: "push", policy: "manual", command: "cp -r dist/ legislative-red-team-demo/ && git push", rollback: null,
    paths: [], can_deploy: true, can_redeploy_sha: false, can_rollback: false, device_id: null, publisher_user_id: "u1",
    queue: { known: true, truncated: false, commits: 0, untouched: 0, head_sha: null, head_ci: "none", head_ci_url: null, shown: 0, groups: [] },
  };
  const s = useInboxStore.getState() as any;
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    sessions: { ...s.sessions, [CONV]: { _id: CONV, git_remote_url: REMOTE, git_root: "/w/legislative-red-team-demo", team_id: TEAM } },
    deployTargets: { ...(s.deployTargets ?? {}), [target._id]: target },
  } as any);

  root = createRoot(document.getElementById("root")!);
  act(() => {
    root.render(React.createElement(ConvexProvider, { client: offlineConvexClient() },
      React.createElement(RunThroughFlow, { conversationId: CONV, sessionTitle: "Publish the demo" })));
  });
  const chip = document.querySelector("[data-run-through]") as HTMLElement | null;
  expect(chip).not.toBeNull();
  act(() => {
    chip!.dispatchEvent(new (window as any).PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    chip!.click();
  });
  const picker = document.querySelector("[data-ship-picker]") as HTMLElement | null;
  expect(picker).not.toBeNull();
  // The picker is open on the session's change: it must say where Ship will take it live.
  expect(picker!.textContent ?? "").toContain(TARGET);
});
