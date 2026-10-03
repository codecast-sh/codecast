// Mounts the composer's role picker in jsdom against mocked store hooks: ⌥R
// opens it inside the compose dialog, the viewer's own roles come first and
// other people's read quieter, typing filters, ↵ picks a reachable seat and
// hands the caret back, Esc backs out, and × returns to a fresh session.
// Run: bun test packages/web/components/ComposeRolePicker.mount.test.tsx
import assert from "node:assert/strict";
import { realInboxStore, restoreInboxStoreAfterAll } from "./__tests__/mockInboxStore";
import { closeDomWindow } from "../test-helpers/domGlobals";
restoreInboxStoreAfterAll();

async function verifyPicker() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const ME = "user-me";
  const SAM = "user-sam";
  const base = { scope_type: "team", team_id: "t1", host_user_id: ME, status: "active", scope: { project_ids: [], plan_ids: [] }, scope_names: { projects: [], plans: [] } };
  const roles: any[] = [
    { ...base, _id: "r-plat", short_id: "or-3", handle: "platform", name: "Platform lead", given_name: "Sol", reports_to: { kind: "user", user_id: SAM }, status: "paused", standing: { conversation_id: "conv-plat" } },
    { ...base, _id: "r-growth", short_id: "or-1", handle: "growth", name: "Head of Growth", given_name: "Ember", reports_to: { kind: "user", user_id: ME }, standing: { conversation_id: "conv-growth" }, scope_names: { projects: [{ id: "p1", title: "Growth", short_id: "pr-1" }], plans: [{ id: "l1", title: "SEO", short_id: "pl-1" }] } },
    { ...base, _id: "r-docs", short_id: "or-4", handle: "docs", name: "Docs lead", given_name: "Ada", reports_to: { kind: "role", role_id: "r-plat" }, standing: null },
    { ...base, _id: "r-people", short_id: "or-2", handle: "head-of-people", name: "Head of People", given_name: "Rowan", reports_to: { kind: "user", user_id: ME }, standing: { conversation_id: "conv-people" } },
  ];
  mock.module("../store/inboxStore", () => ({ ...realInboxStore, useInboxStore: Object.assign((sel: any) => sel({ currentUser: { _id: ME } }), { getState: () => ({ currentUser: { _id: ME } }) }) }));
  mock.module("../hooks/useOrgRoles", () => ({ useOrgRoles: () => ({ roles, workspace: { kind: "team", id: "t1", name: "Fernhill" }, roleBotUserIds: new Set() }) }));
  mock.module("../hooks/useSyncOrgTree", () => ({ useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));
  mock.module("../hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { _id: ME }, isLoading: false, isAuthenticated: true }) }));
  const realAvatars = { ...(await import("./org/avatars")) };
  mock.module("./org/avatars", () => ({ ...realAvatars, RoleAvatar: ({ avatar }: { avatar: string }) => React.createElement("i", { "data-avatar": avatar }) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ComposeRolePicker } = await import("./ComposeRolePicker");
  const root = createRoot(document.getElementById("root")!);
  const picks: unknown[] = [];
  let done = 0;
  let picked: any = null;
  const render = () => act(async () => root.render(
    React.createElement("div", { role: "dialog", "aria-modal": "true" },
      React.createElement(ComposeRolePicker, { picked, onPick: (r: any) => { picks.push(r?.handle ?? null); picked = r; }, onDone: () => { done += 1; } }),
      React.createElement("textarea", { id: "msg" })),
  ));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
  const handleOf = (el: Element) => el.querySelector(".font-mono")!.textContent;
  const key = (target: EventTarget, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const typeInto = (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true }));
  });

  // Closed: one pill, with its chord as keycaps.
  await render();
  const pill = q<HTMLButtonElement>("button")!;
  assert.match(pill.textContent!, /To a role/);
  assert.match(pill.textContent!, /R$/);
  assert.equal(q("input"), null);

  // ⌥R opens it (capture phase on window), the caret lands in the filter.
  await key(dom.window, { altKey: true, code: "KeyR", key: "®" });
  const input = q<HTMLInputElement>("input")!;
  assert.ok(input, "the filter input mounted");
  assert.equal(document.activeElement, input);
  // Mine first, by name; then the divider and other people's, quieter; a seat
  // with no standing session is listed but cannot be picked.
  const rows = qa("[role=option] button");
  assert.deepEqual(rows.map(handleOf), ["@growth", "@head-of-people", "@docs", "@platform"]);
  assert.match(rows[0].textContent!, /EmberHead of Growth· Growth, SEO@growth/);
  assert.ok(!rows[0].className.includes("opacity-70"), "my own role reads in full");
  assert.ok(rows[2].className.includes("opacity-70"), "another person's role is quieter");
  assert.ok((rows[2] as HTMLButtonElement).disabled, "no standing session: not pickable");
  assert.match(rows[2].textContent!, /no agent yet/);
  assert.match(rows[3].textContent!, /paused/);
  assert.match(q("[role=listbox]")!.textContent!, /Other people’s roles/);

  // The first reachable row is highlighted; ↓ steps over the dead seat.
  assert.equal(qa("[role=option][aria-selected=true]").length, 1);
  assert.match(qa("[role=option][aria-selected=true]")[0].textContent!, /@growth/);
  await key(input, { key: "ArrowDown" });
  await key(input, { key: "ArrowDown" });
  assert.match(qa("[role=option][aria-selected=true]")[0].textContent!, /@platform/);

  // Typing filters by any word in the line; ↵ picks and hands the caret back.
  await typeInto(input, "gro");
  assert.deepEqual(qa("[role=option] button").map(handleOf), ["@growth"]);
  await key(input, { key: "Enter" });
  assert.deepEqual(picks, ["growth"]);
  assert.equal(done, 1);
  await render();
  assert.equal(q("input"), null);
  assert.match(q("[aria-label^='Sending to Ember']")!.textContent!, /EmberHead of Growth· Growth, SEO@growth/);

  // ⌥R again reopens; Esc backs out, the pick stands.
  await key(dom.window, { altKey: true, code: "KeyR" });
  assert.ok(q("input"));
  await key(q("input")!, { key: "Escape" });
  assert.equal(done, 2);
  await render();
  assert.equal(q("input"), null);
  assert.ok(q("[aria-label^='Sending to Ember']"));

  // A modal stacked above the composer owns the keyboard.
  const confirm = document.createElement("div");
  confirm.setAttribute("aria-modal", "true");
  document.body.appendChild(confirm);
  await key(dom.window, { altKey: true, code: "KeyR" });
  assert.equal(q("input"), null);
  confirm.remove();

  // × returns to a fresh session.
  await act(async () => q<HTMLButtonElement>("[aria-label='Start a fresh session instead']")!.click());
  assert.deepEqual(picks, ["growth", null]);
  await render();
  assert.match(q("button")!.textContent!, /To a role/);

  await act(async () => root.unmount());
  closeDomWindow(dom);
}

await verifyPicker();
console.log("ComposeRolePicker mount: ok");
