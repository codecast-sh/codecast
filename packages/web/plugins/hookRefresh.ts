import path from "node:path";
import type { Plugin } from "vite";
import { STORE_FILE } from "./storeHmr";

/**
 * Makes React Fast Refresh see custom hooks that live in plain `.ts` files.
 *
 * @vitejs/plugin-react wires a module to the Refresh runtime in two steps, and
 * a hooks-only `.ts` module fails both. It runs the react-refresh babel
 * transform only when the file name ends in `x` or the source mentions the JSX
 * runtime module (`isJSX || code.includes("react/jsx-runtime")`). Then it adds
 * the runtime wrapper (the head that points `$RefreshSig$` at the real runtime,
 * the footer that accepts the update) only when babel's output registered a
 * component. A module that exports only hooks passes neither gate, so its
 * `useFoo` never gets a signature and a change to the hooks it calls is
 * invisible to Refresh: the importing `.tsx` component is treated as an
 * in-place update with its hook state preserved, then renders with a different
 * hook order. React reports that as "Cannot read properties of null (reading
 * 'getSnapshot')" or "change in the order of Hooks", and the only fix was a
 * manual reload. With a real signature on the hook module, the consuming
 * component's full signature (its own hooks plus every custom hook it calls,
 * recursively) changes, and Refresh remounts it instead.
 *
 * Two plugins, one per gate:
 *
 * - `gate` (pre, before plugin-react reads the source) appends a comment naming
 *   the JSX runtime module to every `.ts` module under the web root that
 *   defines a `use*` function, so babel emits the `_s = $RefreshSig$()`
 *   signature calls.
 * - `sign` (post, after babel) prefixes the module with the head plugin-react
 *   would have added: point `window.$RefreshSig$` at the runtime for the
 *   duration of the module body, restore it after. Only the head, on purpose.
 *   plugin-react's footer would make the module self-accepting, and a module
 *   whose exports are hooks then invalidates itself on every edit and walks to
 *   its importers one client round trip per hop. Without it vite resolves the
 *   accepting components on the server in one shot, exactly the path these
 *   edits took before, now with the signature registered.
 *
 * Both edits keep every original line in place (an appended footer and a
 * one-line prefix), so the existing source map stays accurate. Skipped: `.tsx`
 * (already signed), `.d.ts`, node_modules, anything outside the web root,
 * modules that already own their HMR via `import.meta.hot`, and the inbox
 * store, whose hot swap plugins/storeHmr.ts manages.
 */

const PLUGIN_NAME = "codecast-hook-refresh";
export const REACT_PLUGIN_GATE = "react/jsx-runtime";
export const GATE_FOOTER = `// ${REACT_PLUGIN_GATE}: opts this hook module into Fast Refresh (plugins/hookRefresh.ts)\n`;
/** plugin-react serves the Refresh runtime at this id. */
export const REFRESH_RUNTIME_ID = "/@react-refresh";
export const SIGN_HEAD =
  `import * as __hookRefreshRuntime from "${REFRESH_RUNTIME_ID}"; ` +
  `const __hookRefreshPrevSig = typeof window !== "undefined" ? window.$RefreshSig$ : undefined; ` +
  `if (import.meta.hot && typeof window !== "undefined") window.$RefreshSig$ = __hookRefreshRuntime.createSignatureFunctionForTransform; `;
export const SIGN_TAIL = `\nif (import.meta.hot && typeof window !== "undefined") window.$RefreshSig$ = __hookRefreshPrevSig;\n`;

// A hook definition with a body: `function useX(` / `function useX<T>(`,
// `const useX = (` / `= async (` / `= x =>` / `= <T>(`. Store objects created by
// zustand's `create()` are deliberately not matched — Refresh signs only
// functions, and those modules are not hook modules.
const HOOK_DEF_RE =
  /\bfunction\s+use[A-Z]\w*\s*[(<]|\bconst\s+use[A-Z]\w*\s*=\s*(?:async\s*)?(?:\(|<|[A-Za-z_$][\w$]*\s*=>)/;

export function hookRefreshPlugin(): Plugin[] {
  let root = "";
  const isCandidateFile = (id: string): boolean => {
    const file = id.split("?")[0];
    if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.includes("/node_modules/")) return false;
    if (root && !file.startsWith(root + path.sep)) return false;
    if (file.endsWith(path.sep + path.normalize(STORE_FILE))) return false;
    return true;
  };
  return [
    {
      name: `${PLUGIN_NAME}:gate`,
      apply: "serve",
      enforce: "pre",
      configResolved(config) {
        root = config.root;
      },
      transform(code, id) {
        if (!isCandidateFile(id)) return null;
        if (code.includes("import.meta.hot") || code.includes(REACT_PLUGIN_GATE)) return null;
        if (!HOOK_DEF_RE.test(code)) return null;
        return { code: `${code}\n${GATE_FOOTER}`, map: null };
      },
    },
    {
      name: `${PLUGIN_NAME}:sign`,
      apply: "serve",
      enforce: "post",
      transform(code, id) {
        if (!isCandidateFile(id)) return null;
        // Babel emitted signatures, and plugin-react did not wire them itself.
        if (!code.includes("$RefreshSig$()") || code.includes(REFRESH_RUNTIME_ID)) return null;
        return { code: `${SIGN_HEAD}${code}${SIGN_TAIL}`, map: null };
      },
    },
  ];
}
