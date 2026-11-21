import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * React Compiler for the web app: which files it compiles, with what options,
 * and the switch that turns it off. One definition, three consumers:
 *
 * - the Vite build and dev server (vite.config.ts, through plugin-react's
 *   per-file babel hook), on by default;
 * - `bun test` and the perf harness (test-helpers/reactCompiler.ts), which
 *   never go through Vite and compile only when REACT_COMPILER=1;
 * - scripts/react-compiler-report.ts, which lists what the compiler skipped
 *   in these files and the render-time reads it would cache.
 *
 * The switch is the REACT_COMPILER environment variable. `REACT_COMPILER=0`
 * turns the compiler off everywhere, the Vite build included. Emptying
 * REACT_COMPILER_SOURCES does the same in code.
 *
 * The compiler caches whatever a component computes from the same inputs, so
 * it is only correct for a component whose render reads nothing but props,
 * state, context and hook results. Three reads this codebase makes break that
 * rule without the compiler noticing, and each one freezes a value on screen:
 * a helper that reads the store itself (`getState()` inside, or the `store`
 * proxy), a helper that reads the clock itself (a relative time), and
 * `localStorage` or a module-level cache. A fourth hides one step further: a
 * function a hook hands back that never changes and does such a read when
 * called (`useRelativeTime` once did, and every compiled row's "just now"
 * froze). Before a directory joins the list,
 * run the report on it and deal with every read it names: pass the value in
 * through a hook, or mark the component `"use no memo"` with the reason.
 */

/**
 * What the compiler compiles, relative to packages/web. An entry ending in
 * "/" is a directory and everything under it; any other entry is one file.
 * Test files, `__tests__` and `.native.` files are never compiled.
 */
export const REACT_COMPILER_SOURCES: readonly string[] = [
  // The transcript: its rows and blocks, and the session chrome around it.
  "components/conversation/",
  // Chrome that re-renders with the conversation on every message: the
  // message navigator, the assignment badge and the model control.
  "components/MessageBrowserPopover.tsx",
  "components/MessageNavPreview.tsx",
  "components/AssignmentBadge.tsx",
  "components/SessionControlMenu.tsx",
];

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEVER = /(?:\.test\.[tj]sx?|\.native\.[tj]sx?|\.d\.ts)$|\/__tests__\/|\/node_modules\//;

/**
 * The allowlist in force: REACT_COMPILER_SOURCES, or the comma-separated
 * REACT_COMPILER_SOURCES environment variable when it is set. The variable is
 * for measuring a candidate before it is added here (the report script and
 * perf/compilerAB.ts both read it), never for a shipped build.
 */
export function reactCompilerSources(env: Record<string, string | undefined> = process.env): readonly string[] {
  const override = env.REACT_COMPILER_SOURCES;
  if (override === undefined) return REACT_COMPILER_SOURCES;
  return override.split(",").map((s) => s.trim()).filter(Boolean);
}

/** `REACT_COMPILER=0` turns the compiler off everywhere. */
export function reactCompilerOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.REACT_COMPILER === "0" || reactCompilerSources(env).length === 0;
}

/** Whether a source list covers this file (absolute path, or relative to packages/web; a `?query` is ignored). */
export function inReactCompilerSources(file: string, sources: readonly string[]): boolean {
  const clean = file.split("?")[0];
  if (!/\.[tj]sx?$/.test(clean) || NEVER.test(clean)) return false;
  const rel = path.isAbsolute(clean) ? path.relative(WEB_ROOT, clean) : clean;
  if (rel.startsWith("..")) return false;
  const posix = rel.split(path.sep).join("/");
  return sources.some((entry) => (entry.endsWith("/") ? posix.startsWith(entry) : posix === entry));
}

/**
 * A pattern over absolute paths that matches every file under the allowlist
 * and nothing else, for a loader that must name what it intercepts up front
 * (bun's onLoad). It also matches the test files in a listed directory, which
 * reactCompilerCompiles then refuses.
 */
export function reactCompilerPathFilter(env: Record<string, string | undefined> = process.env): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entries = reactCompilerSources(env).map((entry) => (entry.endsWith("/") ? `${escape(entry)}.*\\.[tj]sx?` : escape(entry)));
  if (reactCompilerOff(env) || entries.length === 0) return /$^/;
  return new RegExp(`^${escape(WEB_ROOT.split(path.sep).join("/"))}/(?:${entries.join("|")})$`);
}

/** Whether the compiler compiles this file under the current environment. */
export function reactCompilerCompiles(file: string, env: Record<string, string | undefined> = process.env): boolean {
  return !reactCompilerOff(env) && inReactCompilerSources(file, reactCompilerSources(env));
}

/**
 * The compiler's options, the same wherever it runs.
 *
 * - `target: "19"`: the memo cache comes from `react/compiler-runtime`, which
 *   React 19 ships; no runtime package.
 * - `panicThreshold: "none"`: a component the compiler cannot prove safe (a
 *   ref read in render, a suppressed hooks lint rule, a manual memo whose deps
 *   it cannot keep) is left exactly as written, and the build goes on.
 * - `compilationMode: "infer"`: components and hooks, found by name and JSX.
 */
export const REACT_COMPILER_OPTIONS = {
  target: "19",
  panicThreshold: "none",
  compilationMode: "infer",
} as const;

export const REACT_COMPILER_PLUGIN = "babel-plugin-react-compiler";
/** The module compiled output imports its memo cache from. */
export const REACT_COMPILER_RUNTIME = "react/compiler-runtime";

/**
 * plugin-react's per-file babel options: the compiler for a file on the list,
 * nothing for any other. With no plugin, plugin-react skips babel for that
 * file in a production build, so the build pays babel only for the list.
 * The compiler must run first among babel plugins; plugin-react appends its
 * own (Fast Refresh) after the ones returned here.
 */
export function reactCompilerBabelOptions(id: string, env: Record<string, string | undefined> = process.env) {
  if (!reactCompilerCompiles(id, env)) return {};
  return { plugins: [[REACT_COMPILER_PLUGIN, REACT_COMPILER_OPTIONS] as [string, object]] };
}
