// Which delivery each echoed user turn is. Every message codecast puts in
// front of an agent is a pending_messages row, and the row's id is the
// delivery id end to end: the daemon records the delivery here at the moment
// it hands the message over (the Enter into a pane, a launch prompt, a
// turn/start, a cloud send), and when the agent's own record of that turn
// comes through the transcript, syncService.addMessages stamps the id on it
// before upload. The server then settles the row by id in the same write that
// stores the turn (messages.ts adoptStampedEchoes) and never compares text.
//
// A backend that lets us choose the record's id (Claude cloud events, the
// Agent SDK) passes it as `exactUuid`, and the turn carrying that uuid is the
// delivery: a fact the harness reports. A terminal pane cannot carry an id,
// so a pane delivery is paired with the first later user turn of the same
// conversation that opens with the typed payload's words. That check
// rejects only a turn someone typed at the terminal in between; it compares
// letters and digits alone, so what a terminal does to whitespace, control
// bytes, a paste wrapper or a dropped `;` cannot break it. The pairing is
// made once and kept, so every re-upload of the same turn carries the same id.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalSlashCommand, stripPastedContent } from "@codecast/shared/contracts";
import { defaultConfigDir } from "./config/configDir.js";
import { redactSecrets } from "./redact.js";

/** How far a turn's own timestamp may sit before the delivery's clock and still be its echo. */
export const ECHO_CLOCK_SKEW_MS = 5_000;
/** How long a delivery waits for its echo: a busy agent takes a queued send at its next step, and one older than this was lost, so it cannot take a later turn's words. */
export const ECHO_WAIT_MS = 6 * 60 * 60_000;
/** How much of the payload a turn must start with: enough to tell two sends apart, short enough to survive truncation. */
const SIGNATURE_PREFIX = 80;
/** Deliveries older than this are gone from every transcript a sync will read again. */
const RETENTION_MS = 7 * 24 * 60 * 60_000;

// A user-role turn the HARNESS emits on its own (the boot <task-notification>
// bundle about background tasks from the previous session) is never the echo
// of a delivery, and pairing one would put a delivery's id on it.
export function isHarnessEmittedUserTurn(content: string | undefined): boolean {
  return !!content && content.trimStart().startsWith("<task-notification>");
}

/** The words of a message as letters and digits, the form a delivery and its echo share whatever the terminal did. */
export function echoSignature(text: string | undefined): string {
  let t = stripPastedContent(redactSecrets(text ?? ""));
  t = canonicalSlashCommand(t.trim()) ?? t;
  t = t.replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/\[image\]/gi, "");
  return t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export type EchoCandidate = {
  messageUuid?: string;
  role: string;
  content: string;
  timestamp: number;
  toolResults?: readonly unknown[];
  deliveryIds?: string[];
};

type DeliveryRow = {
  messageId: string;
  conversationId: string;
  submittedAt: number;
  signature: string;
  exactUuid: string | null;
  echoKey: string | null;
};

const isUserRole = (role: string) => role === "user" || role === "human";

function echoKeyOf(message: EchoCandidate): string {
  if (message.messageUuid) return message.messageUuid;
  return `ts:${message.timestamp}:${createHash("sha256").update(message.content ?? "").digest("hex").slice(0, 16)}`;
}

/** The open deliveries one turn delivered, oldest first: a turn can carry several sends the agent took together. */
function pairTurn(open: DeliveryRow[], message: EchoCandidate): DeliveryRow[] {
  const exact = message.messageUuid ? open.find((d) => d.exactUuid === message.messageUuid) : undefined;
  if (exact) return [exact];
  const echo = echoSignature(message.content);
  const paired: DeliveryRow[] = [];
  let from = 0;
  for (const d of open) {
    if (d.exactUuid || d.submittedAt - ECHO_CLOCK_SKEW_MS > message.timestamp || message.timestamp - d.submittedAt > ECHO_WAIT_MS) continue;
    if (!d.signature) {
      // An image-only send echoes as image tokens alone.
      if (!echo && paired.length === 0) { paired.push(d); break; }
      continue;
    }
    // The turn opens with the first send it carries; any it took together
    // with that one follow in order.
    const at = echo.indexOf(d.signature, from);
    if (paired.length === 0 ? at !== 0 : at < 0) {
      if (paired.length) break;
      continue;
    }
    paired.push(d);
    from = at + d.signature.length;
  }
  return paired;
}

