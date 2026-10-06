import { describe, expect, it } from "bun:test";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const entry = new URL("./index.ts", import.meta.url).pathname;

/** Node's built-in module names, bare and with the `node:` prefix. */
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (path: string) => builtins.has(path) || path.startsWith("node:");

/**
 * The one built-in reference allowed, matched exactly. pi-ai's env key lookup
 * has a fallback for a Bun bug that reads /proc/self/environ through
 * `require("node:fs")`. It runs only when `process.versions.bun` is set, sits
 * in a try/catch, and esbuild emits it as a lazy `__require` call inside that
 * function, never as a module-level import, so a Convex isolate never loads it.
 */
const ALLOWED = [{ importer: "@mariozechner/pi-ai/dist/env-api-keys.js", path: "node:fs", kind: "require-call" }];

describe("runtime neutrality", () => {
  it("bundles for the browser the way Convex bundles an action, with no Node built-in import", async () => {
    // Convex bundles its default (isolate) runtime with esbuild for the browser
    // platform with code splitting on. An import esbuild cannot resolve fails
    // the build, which is how a bare built-in (`fs`, `crypto`) would surface.
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      splitting: true,
      outdir: "/tmp/platform-agent-bundle",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);

    // Every reference to a built-in from any bundled file, static, dynamic or require.
    const references = Object.entries(result.metafile.inputs).flatMap(([importer, input]) =>
      input.imports.filter((imported) => isBuiltin(imported.path)).map((imported) => ({ importer, path: imported.path, kind: imported.kind })),
    );
    const unexpected = references.filter(
      (ref) => !ALLOWED.some((allowed) => ref.importer.endsWith(allowed.importer) && ref.path === allowed.path && ref.kind === allowed.kind),
    );
    expect(unexpected).toEqual([]);
    expect(Object.keys(result.metafile.inputs).filter(isBuiltin)).toEqual([]);

    // Nothing is left for the runtime to resolve except that guarded require.
    const external = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.filter((imported) => imported.external).map((imported) => `${imported.kind}:${imported.path}`),
    );
    expect([...new Set(external)]).toEqual(["require-call:node:fs"]);

    // The Anthropic provider and the OpenAI fallback are reached through static imports only (the entry
    // chunk or a chunk it statically imports), never behind a dynamic import,
    // which a Convex isolate refuses at call time.
    const outputs = result.metafile.outputs;
    const entryName = Object.keys(outputs).find((name) => outputs[name].entryPoint?.endsWith("src/index.ts"))!;
    const loadedAtStart = new Set<string>();
    const walk = (name: string) => {
      if (loadedAtStart.has(name)) return;
      loadedAtStart.add(name);
      for (const imported of outputs[name]?.imports ?? []) if (imported.kind === "import-statement" && !imported.external) walk(imported.path);
    };
    walk(entryName);
    for (const provider of ["anthropic.js", "openai-responses.js"]) {
      const home = Object.keys(outputs).find((name) =>
        Object.keys(outputs[name].inputs).some((path) => path.endsWith(`pi-ai/dist/providers/${provider}`)),
      );
      expect(home && loadedAtStart.has(home)).toBe(true);
    }
  }, 120_000);

  it("keeps @platform/agent/meter free of runtime imports, so any Convex module can read the price table", async () => {
    const result = await build({
      entryPoints: [new URL("./meter.ts", import.meta.url).pathname],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((path) => path.split("/").pop())).toEqual(["meter.ts"]);
  });
});
