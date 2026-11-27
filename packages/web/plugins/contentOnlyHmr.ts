import { isCSSRequest, type Plugin } from "vite";
import { rebuildTailwindSheets } from "./tailwindWorker";

/**
 * A save to a file Tailwind scans updates the stylesheet only when the CSS
 * Tailwind generates changed.
 *
 * Tailwind reports its content globs as dependencies of the stylesheet, and
 * Vite turns each scanned file into a module the stylesheet imports. Two costs
 * followed. A save to a file no window had loaded reloaded every window
 * (2026-10-08: a dozen reloads of four desktop windows in twenty minutes). And
 * a save to any scanned file, loaded or not, pushed the whole stylesheet,
 * about 900 KB, to every connected window: Vite walks a module's stylesheet
 * importers on every update. With agents saving all day that was 30 MB a
 * minute into each open tab, hidden ones too, and it took down the shared
 * Chrome bridge (2026-11-26).
 *
 * So the dev Tailwind plugin (tailwindWorker.ts) keeps the content globs from
 * Vite, and this plugin does the one thing such a save can do to a connected
 * window: when Tailwind's output for a stylesheet changed (a class no file
 * used before), it reloads that stylesheet module. A save to a loaded module
 * hot-swaps through Vite as before; one to an unloaded module touches nothing.
 */

const PLUGIN_NAME = "codecast-content-only-hmr";

/** What Tailwind scans here (tailwind.config.ts `content`, less index.html,
 *  which reloads on its own). */
const SCANNED = /\.(?:[cm]?[jt]sx?|mdx)$/;

export function isScannedSave(file: string): boolean {
  return SCANNED.test(file) && !isCSSRequest(file) && !file.includes("/node_modules/");
}

/**
 * Runs `check` for a burst of saves at most twice: one run, and one more for
 * every save that landed while it ran.
 */
export function coalesced(check: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await check();
      } while (again);
    } catch (err) {
      // Never an unhandled rejection in the dev server: Node exits on one.
      console.warn(`[${PLUGIN_NAME}] stylesheet check failed`, err);
    } finally {
      running = false;
    }
  };
  return () => void run();
}

export function contentOnlyHmrPlugin(rebuild: () => Promise<string[]> = rebuildTailwindSheets): Plugin {
  let schedule: (() => void) | null = null;
  // With no window connected there is nobody to update; a window that
  // connects later loads the stylesheet fresh, and the next check still sees
  // it as changed against what was last pushed (tailwindWorker.ts).
  let windows: { size: number } | null = null;
  return {
    name: PLUGIN_NAME,
    apply: "serve",
    configureServer(server) {
      windows = server.ws.clients;
    },
    hotUpdate({ file }) {
      if (this.environment.name !== "client" || !isScannedSave(file)) return;
      if (windows && windows.size === 0) return;
      const env = this.environment;
      schedule ??= coalesced(async () => {
        for (const from of await rebuild()) {
          for (const mod of env.moduleGraph.getModulesByFile(from) ?? []) await env.reloadModule(mod);
        }
      });
      schedule();
    },
  };
}
