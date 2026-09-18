import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = /[/\\](?:dist|build)[/\\]/.test(fileURLToPath(import.meta.url)) ? ".js" : ".ts";

/**
 * How to run this same codecast build again with `argv`: the compiled binary
 * takes its verbs after `--`; a source or bundled run needs the right entry
 * script. `_daemon` is the daemon module and `_watchdog` has always been served
 * by the CLI module; anything else is a plain verb, so it runs the process
 * entry, which claims the cheap fast-path verbs before the CLI graph loads.
 */
export function selfExecInfo(...argv: string[]): { executablePath: string; args: string[] } {
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");
  if (isBinary) return { executablePath: execPath, args: ["--", ...argv] };
  const command = argv[0];
  let file = command === "_daemon" ? "daemon" : command === "_watchdog" ? "index" : "main";
  if (file === "main" && !fs.existsSync(path.resolve(here, file + ext))) file = "index";
  return { executablePath: execPath, args: [path.resolve(here, file + ext), ...argv] };
}
