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

import * as path from "node:path";

export function resolveCastInvocation(): { cmd: string; prefixArgs: string[] } {
  const argv1 = process.argv[1] || "";
  if (argv1.endsWith(".ts") || argv1.endsWith(".js")) {
    const ext = argv1.endsWith(".ts") ? ".ts" : ".js";
    return { cmd: process.argv[0], prefixArgs: [path.join(path.dirname(argv1), `main${ext}`)] };
  }
  if (!argv1.includes("/")) return { cmd: process.execPath, prefixArgs: [] };
  return { cmd: "cast", prefixArgs: [] };
}
