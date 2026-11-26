// Filling an agent's request for a key with a value shorter than the Vault's
// minimum greys out Save; the form must say why, so the person knows what to fix
// (ct-101921: someone retried a 3-digit CVC three times and gave up).
// Run: cd packages/web && bun test components/secrets/ValueForm.tooShort.mount.test.tsx
import { dom } from "../__tests__/fixtures/composeDom";
import { expect, test } from "bun:test";

const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const client = offlineConvexClient("https://example.convex.cloud");
const { ConvexProvider } = await import("convex/react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ValueEditor } = await import("./ValueForm");
const { SECRET_REDACTION_MIN } = await import("@codecast/shared/contracts/secrets");

const ROW = { _id: "s1", short_id: "sec-1", name: "card-cvc", kind: "key", status: "requested", workspace: "user:u1", updated_at: 1 } as any;

function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!].onChange({ target: el, currentTarget: el });
}

test("a value shorter than the minimum disables Save and the form says why", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(<ConvexProvider client={client}><ValueEditor row={ROW} mode="fulfill" /></ConvexProvider>);
  });
  const form = document.querySelector<HTMLFormElement>("[data-vault-value-editor=fulfill]")!;
  await act(async () => type(form.querySelector<HTMLInputElement>("[name=vault-value]")!, "123"));

  const save = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  expect(save.disabled).toBe(true);
  // Everything the form shows besides its buttons and the typed value.
  const shown = Array.from(form.querySelectorAll("*"))
    .filter((el) => !el.closest("button") && el.children.length === 0)
    .map((el) => el.textContent ?? "")
    .join(" ");
  expect(shown).toContain(String(SECRET_REDACTION_MIN));
  await act(async () => root.unmount());
});
