// Add to Vault takes a name spelled the way env vars are (MERCURY_API_KEY):
// it saves under its slug, which agents type, and fills that env var.
// Run: cd packages/web && bun test components/secrets/AddSecretDialog.mount.test.tsx
import { dom } from "../__tests__/fixtures/composeDom";
import { expect, test } from "bun:test";

// The real useCreate, against a Convex client that records each action's args.
const created: { name: string; env?: string[] }[] = [];
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const client = offlineConvexClient("https://example.convex.cloud");
(client as any).action = async (_ref: unknown, args: { name: string; env?: string[] }) => (created.push(args), { short_id: "sec-1" });
const { ConvexProvider } = await import("convex/react");

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AddSecretDialog } = await import("./AddSecretDialog");

const VALUE = `mk_live_${"q7R2x9Lp".repeat(4)}`;

function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!].onChange({ target: el, currentTarget: el });
}

test("a name typed as MERCURY_API_KEY saves as mercury-api-key with that env var", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(<ConvexProvider client={client}><AddSecretDialog mode={{ kind: "key" }} onClose={() => {}} onSignin={() => {}} scope={{ team: null, personal: "user:u1" }} rows={[]} /></ConvexProvider>);
  });
  const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  await act(async () => type(q<HTMLInputElement>("[name=vault-value]"), VALUE));
  await act(async () => type(q<HTMLInputElement>("[data-vault-name]"), "MERCURY_API_KEY"));

  expect(q<HTMLInputElement>("[data-vault-name]").value).toBe("MERCURY_API_KEY");
  expect(document.querySelector("[data-vault-name-state]")).toBeNull();
  expect(q("[data-vault-name-saved-as]").textContent).toBe("Saved as mercury-api-key");
  expect(q<HTMLInputElement>("input[placeholder='MERCURY_API_KEY']")).toBeTruthy();

  await act(async () => {
    q<HTMLButtonElement>("[data-vault-add-submit]").click();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(created).toHaveLength(1);
  expect(created[0]!.name).toBe("mercury-api-key");
  expect(created[0]!.env).toEqual(["MERCURY_API_KEY"]);
  await act(async () => root.unmount());
});

test("a dash mid-typing is no error", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(<ConvexProvider client={client}><AddSecretDialog mode={{ kind: "key" }} onClose={() => {}} onSignin={() => {}} scope={{ team: null, personal: "user:u1" }} rows={[]} /></ConvexProvider>);
  });
  await act(async () => type(document.querySelector<HTMLInputElement>("[data-vault-name]")!, "mercury-"));
  expect(document.querySelector("[data-vault-name-state]")).toBeNull();
  await act(async () => root.unmount());
});
