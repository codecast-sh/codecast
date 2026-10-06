// JSX and TypeScript become plain ES modules when a version is written, so
// the runtime serves files a browser runs as they are. Imports are left alone:
// bare specifiers resolve through the version's import map (lib/runtime.ts).
import { transform, type Transform } from "sucrase";
import { fileExtension } from "./files";

export type TranspileResult = { ok: true; code: string } | { ok: false; error: string };

const TRANSFORMS: Record<string, Transform[]> = {
  jsx: ["jsx"],
  ts: ["typescript"],
  tsx: ["jsx", "typescript"],
};

export function transpile(path: string, source: string): TranspileResult {
  const transforms = TRANSFORMS[fileExtension(path)];
  if (!transforms) return { ok: true, code: source };
  try {
    const { code } = transform(source, {
      transforms,
      jsxRuntime: "automatic",
      production: true,
      disableESTransforms: true,
      filePath: path,
    });
    return { ok: true, code };
  } catch (e) {
    return { ok: false, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
