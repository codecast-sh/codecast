import { describe, expect, test } from "bun:test";
import { hookRefreshPlugin, REACT_PLUGIN_GATE } from "./hookRefresh";

const ROOT = "/repo/packages/web";

function run(id: string, code: string): string | null {
  const plugin = hookRefreshPlugin() as any;
  plugin.configResolved({ root: ROOT });
  const out = plugin.transform.call({}, code, id);
  return out ? out.code : null;
}

const HOOK = `import { useState } from "react";\nexport function useThing() {\n  return useState(0);\n}\n`;

describe("hookRefreshPlugin", () => {
  test("marks a .ts module that defines a hook, append-only", () => {
    const out = run(`${ROOT}/hooks/useThing.ts`, HOOK);
    expect(out).not.toBeNull();
    expect(out!.startsWith(HOOK)).toBe(true);
    expect(out!.slice(HOOK.length)).toContain(REACT_PLUGIN_GATE);
    expect(out!.split("\n").slice(0, HOOK.split("\n").length)).toEqual(HOOK.split("\n"));
  });

  test("matches arrow-function and generic hook definitions", () => {
    expect(run(`${ROOT}/lib/a.ts`, `export const useA = (x: number) => x;`)).not.toBeNull();
    expect(run(`${ROOT}/lib/b.ts`, `export const useB = async () => 1;`)).not.toBeNull();
    expect(run(`${ROOT}/lib/c.ts`, `export const useC = <T,>(x: T) => x;`)).not.toBeNull();
    expect(run(`${ROOT}/lib/d.ts`, `const useD = s => s;\nexport { useD };`)).not.toBeNull();
    expect(run(`${ROOT}/lib/e.ts`, `export function useE<T>(x: T) { return x; }`)).not.toBeNull();
  });

  test("leaves modules without a hook definition alone", () => {
    expect(run(`${ROOT}/lib/util.ts`, `export const sum = (a: number, b: number) => a + b;`)).toBeNull();
    // zustand stores are not hook modules
    expect(run(`${ROOT}/store/vaultStore.ts`, `export const useVaultStore = create<S>((set) => ({}));`)).toBeNull();
    // a call, not a definition
    expect(run(`${ROOT}/lib/callsite.ts`, `const v = useThing();`)).toBeNull();
  });

  test("skips files plugin-react already signs or that own their HMR", () => {
    expect(run(`${ROOT}/components/X.tsx`, HOOK)).toBeNull();
    expect(run(`${ROOT}/hooks/useThing.d.ts`, HOOK)).toBeNull();
    expect(run(`${ROOT}/hooks/useThing.ts`, `${HOOK}// ${REACT_PLUGIN_GATE}\n`)).toBeNull();
    expect(run(`${ROOT}/lib/calls/walkie.ts`, `${HOOK}if (import.meta.hot) {}\n`)).toBeNull();
    expect(run(`${ROOT}/store/inboxStore.ts`, `export function useTrackedStore() {}`)).toBeNull();
  });

  test("skips node_modules and anything outside the web root", () => {
    expect(run(`${ROOT}/node_modules/pkg/useThing.ts`, HOOK)).toBeNull();
    expect(run(`/repo/platform/packages/keys/src/useKeys.ts`, HOOK)).toBeNull();
  });

  test("ignores the query string on the id", () => {
    expect(run(`${ROOT}/hooks/useThing.ts?t=123`, HOOK)).not.toBeNull();
  });
});
