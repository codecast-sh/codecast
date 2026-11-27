import { describe, expect, test } from "bun:test";
import { coalesced, contentOnlyHmrPlugin, isScannedSave } from "./contentOnlyHmr";

describe("isScannedSave", () => {
  test("component and module saves are scanned; stylesheets, html and deps are not", () => {
    expect(isScannedSave("/r/packages/web/components/Card.tsx")).toBe(true);
    expect(isScannedSave("/r/packages/web/lib/code/buffers.ts")).toBe(true);
    expect(isScannedSave("/r/packages/web/app/docs/page.mdx")).toBe(true);
    expect(isScannedSave("/r/packages/web/app/globals.css")).toBe(false);
    expect(isScannedSave("/r/packages/web/index.html")).toBe(false);
    expect(isScannedSave("/r/node_modules/react/index.js")).toBe(false);
  });
});

describe("coalesced", () => {
  test("a burst of saves runs the check at most twice", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const kick = coalesced(async () => {
      runs++;
      if (runs === 1) await gate;
    });
    for (let i = 0; i < 20; i++) kick();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
  });
});

describe("contentOnlyHmrPlugin", () => {
  const sheet = { url: "/app/globals.css" };
  function env() {
    const reloaded: unknown[] = [];
    return {
      reloaded,
      environment: {
        name: "client",
        moduleGraph: { getModulesByFile: (f: string) => (f === "/r/app/globals.css" ? new Set([sheet]) : undefined) },
        reloadModule: async (m: unknown) => void reloaded.push(m),
      },
    };
  }
  const save = async (plugin: ReturnType<typeof contentOnlyHmrPlugin>, ctx: ReturnType<typeof env>, file: string) => {
    const hook = plugin.hotUpdate as (this: unknown, o: { file: string; modules: unknown[] }) => unknown;
    const out = hook.call({ environment: ctx.environment }, { file, modules: [] });
    await new Promise((r) => setTimeout(r, 0));
    return out;
  };

  test("a save that changes no CSS sends the stylesheet nowhere", async () => {
    const ctx = env();
    const plugin = contentOnlyHmrPlugin(async () => []);
    expect(await save(plugin, ctx, "/r/components/Card.tsx")).toBeUndefined();
    expect(ctx.reloaded).toEqual([]);
  });

  test("a save that adds a class reloads the stylesheet module", async () => {
    const ctx = env();
    const plugin = contentOnlyHmrPlugin(async () => ["/r/app/globals.css"]);
    await save(plugin, ctx, "/r/components/Card.tsx");
    expect(ctx.reloaded).toEqual([sheet]);
  });

  test("with no window connected nothing is rebuilt", async () => {
    const ctx = env();
    let asked = 0;
    const plugin = contentOnlyHmrPlugin(async () => (asked++, []));
    (plugin.configureServer as (s: unknown) => void)({ ws: { clients: new Set() } });
    await save(plugin, ctx, "/r/components/Card.tsx");
    expect(asked).toBe(0);
  });

  test("a failed check is logged, never an unhandled rejection", async () => {
    const ctx = env();
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      const plugin = contentOnlyHmrPlugin(async () => {
        throw new Error("boom");
      });
      await save(plugin, ctx, "/r/components/Card.tsx");
      expect(warned.length).toBe(1);
      // The runner is free again afterwards.
      await save(plugin, ctx, "/r/components/Card.tsx");
      expect(warned.length).toBe(2);
    } finally {
      console.warn = warn;
    }
  });

  test("a stylesheet save is left to Vite", async () => {
    const ctx = env();
    let asked = 0;
    const plugin = contentOnlyHmrPlugin(async () => (asked++, ["/r/app/globals.css"]));
    await save(plugin, ctx, "/r/app/globals.css");
    expect(asked).toBe(0);
  });
});
