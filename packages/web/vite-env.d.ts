/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build identity stamped by vite.config.ts (`define`); read on window.__CODECAST_BUILD. */
declare const __CODECAST_BUILD__: { sha: string; builtAt: string; mode: string };
