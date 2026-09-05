export interface CodexImportItem {
  type: string;
  role?: string;
  [key: string]: unknown;
}

export const CODEX_IMPORT_MAX_ITEMS = 4_096;
export const CODEX_IMPORT_MAX_BYTES = 240_000;

const size = (item: CodexImportItem) => Buffer.byteLength(JSON.stringify(item)) + 1;

function message(role: string, text: string): CodexImportItem {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] };
}

function asContext(item: CodexImportItem): CodexImportItem {
  if (item.type === "message") return item;
  return message("assistant", `[Historical ${item.type}]\n${JSON.stringify(item)}`);
}

function fit(item: CodexImportItem, budget: number): CodexImportItem {
  const context = asContext(item);
  if (size(context) <= budget) return context;
  const text = JSON.stringify(context);
  const notice = "\n[Truncated for model context; read the full original in the conversation transcript.]\n";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const clipped = message(context.role || "assistant", text.slice(0, Math.ceil(mid / 2)) + notice + text.slice(-Math.floor(mid / 2) || text.length));
    if (size(clipped) <= budget) low = mid;
    else high = mid - 1;
  }
  return message(context.role || "assistant", text.slice(0, Math.ceil(low / 2)) + notice + text.slice(-Math.floor(low / 2) || text.length));
}

export function buildCodexImportContext(items: CodexImportItem[], conversationId: string): CodexImportItem[] | undefined {
  if (items.length <= CODEX_IMPORT_MAX_ITEMS && items.reduce((sum, item) => sum + size(item), 0) <= CODEX_IMPORT_MAX_BYTES) return;

  const notice = message("developer", `[Codecast import] The full conversation is preserved in the transcript. ` +
    "Only a bounded selection is in model context: the original request, earlier user messages that fit, and recent activity. " +
    "Historical tool activity is quoted as text and is not a pending tool call. Some large entries may be shortened. " +
    `Read omitted history before relying on past decisions: cast read ${conversationId} <from>:<to>.`);
  const selected = new Map<number, CodexImportItem>();
  let remaining = CODEX_IMPORT_MAX_BYTES - 1 - size(notice);
  const add = (index: number, budget: number) => {
    const item = fit(items[index], budget);
    selected.set(index, item);
    const bytes = size(item);
    remaining -= bytes;
    return bytes;
  };

  for (let i = 0; i < Math.min(3, items.length); i++) add(i, Math.min(8_000, remaining));
  const firstUser = items.findIndex((item, index) => index >= 3 && item.type === "message" && item.role === "user");
  if (firstUser >= 0) add(firstUser, 24_000);
  for (let i = items.length - 1; i > firstUser && i >= 3; i--) {
    if (items[i].type !== "message" || items[i].role !== "user") continue;
    add(i, 24_000);
    break;
  }

  let tailBudget = Math.floor(remaining * 0.75);
  let tailStart = items.length;
  for (let i = items.length - 1; i >= 3 && selected.size < CODEX_IMPORT_MAX_ITEMS - 513; i--) {
    if (selected.has(i)) continue;
    const bytes = size(asContext(items[i]));
    if (bytes > tailBudget && tailStart < items.length) break;
    tailBudget -= add(i, tailBudget);
    tailStart = i;
  }

  for (let i = tailStart - 1; i >= 3 && selected.size < CODEX_IMPORT_MAX_ITEMS - 1; i--) {
    if (selected.has(i) || items[i].type !== "message" || items[i].role !== "user") continue;
    const bytes = size(items[i]);
    if (bytes > remaining) continue;
    add(i, remaining);
  }

  return [notice, ...[...selected.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)];
}
