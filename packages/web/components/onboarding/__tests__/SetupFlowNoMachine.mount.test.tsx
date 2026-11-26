// ct-101647: new-account setup must not let a person "Finish" into an empty
// inbox while none of their computers is online. On the Agents step with no
// online, non-remote machine, the primary action is not Finish/Continue and
// neither it nor Enter leaves the step; leaving stays possible only through a
// secondary control that says no computer is connected. Once a computer comes
// online, the primary is Finish (solo) / Continue (team) again.
// Run: bun test components/onboarding/__tests__/SetupFlowNoMachine.mount.test.tsx
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mockInboxStore } from "../../__tests__/mockInboxStore";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

let roster: any[] = [];
const clientUIWrites: any[] = [];
const pushes: string[] = [];

mockInboxStore(() => ({
  machineRoster: roster,
  teams: [],
  currentUser: { _id: "user_1", name: "New Person", email: "new@example.com" },
  updateClientUI: (patch: any) => { clientUIWrites.push(patch); },
  createTeam: () => Promise.resolve("team_1"),
  setTeamFeature: () => {},
}));

let dom: any;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let SetupFlow: typeof import("../SetupFlow").SetupFlow;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/start", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  const h = React.createElement;

  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push: (p: string) => pushes.push(p), replace: () => {}, back: () => {}, prefetch: () => {} }) }));
  const realQuery = { ...(await import("../../../hooks/useQueryNoThrow")) };
  mock.module("../../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
  const realSyncDevices = { ...(await import("../../../hooks/useSyncDevices")) };
  mock.module("../../../hooks/useSyncDevices", () => ({ ...realSyncDevices, useSyncDevices: () => ({ ready: true }) }));
  const emptyData = { allProjects: [], suggestions: [], loading: false };
  const realSugg = { ...(await import("../../../hooks/useTeamWorkspaceSuggestions")) };
  mock.module("../../../hooks/useTeamWorkspaceSuggestions", () => ({ ...realSugg, useTeamWorkspaceSuggestions: () => emptyData }));
  const realSel = { ...(await import("../../../hooks/useWorkspaceSelection")) };
  mock.module("../../../hooks/useWorkspaceSelection", () => ({ ...realSel, useWorkspaceSelection: () => ({ selectedPaths: {}, toggle: () => {}, selectedCount: 0, selectedList: [], since: undefined, setSince: () => {} }) }));
  const realImpact = { ...(await import("../../../hooks/useShareImpact")) };
  mock.module("../../../hooks/useShareImpact", () => ({ ...realImpact, useShareImpact: () => null }));
  const realSave = { ...(await import("../../../lib/team/saveTeamSetup")) };
  mock.module("../../../lib/team/saveTeamSetup", () => ({ ...realSave, useSaveTeamSetup: () => async () => {} }));
  const realEmpty = { ...(await import("../../EmptyState")) };
  mock.module("../../EmptyState", () => ({ ...realEmpty, SetupThisMachine: () => h("button", { type: "button", "data-setup-this-machine": true }, "Set up this machine") }));
  const realPerms = { ...(await import("../BrowserPermissions")) };
  mock.module("../BrowserPermissions", () => ({ ...realPerms, BrowserPermissions: () => null }));
  const realDomain = { ...(await import("../DomainTeams")) };
  mock.module("../DomainTeams", () => ({ ...realDomain, DomainTeams: () => null }));
  const realFeature = { ...(await import("../FeatureStep")) };
  mock.module("../FeatureStep", () => ({ ...realFeature, FeatureStep: () => null }));

  ({ createRoot } = await import("react-dom/client"));
  ({ SetupFlow } = await import("../SetupFlow"));
});

afterAll(() => { if (dom) closeDomWindow(dom); });

const ONLINE_MACHINE = { device_id: "dev_1", label: "Laptop", online: true, is_remote: false, last_seen: Date.now(), settings: {} };

const buttons = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];
const primary = () => document.querySelector("button.tf-primary") as HTMLButtonElement | null;
const label = (b: Element | null) => (b?.textContent ?? "").replace("↵", "").trim();
const heading = () => document.body.textContent ?? "";
const pressEnter = () => window.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const left = () => clientUIWrites.some((w) => w && w.setup_done_at) || pushes.length > 0;

async function mountAt(path: "solo" | "team") {
  roster = [];
  clientUIWrites.length = 0;
  pushes.length = 0;
  document.body.innerHTML = "<div id='root'></div>";
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(SetupFlow, { mode: "welcome" })));
  if (path === "solo") {
    const justMe = buttons().find((b) => /Just me for now/.test(b.textContent ?? ""))!;
    await React.act(async () => justMe.click());
  } else {
    const input = document.getElementById("teamName") as HTMLInputElement;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Acme");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await React.act(async () => (document.querySelector("form#setup-team-name") as HTMLFormElement).requestSubmit());
    await React.act(async () => primary()!.click()); // Features → Agents
  }
  expect(heading()).toContain("Connect your agents");
  return root;
}

for (const path of ["solo", "team"] as const) {
  const ready = path === "solo" ? "Finish" : "Continue";

  test(`${path}: with no computer online, the Agents step's primary is not "${ready}" and neither it nor Enter leaves`, async () => {
    const root = await mountAt(path);
    expect(label(primary())).not.toBe(ready);
    await React.act(async () => pressEnter());
    expect(heading()).toContain("Connect your agents");
    expect(left()).toBe(false);
    await React.act(async () => primary()?.click());
    expect(heading()).toContain("Connect your agents");
    expect(left()).toBe(false);
    await React.act(async () => root.unmount());
  });

  test(`${path}: leaving without a computer is a secondary control that says none is connected`, async () => {
    const root = await mountAt(path);
    const skip = buttons().find((b) => b !== primary() && /later|without a computer|no computer/i.test(b.textContent ?? ""));
    expect(skip?.textContent ?? "(no skip control naming the missing computer)").toMatch(/later|without a computer|no computer/i);
    if (path === "solo") {
      await React.act(async () => skip!.click());
      expect(clientUIWrites.some((w) => w && w.setup_done_at)).toBe(true);
      expect(pushes).toContain("/inbox");
    }
    await React.act(async () => root.unmount());
  });

  test(`${path}: once a computer comes online the primary is "${ready}" again`, async () => {
    const root = await mountAt(path);
    roster = [ONLINE_MACHINE];
    await React.act(async () => root.render(React.createElement(SetupFlow, { mode: "welcome" })));
    expect(label(primary())).toBe(ready);
    await React.act(async () => root.unmount());
  });
}
