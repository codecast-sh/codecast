// `cast read <session> --queued`: the messages waiting to go into a session,
// each with its whole text, then the ones most recently cancelled (a kill
// cancels the queue). The server answer is /cli/sessions/queue
// (pendingMessages.cliQueue).

export interface QueueRow {
  message_id: string;
  created_at: number;
  status: string;
  content: string;
  hold_reason: string | null;
  retry_count: number;
  from_name: string | null;
}

export interface SessionQueue {
  short_id: string;
  title: string | null;
  queued: QueueRow[];
  cancelled: QueueRow[];
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function row(r: QueueRow, n: number, now: number): string {
  const head = [`${n}. ${r.status}`, ago(r.created_at, now), r.from_name ? `from ${r.from_name}` : null, r.hold_reason ? `held: ${r.hold_reason}` : null]
    .filter(Boolean).join(" · ");
  const body = r.content.split("\n").map((line) => `   ${line}`).join("\n");
  return `${head}\n${body}`;
}

export function formatSessionQueue(q: SessionQueue, now = Date.now()): string {
  const out: string[] = [];
  out.push(q.queued.length
    ? `${q.queued.length} message${q.queued.length === 1 ? "" : "s"} queued for ${q.short_id}${q.title ? ` (${q.title})` : ""}, in delivery order:`
    : `Nothing queued for ${q.short_id}${q.title ? ` (${q.title})` : ""}.`);
  q.queued.forEach((r, i) => out.push("", row(r, i + 1, now)));
  if (q.cancelled.length) {
    out.push("", `Cancelled, newest first (resend with cast send ${q.short_id} "<text>"):`);
    q.cancelled.forEach((r, i) => out.push("", row(r, i + 1, now)));
  }
  return out.join("\n");
}

/** `cast read <session> --queued`, loaded only when asked for (index.ts stays off this module). */
export async function printSessionQueue(post: (path: string, body: Record<string, unknown>) => Promise<any>, session: string | undefined, json?: boolean): Promise<void> {
  if (!session) throw new Error("--queued needs a session id: cast read <session> --queued");
  const queue = await post("/cli/sessions/queue", { session });
  console.log(json ? JSON.stringify(queue, null, 2) : formatSessionQueue(queue));
}
