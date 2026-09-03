import { describe, expect, test } from "bun:test";
import {
  GATE_FOOTER,
  REACT_PLUGIN_GATE,
  REFRESH_RUNTIME_ID,
  SIGN_HEAD,
  SIGN_TAIL,
  hookRefreshPlugin,
} from "./hookRefresh";

const ROOT = "/repo/packages/web";

function plugins() {
  const [gate, sign] = hookRefreshPlugin() as any[];
  gate.configResolved({ root: ROOT });
  return { gate, sign };
}
function runGate(id: string, code: string): string | null {
  const out = plugins().gate.transform.call({}, code, id);
  return out ? out.code : null;
}
function runSign(id: string, code: string): string | null {
  const out = plugins().sign.transform.call({}, code, id);
  return out ? out.code : null;
}

const HOOK = `import { useState } from "react";\nexport function useThing() {\n  return useState(0);\n}\n`;
// What babel's react-refresh transform emits for HOOK.
const SIGNED = `var _s = $RefreshSig$();\nimport { useState } from "react";\nexport function useThing() {\n  _s();\n  return useState(0);\n}\n_s(useThing, "hash");\n`;

describe("hookRefreshPlugin gate (pre)", () => {
  test("marks a .ts module that defines a hook, append-only", () => {
    const out = runGate(`${ROOT}/hooks/useThing.ts`, HOOK);
    expect(out).toBe(`${HOOK}\n${GATE_FOOTER}`);
    expect(GATE_FOOTER).toContain(REACT_PLUGIN_GATE);
    // Never the component-registration marker: that would make plugin-react
    // add its accepting footer and turn the module into a per-hop boundary.
    expect(GATE_FOOTER).not.toMatch(/\$RefreshReg\$\(/);
  });

  test("matches arrow-function and generic hook definitions", () => {
    expect(runGate(`${ROOT}/lib/a.ts`, `export const useA = (x: number) => x;`)).not.toBeNull();
    expect(runGate(`${ROOT}/lib/b.ts`, `export const useB = async () => 1;`)).not.toBeNull();
    expect(runGate(`${ROOT}/lib/c.ts`, `export const useC = <T,>(x: T) => x;`)).not.toBeNull();
    expect(runGate(`${ROOT}/lib/d.ts`, `const useD = s => s;\nexport { useD };`)).not.toBeNull();
    expect(runGate(`${ROOT}/lib/e.ts`, `export function useE<T>(x: T) { return x; }`)).not.toBeNull();
  });

  test("leaves modules without a hook definition alone", () => {
    expect(runGate(`${ROOT}/lib/util.ts`, `export const sum = (a: number, b: number) => a + b;`)).toBeNull();
    // zustand stores are not hook modules
    expect(runGate(`${ROOT}/store/vaultStore.ts`, `export const useVaultStore = create<S>((set) => ({}));`)).toBeNull();
    // a call, not a definition
    expect(runGate(`${ROOT}/lib/callsite.ts`, `const v = useThing();`)).toBeNull();
  });

  test("skips files plugin-react already signs or that own their HMR", () => {
    expect(runGate(`${ROOT}/components/X.tsx`, HOOK)).toBeNull();
    expect(runGate(`${ROOT}/hooks/useThing.d.ts`, HOOK)).toBeNull();
    expect(runGate(`${ROOT}/hooks/useThing.ts`, `${HOOK}// ${REACT_PLUGIN_GATE}\n`)).toBeNull();
    expect(runGate(`${ROOT}/lib/calls/walkie.ts`, `${HOOK}if (import.meta.hot) {}\n`)).toBeNull();
    expect(runGate(`${ROOT}/store/inboxStore.ts`, `export function useTrackedStore() {}`)).toBeNull();
  });

  test("skips node_modules and anything outside the web root", () => {
    expect(runGate(`${ROOT}/node_modules/pkg/useThing.ts`, HOOK)).toBeNull();
    expect(runGate(`/repo/platform/packages/keys/src/useKeys.ts`, HOOK)).toBeNull();
  });

  test("ignores the query string on the id", () => {
    expect(runGate(`${ROOT}/hooks/useThing.ts?t=123`, HOOK)).not.toBeNull();
  });
});

describe("hookRefreshPlugin sign (post)", () => {
  test("wraps babel's signature calls with the runtime head, lines preserved", () => {
    const out = runSign(`${ROOT}/hooks/useThing.ts`, SIGNED);
    expect(out).toBe(`${SIGN_HEAD}${SIGNED}${SIGN_TAIL}`);
    // One-line prefix: line count of the original body is unchanged.
    expect(out!.split("\n").length).toBe(SIGNED.split("\n").length + SIGN_TAIL.split("\n").length - 1);
    expect(SIGN_HEAD).not.toContain("\n");
    expect(SIGN_HEAD).toContain(`from "${REFRESH_RUNTIME_ID}"`);
    expect(SIGN_HEAD).toContain("createSignatureFunctionForTransform");
    // Never an accept: the module must stay a non-boundary for vite's walk.
    expect(out).not.toContain("import.meta.hot.accept");
  });

  test("leaves modules plugin-react wired itself, and unsigned modules, alone", () => {
    expect(runSign(`${ROOT}/hooks/useThing.ts`, `import * as RefreshRuntime from "${REFRESH_RUNTIME_ID}";\n${SIGNED}`)).toBeNull();
    expect(runSign(`${ROOT}/lib/util.ts`, `export const sum = 1;`)).toBeNull();
    expect(runSign(`${ROOT}/components/X.tsx`, SIGNED)).toBeNull();
    expect(runSign(`${ROOT}/store/inboxStore.ts`, SIGNED)).toBeNull();
  });
});
