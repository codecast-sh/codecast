import { Worker } from "node:worker_threads";
import postcss, { type PluginCreator } from "postcss";
import type { Plugin } from "vite";

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

export function createTailwindWorker(configPath: string) {
  let worker: Worker | null = null;
  let nextId = 0;
  const inFlight = new Map<number, Waiter>();
  const slots = new Map<string, Slot>();

  const failAll = (err: Error) => {
    for (const w of inFlight.values()) w.reject(err);
    inFlight.clear();
  };

  const getWorker = () => {
    if (worker) return worker;
    const w = new Worker(WORKER_URL, { workerData: { configPath } });
    w.unref();
    w.on("message", ({ id, css, messages, error }) => {
      const waiter = inFlight.get(id);
      if (!waiter) return;
      inFlight.delete(id);
      if (error) waiter.reject(Object.assign(new Error(error.message), { stack: error.stack, name: error.name }));
      else waiter.resolve({ css, messages });
    });
    // A crashed worker is replaced on the next build.
    const reset = (err: Error) => {
      if (worker === w) worker = null;
      failAll(err);
    };
    w.on("error", reset);
    w.on("exit", (code) => reset(new Error(`tailwind worker exited (code ${code})`)));
    worker = w;
    return w;
  };

  const runOnce = (css: string, from: string) =>
    new Promise<BuildResult>((resolve, reject) => {
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

  /** Builds `css` (the source of `from`), sharing a build with any request queued behind the running one. */
  const build = (css: string, from: string) =>
    new Promise<BuildResult>((resolve, reject) => {
      let slot = slots.get(from);
      if (!slot) slots.set(from, (slot = { running: false, next: null }));
      // A newer source replaces the queued one; everyone waiting gets the newest build.
      slot.next = { css, waiters: [...(slot.next?.waiters ?? []), { resolve, reject }] };
      if (!slot.running) void drain(from, slot);
    });

  const postcssPlugin: PluginCreator<void> = () => ({
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
  });
  postcssPlugin.postcss = true;

  const vitePlugin: Plugin = {
    name: "codecast-tailwind-worker",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("close", () => {
        failAll(new Error("dev server closed"));
        void worker?.terminate();
        worker = null;
      });
    },
  };

  return { postcssPlugin, vitePlugin, build };
}
