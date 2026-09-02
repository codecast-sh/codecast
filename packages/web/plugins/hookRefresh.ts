import path from "node:path";
import type { Plugin } from "vite";
import { STORE_FILE } from "./storeHmr";

/**
 * Makes React Fast Refresh see custom hooks that live in plain `.ts` files.
 *
 * @vitejs/plugin-react runs the react-refresh babel transform on a file only
 * when its name ends in `x` or its source mentions the JSX runtime module
 * (`isJSX || code.includes("react/jsx-runtime")` in its transform hook). A
 * `hooks/useFoo.ts` module therefore gets no `$RefreshSig$` signature, so a
 * change to the hooks it calls is invisible to Refresh: the importing `.tsx`
 * component is treated as an in-place update with its hook state preserved,
 * then renders with a different hook order. React reports that as
 * "Cannot read properties of null (reading 'getSnapshot')" or "change in the
 * order of Hooks", and the fix used to be a manual reload. With a signature on
 * the hook module, the consuming component's full signature (its own hooks plus
 * every custom hook it calls, recursively) changes, and Refresh remounts it.
 *
 * The lever is the gate itself: append a comment containing the runtime module
 * name to every `.ts` module under the web root that defines a `use*` function.
 * Append-only, so every original line keeps its position and no source map is
 * needed for this step. Skipped: `.tsx` (already signed), `.d.ts`, anything in
 * node_modules or outside the web root, modules that already own their HMR via
 * `import.meta.hot`, and the inbox store, whose hot swap plugins/storeHmr.ts
 * manages and which the refresh wrapper's accept-then-invalidate would undo.
 */

const PLUGIN_NAME = "codecast-hook-refresh";
export const REACT_PLUGIN_GATE = "react/jsx-runtime";
// A hook definition with a body: `function useX(` / `function useX<T>(`,
// `const useX = (` / `= async (` / `= x =>` / `= <T>(`. Store objects created by
// zustand's `create()` are deliberately not matched — Refresh signs only
// functions, and those modules are not hook modules.
const HOOK_DEF_RE =
  /\bfunction\s+use[A-Z]\w*\s*[(<]|\bconst\s+use[A-Z]\w*\s*=\s*(?:async\s*)?(?:\(|<|[A-Za-z_$][\w$]*\s*=>)/;

export function hookRefreshPlugin(): Plugin {
  let root = "";
  return {
    name: PLUGIN_NAME,
    // Dev only: Refresh does not exist in a build.
    apply: "serve",
    // Same phase as plugin-react, and listed before it in vite.config.ts, so the
    // marker is present when its transform reads the source.
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.includes("/node_modules/")) return null;
      if (root && !file.startsWith(root + path.sep)) return null;
      if (file.endsWith(path.sep + path.normalize(STORE_FILE))) return null;
      if (code.includes("import.meta.hot") || code.includes(REACT_PLUGIN_GATE)) return null;
      if (!HOOK_DEF_RE.test(code)) return null;
      return {
        code: `${code}\n// ${REACT_PLUGIN_GATE}: opts this hook module into Fast Refresh (plugins/hookRefresh.ts)\n`,
        map: null,
      };
    },
  };
}
