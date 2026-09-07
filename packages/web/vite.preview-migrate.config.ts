import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { sharedResolve } from "./vite.shared";

/**
 * Standalone preview of the Settings → Migration panel over fixture data
 * (preview/migrate.html). Swaps the store, the query hook, the roster feeder
 * and the Convex client for the mocks under preview/mocks so the real panel
 * renders every state without a backend:
 *
 *   bunx vite --config vite.preview-migrate.config.ts
 *   open http://127.0.0.1:5199/migrate.html        (?theme=light)
 */

const here = __dirname;
const mocked: Record<string, string> = {
  [path.resolve(here, "store/inboxStore.ts")]: path.resolve(here, "preview/mocks/inboxStore.ts"),
  [path.resolve(here, "hooks/useQueryNoThrow.ts")]: path.resolve(here, "preview/mocks/useQueryNoThrow.ts"),
  [path.resolve(here, "hooks/useSyncDevices.ts")]: path.resolve(here, "preview/mocks/useSyncDevices.ts"),
};

function previewMocks(): Plugin {
  return {
    name: "migrate-preview-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null;
      const abs = path.resolve(path.dirname(importer), source);
      for (const ext of ["", ".ts", ".tsx"]) {
        const mock = mocked[abs + ext];
        if (mock) return mock;
      }
      return null;
    },
  };
}

export default defineConfig({
  root: path.resolve(here, "preview"),
  plugins: [previewMocks(), react()],
  resolve: {
    ...sharedResolve,
    alias: {
      ...sharedResolve.alias,
      "convex/react": path.resolve(here, "preview/mocks/convexReact.ts"),
      "@codecast/convex/convex/_generated/api": path.resolve(here, "preview/mocks/generatedApi.ts"),
    },
  },
  css: { postcss: here },
  define: { __CODECAST_BUILD__: JSON.stringify({ sha: "preview", builtAt: "", mode: "preview" }) },
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
});
