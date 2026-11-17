import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// $.theme changes how the person's app looks, so apply and preview run only
// from the person's own press in a mod surface, never from a render or an
// event hook. Driven through the runtime's real message protocol, with the
// test playing the sandboxed frame.

const dom = new JSDOM("<!doctype html><div id='c'></div>", { url: "https://codecast.test/inbox" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document });
const { useInboxStore } = await import("../../../store/inboxStore");
const { ModRuntime } = await import("../host");
const { themePreview, setThemePreview } = await import("../../theme/preview");
const { DEFAULT_COLOR_THEME } = await import("../../theme/colorTheme");

const LAGOON = "t/lagoon";
const s = () => useInboxStore.getState() as any;
const owner = {};
const flush = () => new Promise((r) => setTimeout(r, 0));

let rt: InstanceType<typeof ModRuntime>;
let frameWin: any;
const replies = new Map<string, { ok: boolean; value?: unknown; error?: string }>();
const fromFrame = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: frameWin }));
let seq = 0;
async function call(method: string, args: unknown[], origin: "ui" | "hook") {
  const cid = `c${++seq}`;
  fromFrame({ type: "call", cid, key: "fence:lagoon", method, args, origin });
  await flush();
  return replies.get(cid)!;
}
/** Runs `fn` while a press of the person's is being answered, the way a button's onPress runs. */
async function duringPress<T>(fn: () => Promise<T>): Promise<T> {
  const done = rt.invoke("fence:lagoon#1.1", []);
  await flush();
  const out = await fn();
  fromFrame({ type: "done", rid: [...((rt as any).dones as Map<string, unknown>).keys()][0] });
  await done;
  return out;
}

beforeAll(async () => {
  s()._setDispatch(async () => null, { owner });
  const manifest = { name: "t", themes: [{ id: "lagoon", title: "Lagoon", light: { bg: "#c9f3ef", card: "#ffffff8c" }, backdrop: { tint: 0.2, glass: 12 } }] };
  const row: any = { _id: "mod1", name: "t", manifest, code: "", rev: 1, version: 0, enabled: true, is_mine: true, updated_at: 1 };
  useInboxStore.setState({ mods: { mod1: row } } as any);
  rt = new ModRuntime(row, dom.window.document.getElementById("c")!);
  frameWin = (dom.window.document.querySelector("iframe") as any).contentWindow;
  frameWin.postMessage = (msg: any) => { if (msg?.type === "reply") replies.set(msg.cid, msg); };
  fromFrame({ type: "ready", hooks: [] });
  await flush();
});
afterAll(() => { rt.dispose(); s()._clearDispatch(owner); restore(); });
beforeEach(() => {
  setThemePreview(null);
  s().updateClientUI({ color_theme: DEFAULT_COLOR_THEME });
});

describe("$.theme", () => {
  it("lists codecast's themes and the mod's, marking the backdrop one", async () => {
    const r = await call("theme.list", [], "ui");
    const lagoon = (r.value as any[]).find((t) => t.key === LAGOON);
    expect(lagoon).toEqual({ key: LAGOON, title: "Lagoon", mod: "t", backdrop: true, current: false });
    expect((r.value as any[]).some((t) => t.key === DEFAULT_COLOR_THEME && t.current)).toBe(true);
  });

  it("refuses apply and preview from an event hook or a render", async () => {
    for (const origin of ["hook", "ui"] as const) {
      const applied = await call("theme.apply", [LAGOON], origin);
      expect(applied.ok).toBe(false);
      expect(applied.error).toContain("person's press");
      expect((await call("theme.preview", [LAGOON], origin)).ok).toBe(false);
    }
    expect(s().clientState.ui.color_theme).toBe(DEFAULT_COLOR_THEME);
    expect(themePreview()).toBe(null);
  });

  it("a press previews without choosing, and applying ends the preview", async () => {
    await duringPress(() => call("theme.preview", [LAGOON, { ms: 5000 }], "ui"));
    expect(themePreview()).toBe(LAGOON);
    expect(s().clientState.ui.color_theme).toBe(DEFAULT_COLOR_THEME);
    await duringPress(() => call("theme.apply", [LAGOON], "ui"));
    expect(s().clientState.ui.color_theme).toBe(LAGOON);
    expect(themePreview()).toBe(null);
    await duringPress(() => call("theme.apply", [null], "ui"));
    expect(s().clientState.ui.color_theme).toBe(DEFAULT_COLOR_THEME);
  });

  it("refuses a theme nobody declares", async () => {
    const r = await duringPress(() => call("theme.apply", ["t/nope"], "ui"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no theme "t/nope"');
  });
});
