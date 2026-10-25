// A Vault link (?s=sec-N) opens its secret wherever the viewer holds it: a row
// the page shows opens as it is, one in another team switches the active team
// to it (both halves of the pointer, once per link), and the page says the
// secret is not there only once the Vault has loaded and no workspace holds it.
// Run: cd packages/web && bun test components/secrets/linkedSecret.mount.test.tsx
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/vault", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useAction: () => async () => ({}),
  useMutation: () => async () => ({}),
  useQuery: () => undefined,
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, undefined])),
  useConvex: () => ({ query: async () => undefined, mutation: async () => undefined, action: async () => undefined }),
}));
const authState = await import("../../hooks/useServerAuthSettled");
mock.module("../../hooks/useServerAuthSettled", () => ({ ...authState, useServerAuthSettled: () => true, useServerIdentityLost: () => false }));

const realNav = await import("next/navigation");
let search = "";
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(search) }));

const { useInboxStore } = await import("../../store/inboxStore");
const { useLinkedSecret, useSecrets } = await import("../../hooks/useSyncSecrets");
const { syncMetaKey } = await import("../../hooks/syncMetaKeys");
const { VaultPage } = await import("./VaultPage");

const row = (id: string, short: string, workspace: string, name = `zz-${short}`) => ({ _id: id, short_id: short, name, kind: "key", status: "ready", workspace, updated_at: 1 }) as any;
const MINE = row("s1", "sec-1", "user:u1");
const OURS = row("s2", "sec-2", "team:tA");
const THEIRS = row("s3", "sec-3", "team:tB");

let root: Root;
let ref: string | null = null;
const seen: { row?: string; missing?: boolean } = {};
function Probe() {
  const rows = useSecrets();
  const linked = useLinkedSecret(rows, ref);
  seen.row = linked.row?.short_id;
  seen.missing = linked.missing;
  return null;
}
const render = async (next: string | null) => {
  ref = next;
  await act(async () => root.render(<Probe />));
};
const activeTeam = () => useInboxStore.getState().clientState.ui?.active_team_id ?? null;
const pointer = () => (useInboxStore.getState().currentUser as any)?.active_team_id ?? null;
const setLoaded = (on: boolean) => useInboxStore.setState((s: any) => ({ syncMeta: { ...(s.syncMeta ?? {}), [syncMetaKey("secrets", "viewer")]: on ? { backfilledAt: 1 } : undefined } }));

beforeEach(async () => {
  useInboxStore.setState((s: any) => ({
    currentUser: { ...(s.currentUser ?? {}), _id: "u1", name: "Ada", active_team_id: "tA" },
    teams: [{ _id: "tA", name: "Alpha" }, { _id: "tB", name: "Beta" }],
    clientState: { ...s.clientState, ui: { ...(s.clientState?.ui ?? {}), active_team_id: "tA" } },
    secrets: { s1: MINE, s2: OURS, s3: THEIRS },
    pending: {},
  }));
  setLoaded(true);
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

test("a secret the page shows opens without touching the team", async () => {
  await render("sec-2");
  expect(seen).toEqual({ row: "sec-2", missing: false });
  await render("sec-1");
  expect(seen).toEqual({ row: "sec-1", missing: false });
  expect(activeTeam()).toBe("tA");
});

test("a secret in another team switches to that team, both halves of the pointer, and opens there", async () => {
  await render("sec-3");
  expect(activeTeam()).toBe("tB");
  expect(pointer()).toBe("tB");
  await render("sec-3");
  expect(seen).toEqual({ row: "sec-3", missing: false });
});

test("a team picked by hand while the link is open stays; the same link pressed again after closing switches again", async () => {
  await render("sec-3");
  expect(activeTeam()).toBe("tB");
  await act(async () => useInboxStore.getState().updateClientUI({ active_team_id: "tA" } as any));
  await render("sec-3");
  expect(activeTeam()).toBe("tA");
  expect(seen).toEqual({ row: undefined, missing: false });
  await render(null);
  await render("sec-3");
  expect(activeTeam()).toBe("tB");
});

test("not found only once the Vault has loaded and no workspace holds it", async () => {
  setLoaded(false);
  await render("sec-99");
  expect(seen).toEqual({ row: undefined, missing: false });
  await act(async () => setLoaded(true));
  await render("sec-99");
  expect(seen).toEqual({ row: undefined, missing: true });
  expect(activeTeam()).toBe("tA");
});

test("a just-created secret is named by its name until its short id lands", async () => {
  await render("zz-sec-2");
  expect(seen).toEqual({ row: "sec-2", missing: false });
});

test("the Vault page opens a link into another team there, and says when no workspace holds one", async () => {
  search = "s=sec-3";
  await act(async () => root.render(<VaultPage />));
  await act(async () => {});
  expect(activeTeam()).toBe("tB");
  expect(document.querySelector("[data-vault-detail='sec-3']")).not.toBeNull();
  expect(document.querySelector("[data-vault-detail-missing]")).toBeNull();

  search = "s=sec-99";
  await act(async () => root.render(<VaultPage key="missing" />));
  const missing = document.querySelector("[data-vault-detail-missing='sec-99']");
  expect(missing?.textContent).toContain("Not in your workspaces");
  expect(document.querySelector("[data-vault-detail]")).toBeNull();
});
