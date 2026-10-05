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
// @ts-ignore: embedded as text for `cast mod new` and `cast mod types`.
import AUTHORING_TYPES from "../../../shared/mods/authoring.d.ts" with { type: "text" };
import { validateManifest, type ModManifest } from "@codecast/shared/contracts/mods";
import { inspectModSource, type ModInspection } from "@codecast/shared/mods/inspect";

export const MANIFEST_FILE = "codecast-mod.json";
export const TYPES_FILE = "codecast-mod.d.ts";
export const authoringTypes = (): string => AUTHORING_TYPES as string;

export type ModBuild =
  | { ok: true; manifest: ModManifest; code: string; source: Record<string, string>; inspection: ModInspection; warnings: string[]; dir: string }
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-mod-"));
  const entry = path.join(tmp, "entry.ts");
  fs.writeFileSync(entry, `import * as mod from ${JSON.stringify(main)};\nimport { start } from "codecast-mod";\nstart((mod as any).register);\n`);
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      minify: { whitespace: true, syntax: true, identifiers: false },
      jsx: { factory: "h", fragment: "Fragment", runtime: "classic" } as any,
      plugins: [{
        name: "codecast-mod-sdk",
        setup(b) {
          b.onResolve({ filter: /^codecast-mod$/ }, () => ({ path: "sdk", namespace: "codecast-mod" }));
          b.onLoad({ filter: /.*/, namespace: "codecast-mod" }, () => ({ contents: SDK_SOURCE as string, loader: "ts" }));
        },
      }],
    });
  } catch (err) {
    const logs = (err as any)?.errors ?? (err as any)?.logs;
    const lines = Array.isArray(logs) && logs.length ? logs.map((l: unknown) => String(l)) : [(err as Error).message];
    return { ok: false, dir, errors: lines };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!result.success) return { ok: false, dir, errors: result.logs.map((l) => String(l)) };
  const code = await result.outputs[0].text();
  const source = readModSource(dir);
  const inspection = inspectModSource(source, manifest);
  const warnings: string[] = result.logs.filter((l) => l.level === "warning").map((l) => String(l));
  for (const u of inspection.unserved) warnings.push(`the manifest declares ${u}, and no hook draws it`);
  for (const u of inspection.unknown) warnings.push(`$.${u} is not part of the mod API (see ${TYPES_FILE})`);
  if (inspection.missing.length) {
    return { ok: false, dir, errors: inspection.missing.map((m) => `the code needs ${m} in ${MANIFEST_FILE}`) };
  }
  return { ok: true, manifest, code, source, inspection, warnings, dir };
}
