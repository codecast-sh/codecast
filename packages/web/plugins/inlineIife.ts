import fs from "node:fs/promises";
import path from "node:path";
import { transformWithEsbuild } from "vite";

/**
 * Compiles an import-free module into a minified IIFE that assigns its exports
 * to `globalName`, for a boot plugin to inline into index.html's <head>. The
 * caller appends the call it wants to run (`${code};${globalName}.fn()`).
 * Every inlined boot script goes through here so they share one target.
 */
export async function inlineIife(root: string, sourceRelPath: string, globalName: string): Promise<string> {
  const source = path.resolve(root, sourceRelPath);
  const { code } = await transformWithEsbuild(await fs.readFile(source, "utf8"), source, {
    format: "iife",
    globalName,
    minify: true,
    target: "es2020",
    // The inline script is not a module and has no source map of its own.
    sourcemap: false,
  });
  return code;
}
