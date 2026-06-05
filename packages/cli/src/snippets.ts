// Shared snippet definitions + install helpers.
//
// This lives in its own module (not index.ts) so the daemon can import it:
// index.ts runs `program.parse()` on import, so daemon.ts cannot import from it.
// The messaging snippet in particular has to be installable from the daemon's
// own startup, so memory-enabled daemons distribute it onto their machine's
// CLAUDE.md autonomously after a self-update — without a `cast` command running.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getMessagingVersion } from "./update.js";

export interface SnippetTarget {
  filePath: string;
  dirPath: string;
  label: string;
}

export function getSnippetTargets(): SnippetTarget[] {
  const home = os.homedir();
  const targets: SnippetTarget[] = [
    { filePath: path.join(home, ".claude", "CLAUDE.md"), dirPath: path.join(home, ".claude"), label: "~/.claude/CLAUDE.md" },
  ];

  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir)) {
    targets.push({ filePath: path.join(codexDir, "AGENTS.md"), dirPath: codexDir, label: "~/.codex/AGENTS.md" });
  }

  const cursorDir = path.join(home, ".cursor");
  if (fs.existsSync(cursorDir)) {
    const rulesDir = path.join(cursorDir, "rules");
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }
    targets.push({ filePath: path.join(rulesDir, "codecast.mdc"), dirPath: rulesDir, label: "~/.cursor/rules/codecast.mdc" });
  }

  return targets;
}

export const MESSAGING_SNIPPET_END = "<!-- /codecast-messaging -->";
export const MESSAGING_SNIPPET = `
## Messaging

\`cast send <session_id> "<text>"\` reaches any session — old or active — by its short ID. Each is a teammate: be the boss (hand a dormant one a task; it resumes with full context and runs it) or a peer (trade updates on a shared problem). Ask one to ping you when it's done or blocked, then act on the reply yourself.

It lands as a new turn attributed to you; inbound arrives wrapped as \`<session-message from="jx7c6zk">…</session-message>\` — reply to its ID.

\`\`\`bash
cast send <session_id> "<text>"            # Message a teammate session
\`\`\`
${MESSAGING_SNIPPET_END}
`;

function installMessagingSnippetToFile(filePath: string, dirPath: string, update: boolean): { installed: boolean; updated: boolean } {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const hasMessaging = existing.includes("## Messaging") && existing.includes(MESSAGING_SNIPPET_END);
  if (hasMessaging && !update) {
    return { installed: false, updated: false };
  }

  if (hasMessaging && update) {
    const msgStart = existing.indexOf("## Messaging");
    let msgEnd = existing.length;

    const endMarkerIdx = existing.indexOf(MESSAGING_SNIPPET_END, msgStart);
    if (endMarkerIdx !== -1) {
      msgEnd = endMarkerIdx + MESSAGING_SNIPPET_END.length;
      if (existing[msgEnd] === "\n") msgEnd++;
    }

    const before = existing.slice(0, msgStart);
    const after = existing.slice(msgEnd);
    existing = before + after;
    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + MESSAGING_SNIPPET, { mode: 0o600 });
    return { installed: true, updated: true };
  }

  fs.writeFileSync(filePath, existing + MESSAGING_SNIPPET, { mode: 0o600 });
  return { installed: true, updated: false };
}

export function installMessagingSnippet(update = false): { installed: boolean; updated: boolean } {
  const targets = getSnippetTargets();
  let anyInstalled = false;
  let anyUpdated = false;

  for (const target of targets) {
    const result = installMessagingSnippetToFile(target.filePath, target.dirPath, update);
    if (result.installed) anyInstalled = true;
    if (result.updated) anyUpdated = true;
  }

  return { installed: anyInstalled, updated: anyUpdated };
}

// Messaging is on by default for anyone who has memory. Backfill/refresh it for
// memory installs (respecting an explicit opt-out), install the snippet onto
// disk, and return the config delta to persist — or null if nothing changed.
// Callers persist with their own config writer (index.ts and daemon.ts each
// have one). Idempotent: returns null once the installed version is current.
export function ensureMessagingForMemory(
  config: { memory_enabled?: boolean; messaging_enabled?: boolean; messaging_version?: string } | null | undefined
): { messaging_enabled: true; messaging_version: string } | null {
  if (!config?.memory_enabled) return null;        // only memory installs
  if (config.messaging_enabled === false) return null; // respect explicit opt-out

  const target = getMessagingVersion();
  if (config.messaging_enabled === true && config.messaging_version === target) {
    return null; // already enabled and current
  }

  installMessagingSnippet(true);
  return { messaging_enabled: true, messaging_version: target };
}
