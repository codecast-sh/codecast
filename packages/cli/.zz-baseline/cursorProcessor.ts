import { Database } from "bun:sqlite";
import { type ParsedMessage } from "./parser.js";

import { parseCursorChatData } from "./cursorChatParser.js";

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
