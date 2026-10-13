import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "./config/configDir.js";

// The daemon's local sessionId -> conversationId map. It answers "which
// conversation is this session" without the server, which matters in a
// session's first seconds: the server-side session_id binding rides the
// daemon's retry queue, so a just-started or just-resumed session misses on
// the server while this file already has the answer.
export function readLocalConversationMap(): Record<string, string> {
  try {
    const cacheFile = path.join(defaultConfigDir(), "conversations.json");
    if (!fs.existsSync(cacheFile)) return {};
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** What the server said about one session the last time something asked
 *  (/cli/session-links): its conversation, and whether its team can read it. */
export interface CachedSessionLink {
  conversation_id: string;
  team_visible: boolean;
  checked_at: number;
}

// Kept beside conversations.json, by the session trailer hook, so a session's
// second commit costs no request. Entries a week old are dropped on write.
const SESSION_LINKS_FILE = "session-links.json";
const SESSION_LINK_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function readSessionLinkCache(configDir = defaultConfigDir()): Record<string, CachedSessionLink> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, SESSION_LINKS_FILE), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Records one session's link. Atomic (temp file + rename), so a hook running
 *  in another session never reads half a file; a failed write costs nothing. */
export function writeSessionLinkCache(sessionId: string, link: CachedSessionLink, configDir = defaultConfigDir()): void {
  try {
    const all = readSessionLinkCache(configDir);
    all[sessionId] = link;
    for (const [id, l] of Object.entries(all)) {
      if (!(l?.checked_at > link.checked_at - SESSION_LINK_KEEP_MS)) delete all[id];
    }
    const file = path.join(configDir, SESSION_LINKS_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // The next commit asks the server again.
  }
}
