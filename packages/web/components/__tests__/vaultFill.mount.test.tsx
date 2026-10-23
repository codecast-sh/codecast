import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { getFunctionName } from "convex/server";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { VaultRequestCard } from "../conversation/blocks/VaultRequestCard";
import { SigninRequestFill } from "../secrets/SaveSignin";

// Filling a Vault request from the conversation: the request card turns ready
// the moment Save is pressed and goes back to its field, with the reason, on
// a refusal; a sign-in request checks the laptop's Chrome first, shows the
// share review only for a found sign-in, and says why when it cannot save.
// Run: cd packages/web && bun test components/__tests__/vaultFill.mount.test.tsx
// Beside other files, run with --isolate (as CI does): a file that loads Radix
// before any DOM exists (secretLedgers.test.ts) leaves the dialog unable to open.

// The preload loads react-dom before this DOM exists, so React takes its old-IE
// path for typed fields: it moves its watch between focused fields with
// attachEvent/detachEvent, which jsdom lacks; without them a second field never gets watched.
w.HTMLElement.prototype.attachEvent = () => {};
w.HTMLElement.prototype.detachEvent = () => {};

// The share review is a Radix dialog, which dispatches the global CustomEvent at the DOM.
const realCustomEvent = globalThis.CustomEvent;
(globalThis as any).CustomEvent = w.CustomEvent;

afterAll(() => {
  (globalThis as any).CustomEvent = realCustomEvent;
  closeDomWindow(dom);
  restoreGlobals();
});

const USER = "user_vault_fill";
const TEAM = "team_vault_fill";

/** A Convex client whose actions and mutations the test answers, and whose query results it sets. */
function fakeConvex() {
  const client = offlineConvexClient();
  const calls: { args: any; answer: (v: any) => void }[] = [];
  const results = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const pend = (_name: unknown, args: any) => new Promise((answer) => calls.push({ args, answer }));
  (client as any).action = pend;
  (client as any).mutation = pend;
  (client as any).watchQuery = (query: any, args: any) => ({
    onUpdate: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
    localQueryResult: () => results.get(`${getFunctionName(query)}:${JSON.stringify(args ?? {})}`),
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  return {
    client,
    calls,
    setResult: (name: string, args: object, value: unknown) => {
      results.set(`${name}:${JSON.stringify(args)}`, value);
      for (const cb of listeners) cb();
    },
  };
}

function row(over: Partial<SecretMeta>): SecretMeta {
  return {
    _id: "secret_fill_1",
    short_id: "sec-901",
    name: "zz-stripe-test",
    kind: "key",
    status: "requested",
    workspace: `user:${USER}`,
    request_why: "Checkout tests need a test key",
    created_at: 1,
    updated_at: 1,
    ...over,
  } as SecretMeta;
}

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    currentUser: { _id: USER, name: "Tester" },
    teams: [{ _id: TEAM, name: "Acme" }],
    teamMembers: [{ user_id: USER, name: "Tester" }, { user_id: "user_other", name: "Other" }],
    machineRoster: [{ device_id: "dev-1", label: "mbp", online: true, is_remote: false, last_seen: 1 }],
    secrets: {},
  } as any);
});

async function mount(node: React.ReactNode, client: unknown) {
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><ConvexProvider client={client as any}>{node}</ConvexProvider></MemoryRouter>));
  return {
    // The share review is a dialog, portalled to the body; the rest stays in this mount.
    q: (sel: string) => (container.querySelector(sel) ?? (sel.startsWith("[data-switch") ? w.document.querySelector(sel) : null)) as HTMLElement | null,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

/** React (on the old-IE path above) reads the focused field on keyup. */
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    el.dispatchEvent(new w.KeyboardEvent("keyup", { bubbles: true }));
  });
}

async function fillAndSave(t: Awaited<ReturnType<typeof mount>>) {
  await typeInto(t.q("input[name=vault-value]") as HTMLInputElement, "zz-fixture-value-1234567890");
  await act(async () => { t.q("[data-vault-value-editor]")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); });
}

const stored = () => (useInboxStore.getState() as any).secrets.secret_fill_1 as SecretMeta;

test("the request card reads Ready the moment Save is pressed", async () => {
  useInboxStore.getState().stageSecret(row({}));
  const fake = fakeConvex();
  const t = await mount(<VaultRequestCard name="zz-stripe-test" kind="key" output="" isError={false} />, fake.client);
  expect(t.text()).toContain("needs a value");

  await fillAndSave(t);
  // The action has not answered: the row and the card already say ready.
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.args.ref).toBe("secret_fill_1");
  expect(stored().status).toBe("ready");
  expect(t.text()).toContain("Ready");
  expect(t.q("input[name=vault-value]")).toBeNull();

  await act(async () => fake.calls[0]!.answer({ delivered: true }));
  await settle();
  expect(stored().status).toBe("ready");
  await t.unmount();
});

test("a refused fill puts the request back, with the reason", async () => {
  useInboxStore.getState().stageSecret(row({}));
  const fake = fakeConvex();
  const t = await mount(<VaultRequestCard name="zz-stripe-test" kind="key" output="" isError={false} />, fake.client);
  await fillAndSave(t);
  expect(stored().status).toBe("ready");

  await act(async () => fake.calls[0]!.answer({ error: "Only the team's members can fill it" }));
  await settle();
  expect(stored().status).toBe("requested");
  expect(t.text()).toContain("needs a value");
  expect(t.q("input[name=vault-value]")).not.toBeNull();
  await t.unmount();
});

