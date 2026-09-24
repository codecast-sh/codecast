// The Sync page before the first session ever syncs: a typed path is a row
// with a share menu the moment it is added, and a "never share" lock files
// its row under its own group. A user who has not started the daemon reads
// that everything is private, and can write rules before anything uploads.
// Run: cd packages/web && bun test app/settings/sync/page.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../../components/__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";

async function verify() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/settings/sync", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle", "ResizeObserver"]) {
    const value = (dom.window as any)[key];
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // The fixtures every hook answers from; a test flips them between renders.
  const fx: any = {
    user: { _id: "u_me", sync_mode: "all", sync_projects: [] as string[], active_team_id: null },
    teams: [] as any[],
    syncProjects: [] as any[],
    directoryMappings: [] as any[],
    sessions: { rows: [] as any[], total: 0, truncated: false },
  };
  const calls: string[] = [];
  const toasts: string[] = [];
  const state: any = {
    get teams() { return fx.teams; },
    currentUser: fx.user,
    setPrivacy: () => {},
    setTeamMembershipVisibility: () => {},
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  mock.module("../../../hooks/useSyncSettings", () => ({ useSettingsData: (name: string) => ({ data: fx[name] }) }));
  mock.module("../../../hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: fx.user }) }));
  // Exact counts answer at once: a path with no sessions reads as zero.
  const zero = { count: 0, first_started_at: null, last_started_at: null, truncated: false, older: 0, older_than_day: 0, hidden: 0, manually_shared: 0 };
  const summaries = new Proxy({}, { get: () => zero, has: () => true });
  mock.module("../../../hooks/useShareSummaries", () => ({ useShareSummaries: () => ({ summaries, loading: false, reload: () => {} }) }));
  mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: (_q: any, args: any) => ({ data: args === "skip" ? undefined : fx.sessions }) }));
  mock.module("../../../components/settings/TeamVisibilityControl", () => ({ TeamVisibilityControl: () => null }));
  mock.module("../../../lib/fsBrowse", () => ({
    fetchLocalSessions: async () => fx.local ?? null,
    fetchPathsExist: async (_c: any, paths: string[]) => ({ home: "/Users/me", exists: Object.fromEntries(paths.map((p) => [p, !(fx.gone ?? []).includes(p)])) }),
  }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("sonner", () => ({ toast: Object.assign((m: string) => toasts.push(m), { success: (m: string) => toasts.push(`ok:${m}`), error: (m: string) => toasts.push(`err:${m}`), info: (m: string) => toasts.push(`info:${m}`) }) }));
  const convexReact = await import("convex/react");
  const { getFunctionName } = await import("convex/server");
  mock.module("convex/react", () => ({
    ...convexReact,
    useMutation: (ref: any) => {
      const name = getFunctionName(ref).replace(/^.*[:.]/, "");
      return async (args: any) => { calls.push(`${name}:${JSON.stringify(args)}`); return {}; };
    },
  }));

  const { createRoot } = await import("react-dom/client");
  const { default: SyncPage } = await import("./page");
  const root = createRoot(document.getElementById("root")!);
  const text = () => document.body.textContent ?? "";
  const buttons = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];
  const byText = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
  const render = async () => { await act(async () => { root.render(React.createElement(SyncPage)); }); };

  // ── nothing synced yet: the page says everything is private, and how to write a rule first ──
  await render();
  assert.match(text(), /Nothing has synced yet, so nothing is shared/);
  assert.match(text(), /add a folder above/);
  assert.ok(!/Start a coding session/.test(text()), "the old empty state is gone");

  // ── a typed path lands in the chosen folders list, with sync all on ──
  // On a team with nothing synced: still the empty state, no team header pointing at nothing.
  fx.teams = [{ _id: "t_team", name: "Union", visibility: "full", member_count: 3 }];
  await render();
  assert.match(text(), /Nothing has synced yet, so nothing is shared/);
  assert.ok(!/Nothing shared with Union/.test(text()) && !/teammates/.test(text()), "no empty team header");
  assert.equal(byText("+ Add path"), undefined, "with nothing listed the add row is simply open");
  const input = document.querySelector<HTMLInputElement>('input[placeholder^="Full path of a folder"]')!;
  assert.ok(input, "the add row has the path field");
  const setValue = (v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true }));
  };
  await act(async () => { setValue("notes"); });
  await act(async () => { byText("Add")!.click(); });
  assert.equal(calls.length, 0, "a relative path writes nothing");
  assert.match(toasts.pop() ?? "", /^err:Type the full path/);
  await act(async () => { setValue("/Users/me/health/"); });
  await act(async () => { byText("Add")!.click(); });
  assert.equal(calls.pop(), 'updateSyncSettings:{"sync_projects":["/Users/me/health"]}', "the trailing slash is dropped and the path is stored");
  assert.match(toasts.pop() ?? "", /^ok:health added/);

  // ── the stored path is a row with its own share menu, sessions or none ──
  fx.user = { ...fx.user, sync_projects: ["/Users/me/health"] };
  state.currentUser = fx.user;
  fx.teams = [{ _id: "t_team", name: "Union", visibility: "full", member_count: 3 }];
  await render();
  assert.match(text(), /Private — only you/);
  assert.match(text(), /no sessions yet/);
  const menu = buttons().find((b) => b.getAttribute("aria-label") === "Who can open health");
  assert.ok(menu, "the typed row carries the share menu");
  assert.match(menu!.textContent ?? "", /Only me/);
  assert.ok(!/Never shared — locked/.test(text()), "no locked group without a lock");

  // ── the trigger opens one panel under the row: every choice in one line, nothing repeated per team ──
  assert.equal(document.querySelector("[data-share-panel]"), null, "closed until asked");
  await act(async () => { menu!.click(); });
  const panel = () => document.querySelector("[data-share-panel]")!;
  assert.ok(panel(), "the panel opens inline");
  const chips = () => [...panel().querySelectorAll("[role=radio]")] as HTMLButtonElement[];
  assert.deepEqual(chips().map((c) => c.textContent), ["Only me", "Union", "Never share"]);
  assert.equal(chips()[0].getAttribute("aria-checked"), "true", "the current rule is picked");
  const apply = () => [...panel().querySelectorAll("button")].at(-1) as HTMLButtonElement;
  assert.equal(apply().textContent, "Close", "nothing to apply until the choice changes");
  // A team: the sentence, the scope, the sessions, and the default covers the past.
  fx.sessions = { rows: [
    { _id: "c1", title: "Appointment notes", started_at: Date.now() - 86_400_000, message_count: 4, is_private: true, team_visibility: null },
    { _id: "c2", title: "Old scan", started_at: Date.now() - 5 * 86_400_000, message_count: 2, is_private: true, team_visibility: "private" },
  ], total: 2, truncated: false };
  await act(async () => { chips()[1].click(); });
  assert.match(panel().textContent ?? "", /Union \(2 teammates\) will see the whole conversation for health/);
  const all = panel().querySelector<HTMLInputElement>('input[type=radio][name=share-scope]')!;
  assert.ok(all.checked, "Everything, past sessions included, is the default");
  assert.match(panel().textContent ?? "", /Appointment notes/);
  assert.match(panel().textContent ?? "", /hidden by hand/);
  assert.equal(apply().textContent, "Share with Union");
  // Untick one session: it stays private, and the write locks it.
  await act(async () => { panel().querySelector<HTMLInputElement>('input[aria-label=\'Share "Appointment notes"\']')!.click(); });
  assert.match(panel().textContent ?? "", /1 kept private/);
  await act(async () => { apply().click(); });
  const write = calls.find((c) => c.startsWith("updateDirectoryTeamMapping:"))!;
  assert.ok(write, "the rule is written");
  const args = JSON.parse(write.slice(write.indexOf(":") + 1));
  assert.deepEqual({ team: args.team_id, past: args.include_past, keep: args.lock_private }, { team: "t_team", past: true, keep: ["c1"] });
  assert.equal(document.querySelector("[data-share-panel]"), null, "the panel closes after the write");
  calls.length = 0;

  // ── a lock files the row under its own group and the trigger says so ──
  fx.directoryMappings = [{ _id: "dm1", path_prefix: "/Users/me/health", team_id: null, team_name: null, auto_share: false, private: true, share_since: null }];
  await render();
  assert.match(text(), /Never shared — locked by you/);
  const locked = buttons().find((b) => b.getAttribute("aria-label") === "Who can open health")!;
  assert.match(locked.textContent ?? "", /Never shared/);
  assert.ok(!/Private — only you\s*1/.test(text()), "the locked row left the private group");

  // ── a checkout the server resolved to a lock through its repository reads the same ──
  fx.directoryMappings = [{ _id: "dm2", path_prefix: "/Users/me/src/app", team_id: null, team_name: null, auto_share: false, private: true, repository: "acme/app" }];
  fx.syncProjects = [{ path: "/Users/me/src/app-clone", is_git_repo: true, session_count: 2, last_active: Date.now(), repository: "acme/app", team_id: null, private: true, mapped_directly: false }];
  fx.user = { ...fx.user, sync_projects: [] };
  state.currentUser = fx.user;
  await render();
  assert.match(text(), /Never shared — locked by you/);
  const clone = buttons().find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Who can open app"))!;
  assert.match(clone.textContent ?? "", /Never shared/);
  assert.match(clone.textContent ?? "", /\(repo\)/, "inherited through the repository");

  // ── the sharing copy says what is not listed is private ──
  assert.match(text(), /Everything is private to you until you share a repository/);

  await act(async () => { root.unmount(); });

  // ── choosing what to sync: a folder that never synced shows this machine's numbers ──
  const DAY = 86_400_000;
  const now = Date.now();
  fx.user = { ...fx.user, sync_mode: "selected", sync_projects: [] };
  state.currentUser = fx.user;
  fx.syncProjects = [];
  fx.directoryMappings = [];
  fx.sessions = { rows: [], total: 0, truncated: false };
  fx.local = [{ path: "/Users/me/src/site", repository: "me/site", sessions: 3, claude: 2, codex: 1, synced: 0, first: now - 10 * DAY, last: now - DAY, times: [now - DAY, now - 5 * DAY, now - 10 * DAY], git: true, exists: true }];
  calls.length = 0;
  const root2 = createRoot(document.getElementById("root")!);
  await act(async () => { root2.render(React.createElement(SyncPage)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(text(), /Not syncing/);
  assert.match(text(), /3 sessions on this machine · active/);
  assert.match(text(), /not synced/);
  const site = buttons().find((b) => b.getAttribute("aria-label") === "Who can open site")!;
  assert.ok(site, "an unsynced folder can be shared from its row");
  await act(async () => { site.click(); });
  const panel2 = document.querySelector("[data-share-panel]")!;
  await act(async () => { ([...panel2.querySelectorAll("[role=radio]")] as HTMLButtonElement[]).find((c) => c.textContent === "Union")!.click(); });
  const p2 = () => document.querySelector("[data-share-panel]")!.textContent ?? "";
  assert.match(p2(), /3 sessions, /, "the band counts this machine's sessions");
  assert.match(p2(), /Sharing starts syncing this folder, past sessions included/);
  // From today keeps all three private: the count comes from each session's time.
  await act(async () => { (document.querySelectorAll('[data-share-panel] input[name=share-scope]')[1] as HTMLInputElement).click(); });
  assert.match(p2(), /The 3 sessions before that stay private/);
  await act(async () => { ([...document.querySelectorAll("[data-share-panel] button")].at(-1) as HTMLButtonElement).click(); });
  assert.equal(calls[0], 'updateSyncSettings:{"sync_mode":"selected","sync_projects":["/Users/me/src/site"]}', "sync turns on first");
  assert.match(calls[1] ?? "", /^updateDirectoryTeamMapping:.*"team_id":"t_team"/);
  await act(async () => { root2.unmount(); });

  // ── a folder that moved: its old path is grouped apart and says so ──
  fx.local = null;
  fx.user = { ...fx.user, sync_mode: "all", sync_projects: [] };
  state.currentUser = fx.user;
  fx.syncProjects = [
    { path: "/Users/me/src/old/outreach", is_git_repo: false, session_count: 250, last_active: now - 200 * DAY, team_id: null },
    { path: "/Users/me/src/live", is_git_repo: true, session_count: 3, last_active: now, team_id: null },
  ];
  fx.gone = ["/Users/me/src/old/outreach"];
  const root3 = createRoot(document.getElementById("root")!);
  await act(async () => { root3.render(React.createElement(SyncPage)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const t3 = text();
  assert.match(t3, /No longer on this machine: moved or deleted/);
  assert.match(t3, /Folder moved or deleted on this machine/);
  assert.ok(t3.indexOf("live") < t3.indexOf("No longer on this machine"), "the live folder lists above the moved one");
  await act(async () => { root3.unmount(); });

  // ── with every folder syncing, one folder turns off by itself; new folders keep syncing ──
  fx.gone = [];
  fx.syncProjects = [{ path: "/Users/me/src/quiet", is_git_repo: true, session_count: 0, last_active: now, team_id: null }];
  calls.length = 0;
  const root4 = createRoot(document.getElementById("root")!);
  await act(async () => { root4.render(React.createElement(SyncPage)); });
  const quiet = () => document.querySelector<HTMLButtonElement>('[aria-label="Sync quiet"]');
  assert.ok(quiet(), "each folder has its own sync switch while everything syncs");
  await act(async () => { quiet()!.click(); });
  assert.equal(calls[0], 'updateSyncSettings:{"sync_excluded":["/Users/me/src/quiet"]}', "turning one folder off excludes it and keeps sync all");
  await act(async () => { root4.unmount(); });
  fx.user = { ...fx.user, sync_mode: "all", sync_projects: [], sync_excluded: ["/Users/me/src/quiet"] };
  state.currentUser = fx.user;
  calls.length = 0;
  const root5 = createRoot(document.getElementById("root")!);
  await act(async () => { root5.render(React.createElement(SyncPage)); });
  assert.match(text(), /except the 1 you turned off below/);
  assert.match(text(), /Not syncing/);
  await act(async () => { quiet()!.click(); });
  assert.equal(calls[0], 'updateSyncSettings:{"sync_excluded":[]}', "turning it back on lifts the exclusion");
  await act(async () => { root5.unmount(); });
}

test("the sync page: typed paths are rows, a lock has its own group", verify, 60_000);
