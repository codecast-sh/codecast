// A headless run declares its spawner here, keyed by the child's session id:
// `cast exec` names the calling session before it starts the child, and the
// session-register hook names the conversation whose CODECAST_CONVERSATION_ID
// the run inherited (a script a session's Bash ran, detached or not). The
// daemon trusts a `cast exec` declaration over the process walk and uses an
// inherited conversation when the walk finds nothing, so the child nests under
// its caller even when its process is gone or reparented by the time the
// daemon looks.

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

export type DeclaredSpawnParent = { sessionId: string } | { conversationId: string };

export function declaredSpawnParent(configDir: string, childSessionId: string): DeclaredSpawnParent | null {
  if (!SAFE_ID.test(childSessionId)) return null;
  try {
    const decl = JSON.parse(fs.readFileSync(path.join(dirOf(configDir), `${childSessionId}.json`), "utf8"));
    if (typeof decl?.parent_session_id === "string" && decl.parent_session_id) return { sessionId: decl.parent_session_id };
    if (typeof decl?.parent_conversation_id === "string" && decl.parent_conversation_id) return { conversationId: decl.parent_conversation_id };
    return null;
  } catch {
    return null;
  }
}
