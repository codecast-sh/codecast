/**
 * How to invoke this CLI's own entrypoint as a child process.
 *
 * Three ways the running process can have been started, and each needs a
 * different argv:
 *   - from source  (`bun .../daemon.ts`, `bun .../main.ts`) -> bun + main.<ext>
 *   - compiled bin (`cast _daemon`, `cast computer …`)      -> the cast binary
 *   - off PATH     (anything else)                          -> `cast`
 *
 * Returned as argv parts so callers spawn without shell-quoting hazards; the
 * disclaim prefix joins them itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The entry that sits beside THIS module, which is where it actually is:
 * `src/castInvocation.ts` -> `src/main.ts`, and in a bundled build
 * `dist/daemon.js` -> `dist/main.js`.
 *
 * Why not `dirname(process.argv[1])`, which is what this used to be: argv[1]
 * is only the CLI entry when the CLI entry is what was run. Under `bun test`
 * it is the test file and under `bun scripts/x.ts` it is the script, so the
 * child was handed `<test dir>/main.ts` — a path that never exists. The spawn
 * was detached with its stdio ignored, so the ENOENT was invisible and the
 * only symptom was a helper that never answered (ct-49674).
 */
function entryBesideThisModule(ext: string): string | null {
  const candidate = path.join(import.meta.dir, `main${ext}`);
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveCastInvocation(): { cmd: string; prefixArgs: string[] } {
  const argv1 = process.argv[1] || "";
  if (argv1.endsWith(".ts") || argv1.endsWith(".js")) {
    const ext = argv1.endsWith(".ts") ? ".ts" : ".js";
    // The argv-derived path stays as the fallback: it is right whenever argv[1]
    // IS the entry, and a wrong guess now fails loudly at the spawn rather than
    // silently.
    const entry = entryBesideThisModule(ext) ?? path.join(path.dirname(argv1), `main${ext}`);
    return { cmd: process.argv[0], prefixArgs: [entry] };
  }
  if (!argv1.includes("/")) return { cmd: process.execPath, prefixArgs: [] };
  return { cmd: "cast", prefixArgs: [] };
}
