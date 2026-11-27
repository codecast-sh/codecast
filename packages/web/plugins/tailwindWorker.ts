import { Worker } from "node:worker_threads";
import postcss from "postcss";

/**
 * Runs Tailwind in a worker thread for the dev server, one build at a time.
 *
 * Tailwind v3 rebuilds its context from scratch whenever the stylesheet that
 * holds `@tailwind` changes, then re-extracts every line of every content file
 * (about 2,900 files here). Agents edit globals.css all day, and on a loaded
 * machine one such build took 221s of JavaScript. On Vite's own thread that
 * work starves the event loop: saves start new builds before the last one
 * finishes, they overlap, and the server stops accepting connections at all
 * (2026-10-04: 39 connections parked in the listen queue for minutes while
 * every page spun). In a worker a slow build only delays the stylesheet.
 *
 * Builds for one stylesheet are coalesced: while one runs, later requests wait
 * for a single follow-up build of the newest source, so a burst of saves costs
 * at most two builds instead of one each.
 *
 * The worker lives for the whole process. `server.restart()` (the deps-cache
 * guard, a config edit) re-evaluates vite.config.ts, and a fresh worker would
 * pay the cold build again; the shared one keeps Tailwind's caches warm.
 *
 * Production builds keep the plain postcss config; this replaces only the
 * `tailwindcss` entry for `vite serve`.
 */

const WORKER_URL = new URL("./tailwindWorker.worker.mjs", import.meta.url);

// The directives and functions Tailwind acts on. Stylesheets without any of
// them pass through untouched instead of round-tripping to the worker.
const TAILWIND_SYNTAX = /@tailwind|@apply|@layer|@config|@screen|@variants|@responsive|theme\(|screen\(/;

interface BuildResult {
  css: string;
  messages: postcss.Message[];
}

interface Waiter {
  resolve: (r: BuildResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  running: boolean;
  next: { css: string; waiters: Waiter[] } | null;
}

type Build = (css: string, from: string) => Promise<BuildResult>;

function createBuilder(configPath: string): Build {
  let worker: Worker | null = null;
  let nextId = 0;
  const inFlight = new Map<number, Waiter>();
  const slots = new Map<string, Slot>();

  const getWorker = () => {
    if (worker) return worker;
    const w = new Worker(WORKER_URL, { workerData: { configPath } });
    // Never the thing that keeps the dev server process alive.
    w.unref();
    w.on("message", ({ id, css, messages, error }) => {
      const waiter = inFlight.get(id);
      if (!waiter) return;
      inFlight.delete(id);
      if (error) waiter.reject(Object.assign(new Error(error.message), { stack: error.stack, name: error.name }));
      else waiter.resolve({ css, messages });
    });
    // A crashed worker fails what it held and is replaced on the next build.
    const reset = (err: Error) => {
      if (worker === w) worker = null;
      for (const waiter of inFlight.values()) waiter.reject(err);
      inFlight.clear();
    };
    w.on("error", reset);
    w.on("exit", (code) => reset(new Error(`tailwind worker exited (code ${code})`)));
    worker = w;
    return w;
  };

  const runOnce: Build = (css, from) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      inFlight.set(id, { resolve, reject });
      getWorker().postMessage({ id, css, from });
    });

  const drain = async (from: string, slot: Slot) => {
    slot.running = true;
    while (slot.next) {
      const { css, waiters } = slot.next;
      slot.next = null;
      try {
        const result = await runOnce(css, from);
        for (const w of waiters) w.resolve(result);
      } catch (err) {
        for (const w of waiters) w.reject(err as Error);
      }
    }
    slot.running = false;
  };

  return (css, from) =>
    new Promise((resolve, reject) => {
      let slot = slots.get(from);
      if (!slot) slots.set(from, (slot = { running: false, next: null }));
      // A newer source replaces the queued one; everyone waiting gets the newest build.
      slot.next = { css, waiters: [...(slot.next?.waiters ?? []), { resolve, reject }] };
      if (!slot.running) void drain(from, slot);
    });
}

const BUILDERS_KEY = Symbol.for("codecast.tailwindWorker.builders");

function sharedBuilder(configPath: string): Build {
  const g = globalThis as { [BUILDERS_KEY]?: Map<string, Build> };
  const builders = (g[BUILDERS_KEY] ??= new Map());
  let build = builders.get(configPath);
  if (!build) builders.set(configPath, (build = createBuilder(configPath)));
  return build;
}

/** The `tailwindcss` PostCSS plugin, run in the shared worker. */
export function tailwindInWorker(configPath: string): postcss.Plugin {
  const build = sharedBuilder(configPath);
  return {
    postcssPlugin: "tailwindcss-worker",
    async Once(root, { result }) {
      const source = root.toString();
      if (!TAILWIND_SYNTAX.test(source)) return;
      const from = result.opts.from ?? "";
      const built = await build(source, from);
      root.removeAll();
      root.append(postcss.parse(built.css, { from }).nodes);
      result.messages.push(...built.messages);
    },
  };
}

export { createBuilder as createTailwindBuilder };
