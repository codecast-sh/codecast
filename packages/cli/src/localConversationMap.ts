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
