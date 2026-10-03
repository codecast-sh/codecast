// The app's own vite config for the smoke stack's second dev server
// (stack.mjs): its own optimizer cache, so it never rewrites the one the dev
// server on 3200 serves from, and no HMR, so a save in the shared checkout
// never reloads a page in the middle of a leg.
import { mergeConfig } from "vite";
import base from "../../vite.config";

export default (env) => mergeConfig(base(env), { cacheDir: "node_modules/.vite-smoke", server: { hmr: false } });
