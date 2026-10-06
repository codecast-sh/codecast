// The web app's Vite config with everything that moves under load turned off,
// for scripts/frozen-dev.sh: no HMR, no file watcher, its own deps cache, and
// none of the plugins that restart or reload the server (the stall watchdog,
// the deps cache guard). Other sessions editing files never reload a page
// served from here; restart it to pick up changes.
import base from "../vite.config";

export default async (env: any) => {
  const config: any = typeof base === "function" ? await (base as any)(env) : base;
  const port = Number(process.env.FROZEN_PORT);
  config.root = new URL("..", import.meta.url).pathname;
  config.cacheDir = process.env.FROZEN_CACHE_DIR;
  config.plugins = (config.plugins || []).flat().filter((p: any) => p && !/stall|depsCacheGuard/i.test(p.name || ""));
  config.server = { ...config.server, port, strictPort: true, hmr: false, watch: null };
  return config;
};
