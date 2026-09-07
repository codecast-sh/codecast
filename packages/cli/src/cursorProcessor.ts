import { Database } from "bun:sqlite";
import { type ParsedMessage } from "./parser.js";

interface CursorBubble {
  type: "user" | "ai";
  id: string;
  rawText?: string;
  initText?: string;
  messageType?: number;
  modelType?: string;
  contextCacheTimestamp?: number;
}

interface CursorTab {
  tabId: string;
  chatTitle?: string;
  bubbles: CursorBubble[];
  lastSendTime?: number;
}

interface CursorChatData {
  tabs: CursorTab[];
}

function extractTextFromInitText(initText: string): string {
  // First, check if it's plain text (not JSON)
  if (!initText.startsWith("{")) {
    return initText.trim();
  }

  // Try parsing as Lexical editor JSON format
  try {
    const data = JSON.parse(initText);
    const texts: string[] = [];

    function walk(node: unknown): void {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;

      if (n.type === "mention" && typeof n.mentionName === "string") {
        texts.push(`@${n.mentionName}`);
      } else if (n.type === "text" && typeof n.text === "string") {
        texts.push(n.text);
      }

      if (Array.isArray(n.children)) {
        for (const child of n.children) {
          walk(child);
        }
      }
    }

    walk(data.root);
    return texts.join("").trim();
  } catch {
    // If JSON parsing fails, treat as plain text
    return initText.trim();
  }
}

function parseCursorChatData(jsonStr: string): ParsedMessage[] {
  try {
    const data: CursorChatData = JSON.parse(jsonStr);
    const messages: ParsedMessage[] = [];

    if (!data.tabs || !Array.isArray(data.tabs)) {
      return messages;
    }

    for (const tab of data.tabs) {
      if (!tab.bubbles || !Array.isArray(tab.bubbles)) continue;

      for (const bubble of tab.bubbles) {
        let content = "";
        let role: "user" | "assistant";
        let timestamp = Date.now();

        if (bubble.type === "user") {
          role = "user";
          if (bubble.initText) {
            content = extractTextFromInitText(bubble.initText);
          }
          if (bubble.contextCacheTimestamp) {
            timestamp = bubble.contextCacheTimestamp;
          }
        } else if (bubble.type === "ai") {
          role = "assistant";
          content = bubble.rawText || "";
        } else {
          continue;
        }

        if (content.trim()) {
          messages.push({
            uuid: bubble.id,
            role,
            content,
            timestamp,
          });
        }
      }
    }

    return messages;
  } catch {
    return [];
  }
}

export function extractMessagesFromCursorDb(
  dbPath: string,
  skipCount: number = 0
): { messages: ParsedMessage[]; maxRowId: number; totalCount: number } {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const row = db
      .query<{ rowid: number; value: string }, []>(
        "SELECT rowid, value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata' ORDER BY rowid DESC LIMIT 1"
      )
      .get();

    if (!row) {
      return { messages: [], maxRowId: 0, totalCount: 0 };
    }

    const allMessages = parseCursorChatData(row.value);
    const newMessages = allMessages.slice(skipCount);
    return { messages: newMessages, maxRowId: row.rowid, totalCount: allMessages.length };
  } finally {
    if (db) {
      db.close();
    }
  }
}
