// A headless run started by a command that knows its caller (`cast exec`)
// declares itself here before it starts: the child's session id and the
// session that ran the command. The daemon reads the declaration before it
// guesses from process ancestry, so the child nests under its caller even
// when its process is gone or invisible by the time the daemon looks.

import * as fs from "node:fs";
import * as path from "node:path";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function dirOf(configDir: string): string {
  return path.join(configDir, "spawn-parents");
}

export function declareSpawnParent(configDir: string, childSessionId: string, parentSessionId: string, now = Date.now()): void {
  if (!SAFE_ID.test(childSessionId)) return;
  const dir = dirOf(configDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.unlinkSync(file);
      } catch {}
    }
    fs.writeFileSync(path.join(dir, `${childSessionId}.json`), JSON.stringify({ parent_session_id: parentSessionId, ts: now }));
  } catch {
    // The daemon still has the process walk; a failed declaration only loses the shortcut.
  }
}

export function declaredSpawnParent(configDir: string, childSessionId: string): string | null {
  if (!SAFE_ID.test(childSessionId)) return null;
  try {
    const parent = JSON.parse(fs.readFileSync(path.join(dirOf(configDir), `${childSessionId}.json`), "utf8"))?.parent_session_id;
    return typeof parent === "string" && parent ? parent : null;
  } catch {
    return null;
  }
}
