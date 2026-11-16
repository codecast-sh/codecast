// Save all on the Vault's open sign-in requests: one press checks every site
// on the laptop's Chrome, one review lists what was found, and its confirm
// saves each into its request. Run against the sample Vault (an agent's tab),
// whose laptop answers at once, so no Convex call runs.
// Run: cd packages/web && bun test components/secrets/SaveAllSignins.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost:3200/vault", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "sessionStorage", "localStorage", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

const calls: string[] = [];
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: (ref: any) => async () => (calls.push(getFunctionName(ref)), {}),
  useQuery: () => undefined,
}));
const deviceBadge = await import("../DeviceBadge");
mock.module("../DeviceBadge", () => ({ ...deviceBadge, useDevices: () => ({ onlineLocals: [] }) }));
const authState = await import("../../hooks/useServerAuthSettled");
mock.module("../../hooks/useServerAuthSettled", () => ({ ...authState, useServerAuthSettled: () => true, useServerIdentityLost: () => false }));

const { VaultSource } = await import("./VaultSource");
const { SaveAllSignins } = await import("./SaveSignin");
const { useSecrets } = await import("../../hooks/useSyncSecrets");
const { AGENT_TAB_KEY } = await import("../../lib/desktopHandoff");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");

const asked = ["fly.io", "sentry.io", "zoom.us"].map((host, i) => ({
  _id: `req-${i}`,
  short_id: `sec-${900 + i}`,
  name: `${host.split(".")[0]}-signin`,
  kind: "signin",
  status: "requested",
  sites: [host],
  workspace: "team:sample",
  team_id: "sample-team",
  created_at: 0,
})) as any[];

let rows: ReturnType<typeof useSecrets> = [];
function Probe() {
  rows = useSecrets();
  return null;
}

afterAll(() => closeDomWindow(dom.window as any));

test("one press checks every requested site, one confirm saves them all into their requests", async () => {
  sessionStorage.setItem(AGENT_TAB_KEY, "1");
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<VaultSource><Probe /><SaveAllSignins rows={asked} team={{ id: "sample-team", name: "Sample team" }} /></VaultSource>));

  const button = () => document.querySelector<HTMLButtonElement>("[data-vault-signin-all-button]")!;
  expect(button().textContent).toBe("Save 3 from my Chrome on Sample laptop");
  for (let i = 0; i < 10 && !document.querySelector("[data-switch-review]"); i++) {
    await act(async () => (i === 0 ? button().click() : await new Promise((r) => setTimeout(r, 10))));
  }

  const review = document.querySelector("[data-switch-review]")!;
  expect(review.getAttribute("data-switch-review")).toBe("Share 3 sign-ins");
  for (const host of ["fly.io", "sentry.io", "zoom.us"]) expect(review.textContent).toContain(host);
  const confirm = [...review.querySelectorAll("button")].find((b) => b.textContent?.includes("Share 3 with the team"))!;
  for (let i = 0; i < 10 && document.querySelector("[data-vault-signin-all]")?.getAttribute("data-vault-signin-all") !== "done"; i++) {
    await act(async () => (i === 0 ? confirm.click() : await new Promise((r) => setTimeout(r, 10))));
  }

  expect(document.querySelector("[data-vault-signin-all-outcome]")!.textContent).toContain("3 saved");
  for (const host of ["fly.io", "sentry.io", "zoom.us"]) expect(rows.find((r) => r.sites?.[0] === host)).toMatchObject({ kind: "signin", status: "ready" });
  expect(calls).toEqual([]);
  await act(async () => root.unmount());
});
