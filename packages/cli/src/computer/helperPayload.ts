import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import helperTar from "./helper.tar" with { type: "file" };

/**
 * The `codecast computer.app` bundle, embedded in the CLI as a tar.
 *
 * `packages/cli/scripts/build-with-native.ts` writes the signed bundle into
 * `helper.tar` for the length of a build, so bun embeds it here the same way
 * `browser/appIdentity.ts` embeds its icon. On a build without swift, and on
 * every non macOS target, the file is empty and this returns null: the CLI still
 * works and reports the feature unavailable.
 */
export function computerHelperTar(): Buffer | null {
  const asset = path.isAbsolute(helperTar) ? helperTar : fileURLToPath(new URL(helperTar, import.meta.url));
  const bytes = fs.existsSync(asset) ? fs.readFileSync(asset) : Buffer.alloc(0);
  return bytes.length > 0 ? bytes : null;
}