export class DeliveryEchoLedger {
  private readonly db: Database;
  private writes = 0;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        messageId TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
        submittedAt INTEGER NOT NULL, signature TEXT NOT NULL,
        exactUuid TEXT, echoKey TEXT, echoedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS deliveries_open ON deliveries(conversationId, submittedAt) WHERE echoKey IS NULL;
      CREATE INDEX IF NOT EXISTS deliveries_echo ON deliveries(conversationId, echoKey);`);
    this.prune();
  }

  /**
   * Record that a delivery was handed to the agent. A second hand-over of the
   * same message (a re-typed paste, a retried send) keeps the first record: it
   * is one delivery, and whichever echo arrives first is it.
   */
  expect(delivery: { messageId: string; conversationId: string; payload: string; submittedAt?: number; exactUuid?: string }): void {
    this.db.query(`INSERT INTO deliveries (messageId, conversationId, submittedAt, signature, exactUuid) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(messageId) DO UPDATE SET exactUuid = COALESCE(deliveries.exactUuid, excluded.exactUuid)`)
      .run(delivery.messageId, delivery.conversationId, delivery.submittedAt ?? Date.now(),
        echoSignature(delivery.payload).slice(0, SIGNATURE_PREFIX), delivery.exactUuid ?? null);
    if (++this.writes % 200 === 0) this.prune();
  }

  /** Whether the agent's record of this delivery has been seen. */
  echoed(messageId: string): boolean {
    return !!this.db.query("SELECT 1 FROM deliveries WHERE messageId = ? AND echoKey IS NOT NULL").get(messageId);
  }

  /** A delivery that provably never reached the agent: nothing will echo it. */
  forget(messageId: string): void {
    this.db.query("DELETE FROM deliveries WHERE messageId = ? AND echoKey IS NULL").run(messageId);
  }

  /**
   * The transcript turns with the deliveries they echo stamped on: a turn seen
   * before keeps its pairing, a new user turn pairs with the open deliveries it
   * echoes. Returns new objects only for turns that carry ids.
   */
  stamp<T extends EchoCandidate>(conversationId: string, messages: readonly T[]): Array<T & { deliveryIds?: string[] }> {
    if (!messages.some((m) => isUserRole(m.role))) return [...messages];
    return this.db.transaction(() => {
      let open: DeliveryRow[] | null = null;
      return messages.map((message) => {
        if (!isUserRole(message.role)) return message;
        const key = echoKeyOf(message);
        const bound = this.db.query<{ messageId: string }, [string, string]>(
          "SELECT messageId FROM deliveries WHERE conversationId = ? AND echoKey = ? ORDER BY submittedAt").all(conversationId, key);
        if (bound.length) return { ...message, deliveryIds: bound.map((b) => b.messageId) };
        // A tool's result rides a user-role record and is nobody's send.
        if (isHarnessEmittedUserTurn(message.content) || message.toolResults?.length) return message;
        open ??= this.db.query<DeliveryRow, [string]>(
          "SELECT * FROM deliveries WHERE conversationId = ? AND echoKey IS NULL ORDER BY submittedAt").all(conversationId);
        const paired = pairTurn(open, message);
        if (!paired.length) return message;
        const now = Date.now();
        for (const d of paired) this.db.query("UPDATE deliveries SET echoKey = ?, echoedAt = ? WHERE messageId = ?").run(key, now, d.messageId);
        open = open.filter((d) => !paired.includes(d));
        return { ...message, deliveryIds: paired.map((d) => d.messageId) };
      });
    }).immediate();
  }

  prune(now = Date.now()): void {
    this.db.query("DELETE FROM deliveries WHERE submittedAt < ?").run(now - RETENTION_MS);
  }

  close(): void { this.db.close(); }
}

let ledger: DeliveryEchoLedger | undefined;
export function deliveryEchoLedger(): DeliveryEchoLedger {
  return ledger ??= new DeliveryEchoLedger(join(defaultConfigDir(), "delivery-echoes.sqlite"));
}

/** A record id derived from the delivery id, for backends that take one (Claude cloud events, the Agent SDK). */
export function deliveryRecordUuid(messageId: string, namespace = "codecast-cloud"): string {
  const h = createHash("sha256").update(`${namespace}:${messageId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
