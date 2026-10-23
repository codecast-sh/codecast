// useReveal keeps a login's 2FA seed for as long as the panel is open, while
// the revealed password drops after REVEAL_IDLE_MS untouched and on every
// window blur. Mounted against a fake Convex client whose reveal action
// counts calls, under fake timers.
// Run: cd packages/web && bun test components/secrets/useReveal.mount.test.tsx
import { afterEach, describe, expect, jest, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const LOGIN = { username: "zz-user", password: "zz-fixture-password", totp_seed: "JBSWY3DPEHPK3PXP" };

async function mountReveal(payload: object) {
  jest.useFakeTimers();
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { ConvexProvider } = await import("convex/react");
  const { createRoot } = await import("react-dom/client");
  const { useReveal, REVEAL_IDLE_MS } = await import("./parts");
  const { act } = React;

  let reveals = 0;
  const client = { action: async () => (reveals++, { payload }) };
  const hook: { current?: ReturnType<typeof useReveal> } = {};
  function Probe({ id, version }: { id: string; version?: number }) {
    hook.current = useReveal(id, version);
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const render = (id: string, version?: number) => act(() => root.render(React.createElement(ConvexProvider, { client: client as any }, React.createElement(Probe, { id, version }))));
  render("sec-1", 1);

  return {
    hook: () => hook.current!,
    reveals: () => reveals,
    render,
    load: async () => {
      await act(async () => {
        await hook.current!.load();
      });
    },
    advance: (ms: number) => act(() => { jest.advanceTimersByTime(ms); }),
    blur: () => act(() => { window.dispatchEvent(new dom.window.Event("blur")); }),
    REVEAL_IDLE_MS,
    unmount: () => {
      act(() => root.unmount());
      closeDomWindow(dom);
    },
  };
}

describe("useReveal", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("the password drops after the idle window; the 2FA seed stays", async () => {
    const t = await mountReveal(LOGIN);
    await t.load();
    expect((t.hook().payload as any)?.password).toBe(LOGIN.password);
    expect(t.hook().seed).toBe(LOGIN.totp_seed);

    t.advance(t.REVEAL_IDLE_MS - 1000);
    expect(t.hook().payload).not.toBeNull();
    t.advance(1000);
    expect(t.hook().payload).toBeNull();
    expect(t.hook().seed).toBe(LOGIN.totp_seed);
    t.unmount();
  });

  test("a copy or reveal while revealed restarts the idle window without a fetch", async () => {
    const t = await mountReveal(LOGIN);
    await t.load();
    t.advance(t.REVEAL_IDLE_MS - 1000);
    await t.load();
    expect(t.reveals()).toBe(1);
    t.advance(t.REVEAL_IDLE_MS - 1000);
    expect(t.hook().payload).not.toBeNull();
    t.advance(1000);
    expect(t.hook().payload).toBeNull();
    t.unmount();
  });

  test("a window blur drops the password at once and keeps the seed", async () => {
    const t = await mountReveal(LOGIN);
    await t.load();
    t.blur();
    expect(t.hook().payload).toBeNull();
    expect(t.hook().seed).toBe(LOGIN.totp_seed);
    t.unmount();
  });

  test("another secret drops everything, seed included", async () => {
    const t = await mountReveal(LOGIN);
    await t.load();
    t.render("sec-2");
    expect(t.hook().payload).toBeNull();
    expect(t.hook().seed).toBeUndefined();
    t.unmount();
  });

  test("a replaced value drops what was revealed, so the next reveal fetches the new one", async () => {
    const t = await mountReveal(LOGIN);
    await t.load();
    t.render("sec-1", 1);
    expect(t.hook().payload).not.toBeNull();
    t.render("sec-1", 2);
    expect(t.hook().payload).toBeNull();
    expect(t.hook().seed).toBeUndefined();
    await t.load();
    expect(t.reveals()).toBe(2);
    t.unmount();
  });

  test("a login without a seed says so", async () => {
    const t = await mountReveal({ username: "zz-user", password: "zz-fixture-password" });
    expect(t.hook().seed).toBeUndefined();
    await t.load();
    expect(t.hook().seed).toBeNull();
    t.unmount();
  });
});
