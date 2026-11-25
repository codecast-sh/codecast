// ct-101329: while a sharing agent started from codecast is open, the setup
// strip's "share a repo" step must point at that agent's conversation, not
// send the person back to the manual route (/settings/sync) they already left.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Every way the strip could open a conversation lands its id here.
const opened: string[] = [];
const realOpen = { ...(await import("../../../hooks/useOpenLinkedSession")) };
mock.module("../../../hooks/useOpenLinkedSession", () => ({
  ...realOpen,
  openConversationBeside: (id: string) => { opened.push(id); },
}));
mock.module("next/link", () => ({
  default: ({ href, onClick, children, ...rest }: any) => (
    <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(e); }} {...rest}>{children}</a>
  ),
}));

// The person is on a team of three with nothing shared: the strip's step is share_repo.
const { setupSteps } = await import("../../../lib/setupProgress");
const team = { _id: "t1", name: "Littlebird", member_count: 3, shared_project_count: 0, role: "member" };
const steps = setupSteps({
  connected: true,
  team: { _id: "t1", name: "Littlebird", member_count: 3, shared_project_count: 0, sharesFull: false, isAdmin: false, features: { on: 1, total: 1 } },
  agentFeatures: { on: 0, total: 3 },
  notifications: "n/a",
  desktopOffered: false,
});
const realProgress = { ...(await import("../../../hooks/useSetupProgress")) };
mock.module("../../../hooks/useSetupProgress", () => ({
  ...realProgress,
  useSetupProgress: () => ({ steps, done: steps.filter((s) => s.done).length, total: steps.length, team, ready: true }),
}));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { startSharingAgent } = await import("../../../lib/sharingAgent");
const { SetupNudgeBanner } = await import("../SetupNudgeBanner");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("with no agent open, the share-a-repo strip offers the manual route", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<SetupNudgeBanner />); });
  expect(container.querySelector('[data-setup-nudge="share_repo"]')).not.toBeNull();
  expect(container.querySelector('a[href="/settings/sync"]')).not.toBeNull();
  root.unmount();
});

test("with a sharing agent open, the strip opens that agent's conversation instead of the manual route", async () => {
  const navigated: string[] = [];
  const st = useInboxStore.getState();
  const realNavigate = st.navigateToSession;
  const realRequest = st.requestNavigate;
  useInboxStore.setState({
    currentUser: { _id: "u1", cli_version: "1.0.0" } as any,
    navigateToSession: ((id: string) => { navigated.push(id); }) as any,
    requestNavigate: ((id: string) => { navigated.push(id); }) as any,
  });

  let stubId = "";
  await act(async () => { stubId = startSharingAgent(); });
  opened.length = 0;
  // The agent is a real row in the store, which is all a fix may read.
  expect(useInboxStore.getState().sessions[stubId] ?? useInboxStore.getState().conversations?.[stubId]).toBeTruthy();

  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<SetupNudgeBanner />); });

  const text = container.textContent ?? "";
  // The miss: eight minutes into a running sharing agent, the strip still said this.
  expect(text).not.toContain("Nothing flows to Littlebird yet.");
  expect(container.querySelector('a[href="/settings/sync"]')).toBeNull();

  // One press on the strip's action reaches the agent's conversation.
  const action = container.querySelector("[data-setup-action]") as HTMLElement | null;
  expect(action).not.toBeNull();
  const href = action!.getAttribute("href") ?? "";
  await act(async () => { action!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const real = useInboxStore.getState().stubToConvexId?.[stubId];
  const ids = [stubId, real].filter(Boolean) as string[];
  const reached = [...opened, ...navigated].some((id) => ids.includes(id)) || ids.some((id) => href.includes(id));
  expect(reached).toBe(true);

  root.unmount();
  useInboxStore.setState({ navigateToSession: realNavigate, requestNavigate: realRequest });
});

test("once the sharing agent is dismissed, the strip offers the manual route again", async () => {
  const id = useInboxStore.getState().clientState.dismissed?.sharing_agent as string;
  expect(id).toBeTruthy();
  const sessions = useInboxStore.getState().sessions;
  useInboxStore.setState({ sessions: { ...sessions, [id]: { ...sessions[id], inbox_dismissed_at: Date.now() } } as any });

  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<SetupNudgeBanner />); });
  expect(container.textContent).toContain("Nothing flows to Littlebird yet.");
  expect(container.querySelector('a[href="/settings/sync"]')).not.toBeNull();
  root.unmount();
});
