// ct-101511: a message held because tmux is missing on the person's machine.
// The app already knows (users.has_tmux === false, the top bar's
// TmuxMissingBanner reads it), yet the pending bubble showed only the generic
// queued/stuck controls with "Retry (kill & restart)", a restart that cannot
// install tmux. The bubble must name tmux, give the install command, and drop
// the restart, keeping Cancel.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { ConvexProvider } = await import("convex/react");
const { MemoryRouter } = await import("react-router");
const { daemonHealthClient, seedDaemonHealth } = await import("./fixtures/daemonHealth");
const { PendingDeliveryNote } = await import("../PendingDeliveryNote");
const { useInboxStore } = await import("../../store/inboxStore");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const client = daemonHealthClient();

const GenericControls = () => <span>Queued — delivering your message to the agent <button>Retry (kill &amp; restart)</button></span>;

async function mountPending(state: "starting" | "stuck", user: Record<string, unknown>) {
  seedDaemonHealth();
  useInboxStore.setState({ currentUser: { _id: "health-viewer", daemon_last_seen: Date.now() - 1_000, last_heartbeat: Date.now() - 1_000, ...user } as any });
  await act(() => root.render(
    <ConvexProvider client={client}><MemoryRouter>
      <PendingDeliveryNote state={state} restartInFlight={false} conversationId="laptop" onCancel={() => {}}>
        <GenericControls />
      </PendingDeliveryNote>
    </MemoryRouter></ConvexProvider>,
  ));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return host.textContent ?? "";
}

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
afterAll(() => { dom.window.close(); restore(); });

for (const state of ["starting", "stuck"] as const) {
  test(`tmux missing (${state}): the pending bubble names tmux and its install command, not a restart`, async () => {
    const text = await mountPending(state, { has_tmux: false, cli_platform: "darwin" });
    expect(text).toContain("tmux");
    expect(text).toContain("brew install tmux");
    expect(text).not.toContain("Retry (kill & restart)");
    expect(host.querySelector('[data-testid="pending-message-cancel"]')).not.toBeNull();
  });
}

test("tmux missing on Linux: the install command is apt-get", async () => {
  const text = await mountPending("stuck", { has_tmux: false, cli_platform: "linux" });
  expect(text).toContain("sudo apt-get install -y tmux");
});

test("tmux installed: the bubble keeps its generic controls", async () => {
  const text = await mountPending("stuck", { has_tmux: true, cli_platform: "darwin" });
  expect(text).not.toContain("brew install tmux");
  expect(text).toContain("Retry (kill & restart)");
});
