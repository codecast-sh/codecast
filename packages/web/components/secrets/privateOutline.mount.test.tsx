// A revealed secret stays out of the error replay's page outline: the replay
// recorder uploads visibleOutline(document.body) with every reported error,
// and it skips [data-private]. Mounts a MaskedField (one line and multiline)
// and the 2FA code, reveals them, and reads the outline the recorder would.
// Run: cd packages/web && bun test components/secrets/privateOutline.mount.test.tsx
import { expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const VALUE = "zz-fixture-key-6b1f0c";
const FILE = "zz-fixture-line-one\nzz-fixture-line-two";

async function mount() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MaskedField, TotpCode } = await import("./parts");
  const { visibleOutline } = await import("@platform/analytics/replay");
  const { act } = React;
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(MaskedField, { label: "Value", value: VALUE, load: async () => VALUE }),
        React.createElement(MaskedField, { label: "service.json", value: FILE, load: async () => FILE, multiline: true }),
        React.createElement(TotpCode, { seed: "JBSWY3DPEHPK3PXP" }),
      ),
    ),
  );
  for (const b of Array.from(document.querySelectorAll("[data-vault-reveal]")) as HTMLButtonElement[]) {
    await act(async () => b.click());
  }
  // Let the first TOTP tick land so a code is on screen.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  return {
    text: () => document.body.textContent ?? "",
    code: () => document.querySelector("[data-vault-totp] > span")?.textContent ?? "",
    outline: () => visibleOutline(document.body),
    unmount: () => {
      act(() => root.unmount());
      closeDomWindow(dom);
    },
  };
}

test("revealed values and the 2FA code are on screen but not in the replay outline", async () => {
  const t = await mount();
  expect(t.text()).toContain(VALUE);
  expect(t.text()).toContain("zz-fixture-line-two");
  const code = t.code().replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);

  const outline = t.outline();
  // The walk reached the fields: their labels are there.
  expect(outline).toContain("Value");
  expect(outline).toContain("service.json");
  expect(outline).not.toContain(VALUE);
  expect(outline).not.toContain("zz-fixture-line");
  expect(outline.replace(/\s/g, "")).not.toContain(code);
  t.unmount();
});