const signinRow = (over: Partial<SecretMeta> = {}) =>
  row({ _id: "secret_fill_2", name: "zz-vercel-signin", kind: "signin", sites: ["vercel.com"], workspace: `team:${TEAM}`, team_id: TEAM, ...over } as Partial<SecretMeta>);

async function pressChrome(t: Awaited<ReturnType<typeof mount>>) {
  await act(async () => (t.q("[data-vault-signin-chrome]") as HTMLButtonElement).click());
}

test("a team sign-in: the check finds cookies, the share review opens, confirming saves", async () => {
  const fake = fakeConvex();
  const t = await mount(<SigninRequestFill row={signinRow()} />, fake.client);
  await pressChrome(t);
  expect(fake.calls[0]!.args).toMatchObject({ site: "vercel.com", name: "zz-vercel-signin", device_id: "dev-1", check: true, team_id: TEAM });
  await act(async () => fake.calls[0]!.answer({ command_id: "cmd-check", label: "mbp" }));
  expect(t.q("[data-vault-signin-button]")!.getAttribute("data-vault-signin-button")).toBe("checking");
  // No review before the laptop answers.
  expect(t.q("[data-switch-review]")).toBeNull();

  await act(async () => fake.setResult("users:getCommandResult", { command_id: "cmd-check" }, { result: JSON.stringify({ host: "vercel.com", cookies: 4, account_hint: "zz@acme.dev" }) }));
  await settle();
  expect(t.q("[data-switch-review]")?.getAttribute("data-switch-review")).toBe("Share your vercel.com sign-in");
  expect(fake.calls).toHaveLength(1);

  await act(async () => (t.q("[data-switch-confirm]") as HTMLButtonElement).click());
  await settle();
  expect(t.q("[data-switch-review]")).toBeNull();
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]!.args.check).toBeUndefined();
  await act(async () => fake.calls[1]!.answer({ command_id: "cmd-save", label: "mbp" }));
  await act(async () => fake.setResult("users:getCommandResult", { command_id: "cmd-save" }, { result: JSON.stringify({ short_id: "sec-902", name: "zz-vercel-signin", host: "vercel.com", cookies: 4, action: "filled" }) }));
  await settle();
  expect(t.q("[data-vault-signin-state]")?.getAttribute("data-vault-signin-state")).toBe("saved");
  expect(t.text()).toContain("4 cookies");
  await t.unmount();
});

test("backing out of the share review saves nothing", async () => {
  const fake = fakeConvex();
  const t = await mount(<SigninRequestFill row={signinRow()} />, fake.client);
  await pressChrome(t);
  await act(async () => fake.calls[0]!.answer({ command_id: "cmd-check", label: "mbp" }));
  await act(async () => fake.setResult("users:getCommandResult", { command_id: "cmd-check" }, { result: JSON.stringify({ host: "vercel.com", cookies: 2 }) }));
  await settle();
  await act(async () => (t.q("[data-switch-cancel]") as HTMLButtonElement).click());
  await settle();
  expect(t.q("[data-switch-review]")).toBeNull();
  expect(fake.calls).toHaveLength(1);
  expect(t.q("[data-vault-signin-button]")!.getAttribute("data-vault-signin-button")).toBe("idle");
  await t.unmount();
});

test("no cookies in Chrome: not signed in, with Check again and a link to the site", async () => {
  const fake = fakeConvex();
  const t = await mount(<SigninRequestFill row={signinRow()} />, fake.client);
  await pressChrome(t);
  await act(async () => fake.calls[0]!.answer({ command_id: "cmd-check", label: "mbp" }));
  await act(async () => fake.setResult("users:getCommandResult", { command_id: "cmd-check" }, { result: JSON.stringify({ host: "vercel.com", cookies: 0, profile: "Default" }) }));
  await settle();
  expect(t.q("[data-switch-review]")).toBeNull();
  expect(t.q("[data-vault-signin-state]")?.getAttribute("data-vault-signin-state")).toBe("signed-out");
  expect(t.text()).toContain("Not signed in to vercel.com");
  expect(t.text()).toContain("Check again");
  expect(t.q("[data-vault-signin-open]")?.getAttribute("href")).toBe("https://vercel.com");
  await t.unmount();
});

test("a refused request and a laptop that never picks it up each say why", async () => {
  const fake = fakeConvex();
  const t = await mount(<SigninRequestFill row={signinRow()} />, fake.client);
  await pressChrome(t);
  await act(async () => fake.calls[0]!.answer({ error: "That laptop is not yours" }));
  await settle();
  expect(t.q("[data-vault-signin-state]")?.getAttribute("data-vault-signin-state")).toBe("failed");
  expect(t.text()).toContain("That laptop is not yours");

  await pressChrome(t);
  await act(async () => fake.calls[1]!.answer({ command_id: "cmd-late", label: "mbp" }));
  await act(async () => fake.setResult("users:getCommandResult", { command_id: "cmd-late" }, { error: "expired_ttl" }));
  await settle();
  expect(t.text()).toContain("mbp never picked it up");
  await t.unmount();
});
