import { Database } from "bun:sqlite";
import { parseCursorPrompts, type ParsedMessage } from "./parser.js";

export function extractMessagesFromCursorDb(
  dbPath: string,
  lastRowId: number = 0
): { messages: ParsedMessage[]; maxRowId: number } {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const rows = db
      .query<{ rowid: number; value: string }, [number]>(
        "SELECT rowid, value FROM ItemTable WHERE key = 'aiService.prompts' AND rowid > ? ORDER BY rowid ASC"
      )
      .all(lastRowId);

    let messages: ParsedMessage[] = [];
    let maxRowId = lastRowId;

    for (const row of rows) {
      const parsedMessages = parseCursorPrompts(row.value);
      messages = messages.concat(parsedMessages);
      if (row.rowid > maxRowId) {
        maxRowId = row.rowid;
      }
    }

    return { messages, maxRowId };
  } finally {
    if (db) {
      db.close();
    }
  }
}
