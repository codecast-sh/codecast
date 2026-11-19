// React Compiler under bun, for `bun test` and the perf harness. Neither goes
// through Vite, so without this nothing outside a browser ever runs compiled
// output. Opt-in: it does nothing unless REACT_COMPILER=1.
//
//   REACT_COMPILER=1 bun test components/inbox/SessionCardView.mount.test.tsx
//   REACT_COMPILER=1 scripts/perf-budgets.sh
//
// It is a bun test preload (bunfig.toml, listed first so it is registered
// before any app module loads) and perf/harness.tsx imports it before its
// first app module. The files it compiles and the options it compiles them
// with are the Vite build's (plugins/reactCompiler.ts): each listed file goes
// through babel with the compiler alone, types and JSX intact, and bun then
// transpiles the result as it would have transpiled the source.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plugin } from "bun";
import { REACT_COMPILER_OPTIONS, REACT_COMPILER_PLUGIN, reactCompilerCompiles, reactCompilerOff, reactCompilerPathFilter } from "../plugins/reactCompiler";

/** True when this process compiles the listed files. */
export const reactCompilerActive = process.env.REACT_COMPILER === "1" && !reactCompilerOff();

// Compiled text is kept on disk by a hash of the source, the options and the
// compiler's version: a test process starts cold every time, and babel on a
// large component costs more than the test that mounts it.
const CACHE_DIR = path.resolve(import.meta.dir, "..", "node_modules", ".cache", "react-compiler");

let babel: typeof import("@babel/core") | undefined;
let salt: string | undefined;

/** One listed file's source, compiled. Exported for the report script and tests. */
export function compileForBun(file: string, source: string): string {
  babel ??= require("@babel/core") as typeof import("@babel/core");
  salt ??= JSON.stringify([require(`${REACT_COMPILER_PLUGIN}/package.json`).version, babel.version, REACT_COMPILER_OPTIONS]);
  const key = createHash("sha1").update(salt).update("\0").update(file).update("\0").update(source).digest("hex");
  const cached = path.join(CACHE_DIR, `${key}.txt`);
  if (existsSync(cached)) return readFileSync(cached, "utf8");
  const result = babel.transformSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins: file.endsWith(".ts") ? ["typescript"] : ["typescript", "jsx"] },
    plugins: [[REACT_COMPILER_PLUGIN, REACT_COMPILER_OPTIONS]],
    sourceMaps: "inline",
  });
  const code = result?.code ?? source;
  mkdirSync(CACHE_DIR, { recursive: true });
  // Written whole, then renamed: parallel test processes share the directory.
  const tmp = `${cached}.${process.pid}.tmp`;
  writeFileSync(tmp, code);
  renameSync(tmp, cached);
  return code;
}

if (reactCompilerActive) {
  plugin({
    name: "react-compiler",
    setup(build) {
      // bun's onLoad must answer for every path its filter matches, so the
      // filter is the allowlist itself, and a test file inside a listed
      // directory gets its own source back.
      build.onLoad({ filter: reactCompilerPathFilter() }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const loader = path.extname(args.path).slice(1) as "ts" | "tsx" | "js" | "jsx";
        return { contents: reactCompilerCompiles(args.path) ? compileForBun(args.path, source) : source, loader };
      });
    },
  });
}
