// Builds a codecast mod: reads the folder, validates the manifest, bundles the
// hooks module together with the SDK into one script for the sandbox, and
// inspects the source against the manifest's grants. Contract:
// shared/contracts/mods.ts. The SDK and the author typings are embedded in the
// binary, so a mod builds the same from any install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore: embedded as text; the SDK is bundled into every mod, not imported here.
import SDK_SOURCE from "../../../shared/mods/sdk.ts" with { type: "text" };
// @ts-ignore: embedded as text; bundled into every local half.
import LOCAL_SDK_SOURCE from "../../../shared/mods/localSdk.ts" with { type: "text" };
// @ts-ignore: embedded as text for `cast mod new` and `cast mod types`.
import AUTHORING_TYPES from "../../../shared/mods/authoring.d.ts" with { type: "text" };
import { validateManifest, type ModManifest } from "@codecast/shared/contracts/mods";
import { inspectModSource, type ModInspection } from "@codecast/shared/mods/inspect";
import { localHash } from "./localRunner.js";

export const MANIFEST_FILE = "codecast-mod.json";
export const TYPES_FILE = "codecast-mod.d.ts";
export const authoringTypes = (): string => AUTHORING_TYPES as string;

export type ModBuild =
  | { ok: true; manifest: ModManifest; code: string; local?: { code: string; hash: string }; source: Record<string, string>; inspection: ModInspection; warnings: string[]; dir: string }
  | { ok: false; errors: string[]; dir: string };

const SOURCE_EXT = /\.(tsx?|jsx?|json|md|css|svg|txt)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".codecast"]);

/** Every text file of the mod, path → text: what a version keeps so it can be read and forked. */
export function readModSource(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(r); continue; }
      if (!SOURCE_EXT.test(entry.name) || entry.name === TYPES_FILE) continue;
      const stat = fs.statSync(path.join(dir, r));
      if (stat.size > 200_000) continue;
      out[r] = fs.readFileSync(path.join(dir, r), "utf8");
    }
  };
  walk("");
  return out;
}

export function findModDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export async function buildMod(dirArg: string): Promise<ModBuild> {
  const dir = findModDir(dirArg) ?? path.resolve(dirArg);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return { ok: false, dir, errors: [`no ${MANIFEST_FILE} in ${dir} or above it (cast mod new <name> makes one)`] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, dir, errors: [`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`] };
  }
  const check = validateManifest(raw);
  if (!check.ok) return { ok: false, dir, errors: check.errors.map((e) => `${MANIFEST_FILE}: ${e}`) };
  const manifest = check.manifest;
  const main = path.join(dir, manifest.main ?? "ui.tsx");
  if (!fs.existsSync(main)) return { ok: false, dir, errors: [`the hooks module ${path.relative(dir, main)} does not exist (set "main" in ${MANIFEST_FILE})`] };

  const ui = await bundle(main, "browser");
  if (!ui.ok) return { ok: false, dir, errors: ui.errors };
  const code = ui.code;
  let local: { code: string; hash: string } | undefined;
  if (manifest.local) {
    const localMain = path.join(dir, manifest.local.main);
    if (!fs.existsSync(localMain)) return { ok: false, dir, errors: [`the local module ${manifest.local.main} does not exist`] };
    const built = await bundle(localMain, "bun");
    if (!built.ok) return { ok: false, dir, errors: built.errors.map((e) => `${manifest.local!.main}: ${e}`) };
    local = { code: built.code, hash: localHash(built.code) };
  }
  const source = readModSource(dir);
  const inspection = inspectModSource(source, manifest);
  const warnings: string[] = [...ui.warnings];
  for (const u of inspection.unserved) warnings.push(`the manifest declares ${u}, and no hook draws it`);
  for (const u of inspection.unknown) warnings.push(`$.${u} is not part of the mod API (see ${TYPES_FILE})`);
  for (const u of inspection.unused) warnings.push(`${u} is granted and never used; ask for less`);
  if (inspection.missing.length) {
    return { ok: false, dir, errors: inspection.missing.map((m) => `the code needs ${m} in ${MANIFEST_FILE}`) };
  }
  return { ok: true, manifest, code, local, source, inspection, warnings, dir };
}

/**
 * One half of a mod as one script. The sandboxed half is an IIFE for the
 * browser with `codecast-mod` resolved to the SDK; the local half an ES module
 * for Bun with `codecast-mod/local` resolved to the local SDK. Both start the
 * SDK with the module's `register`.
 */
async function bundle(main: string, target: "browser" | "bun"): Promise<{ ok: true; code: string; warnings: string[] } | { ok: false; errors: string[] }> {
  const sdk = target === "browser" ? "codecast-mod" : "codecast-mod/local";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-mod-"));
  const entry = path.join(tmp, "entry.ts");
  fs.writeFileSync(entry, `import * as mod from ${JSON.stringify(main)};\nimport { start } from ${JSON.stringify(sdk)};\nstart((mod as any).register);\n`);
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      format: target === "browser" ? "iife" : "esm",
      target,
      minify: { whitespace: true, syntax: true, identifiers: false },
      jsx: { factory: "h", fragment: "Fragment", runtime: "classic" } as any,
      plugins: [{
        name: "codecast-mod-sdk",
        setup(b) {
          b.onResolve({ filter: /^codecast-mod(\/local)?$/ }, (args) => ({ path: args.path === "codecast-mod" ? "sdk" : "local", namespace: "codecast-mod" }));
          b.onLoad({ filter: /.*/, namespace: "codecast-mod" }, (args) => ({ contents: (args.path === "sdk" ? SDK_SOURCE : LOCAL_SDK_SOURCE) as string, loader: "ts" }));
        },
      }],
    });
    if (!result.success) return { ok: false, errors: result.logs.map((l) => String(l)) };
    return { ok: true, code: await result.outputs[0].text(), warnings: result.logs.filter((l) => l.level === "warning").map((l) => String(l)) };
  } catch (err) {
    const logs = (err as any)?.errors ?? (err as any)?.logs;
    return { ok: false, errors: Array.isArray(logs) && logs.length ? logs.map((l: unknown) => String(l)) : [(err as Error).message] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
