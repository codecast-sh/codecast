// Which delivery each echoed user turn is. Every message codecast puts in
// front of an agent is a pending_messages row, and the row's id is the
// delivery id end to end: the daemon records the delivery here at the moment
// it hands the message over (the Enter into a pane, a launch prompt, a
// turn/start, a cloud send), and when the agent's own record of that turn
// comes through the transcript, syncService.addMessages stamps the id on it
// before upload. The server then settles the row by id in the same write that
// stores the turn (messages.ts stampedEchoRows and settleEchoesOn) and never compares text.
//
// A backend that lets us choose the record's id (Claude cloud events, the
// Codex app-server turn the daemon writes itself) passes it as `exactUuid`, and the turn carrying that uuid is the
// delivery: a fact the harness reports. A terminal pane cannot carry an id,
// so a pane delivery is paired with a later user turn of the same conversation
// whose words are the typed payload's words: for a terminal the pairing is the
// daemon's, made once, next to the bytes it typed, and every other party works
// on the id. It compares letters and digits alone, so what a terminal does to
// whitespace, control bytes, a paste wrapper or a dropped `;` cannot break it. The pairing is
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
/** How much of a message's words are compared: all of any real message, bounded for a pasted file. */
const SIGNATURE_CAP = 4000;
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
  // A `!cmd` send is recorded as the command alone, inside <bash-input>.
  t = t.replace(/<\/?bash-input>/g, "").replace(/^\s*!/, "");
  t = t.replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/\[image\]/gi, "");
  t = t.normalize("NFKC").toLowerCase();
  const words = t.replace(/[^\p{L}\p{N}]+/gu, "");
  // A send with no letters or digits ("👍", "?") is its visible characters.
  return words || t.replace(/[\s\p{C}]+/gu, "");
}

export type EchoCandidate = {
  messageUuid?: string;
  role: string;
  content: string;
  timestamp: number;
  toolResults?: readonly unknown[];
  deliveryIds?: string[];
};

/** Parsed transcript turns in the form the ledger pairs. */
export function echoCandidatesOf(turns: ReadonlyArray<{ uuid?: string; role: string; content: string; timestamp: number; toolResults?: readonly unknown[] }>): EchoCandidate[] {
  return turns.map((m) => ({ messageUuid: m.uuid, role: m.role, content: m.content, timestamp: m.timestamp, toolResults: m.toolResults }));
}

type DeliveryRow = {
  messageId: string;
  conversationId: string;
  submittedAt: number;
  /** The latest hand-over of the same message (a retry): the wait for its echo runs from here. */
  lastSubmittedAt: number | null;
  signature: string;
  exactUuid: string | null;
  echoKey: string | null;
};

const isUserRole = (role: string) => role === "user" || role === "human";

// A turn's identity across uploads: its record id. A turn with none (Cursor's
// .txt, stamped with the parse time) is keyed by its words, its timestamp and
// which of the batch's identical turns it is: a retried upload of the same
// parse stamps the same way, and two identical turns stay two.
function echoKeyOf(message: EchoCandidate, occurrence: number): string {
  return message.messageUuid
    ?? `unkeyed:${createHash("sha256").update(message.content ?? "").digest("hex").slice(0, 24)}:${message.timestamp}:${occurrence}`;
}

/**
 * The open deliveries one turn delivered. A turn echoes one send when its
 * words are that send's words; when several sends hold the same words the
 * newest is it, since an older one still open was lost (one that reached the
 * agent would have echoed before it), unless later turns in the same upload
 * carry the same words, which take the newer ones. A turn that is several sends the agent
 * took together is their words joined, in the order they were handed over.
 */
function pairTurn(open: DeliveryRow[], message: EchoCandidate, laterSameWords = 0): DeliveryRow[] {
  const exact = message.messageUuid ? open.find((d) => d.exactUuid === message.messageUuid) : undefined;
  if (exact) return [exact];
  const echo = echoSignature(message.content).slice(0, SIGNATURE_CAP);
  const candidates = open.filter((d) => !d.exactUuid
    && d.submittedAt - ECHO_CLOCK_SKEW_MS <= message.timestamp
    && message.timestamp - (d.lastSubmittedAt ?? d.submittedAt) <= ECHO_WAIT_MS);
  // Turns later in the same upload with these words take the newer sends, so
  // a batch of identical turns pairs oldest with oldest.
  // An image-only send echoes as image tokens and nothing else.
  const imageOnlyTurn = !echo && /\[Image[:\s#]/i.test(message.content ?? "");
  const same = candidates.filter((d) => d.signature === echo && (echo || imageOnlyTurn));
  const single = same[Math.max(0, same.length - 1 - laterSameWords)];
  if (single) return [single];
  for (let i = 0; i < candidates.length; i++) {
    let joined = "";
    const run: DeliveryRow[] = [];
    for (let j = i; j < candidates.length && candidates[j].signature; j++) {
      const next = (joined + candidates[j].signature).slice(0, SIGNATURE_CAP);
      if (!echo.startsWith(next)) break;
      joined = next;
      run.push(candidates[j]);
      if (joined === echo && run.length > 1) return run;
    }
  }
  return [];
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
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(deliveries)").all().map((c) => c.name);
    if (!columns.includes("lastSubmittedAt")) this.db.exec("ALTER TABLE deliveries ADD COLUMN lastSubmittedAt INTEGER");
    this.prune();
  }

  /**
   * Record that a delivery was handed to the agent. A second hand-over of the
   * same message (a re-typed paste, a retried send) keeps the first record: it
   * is one delivery, and whichever echo arrives first is it: its echo may come
   * from any write since the first. The wait for that echo runs from the latest
   * hand-over, so a person's retry the next morning can still confirm.
   */
  expect(delivery: { messageId: string; conversationId: string; payload: string; submittedAt?: number; exactUuid?: string }): void {
    this.db.query(`INSERT INTO deliveries (messageId, conversationId, submittedAt, signature, exactUuid) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(messageId) DO UPDATE SET
        exactUuid = COALESCE(deliveries.exactUuid, excluded.exactUuid),
        lastSubmittedAt = MAX(COALESCE(deliveries.lastSubmittedAt, deliveries.submittedAt), excluded.submittedAt)`)
      .run(delivery.messageId, delivery.conversationId, delivery.submittedAt ?? Date.now(),
        echoSignature(delivery.payload).slice(0, SIGNATURE_CAP), delivery.exactUuid ?? null);
    if (++this.writes % 200 === 0) this.prune();
  }

  /**
   * Whether a transcript with no record ids (Cursor's .txt, every turn stamped
   * with the parse time) holds a turn with this delivery's words. It cannot say
   * which turn, so it pairs nothing: the upload of the new turn does that.
   */
  static unkeyedTranscriptHolds(turns: readonly EchoCandidate[], payload: string): boolean {
    const words = echoSignature(payload).slice(0, SIGNATURE_CAP);
    return turns.some((m) => isUserRole(m.role) && !m.toolResults?.length && echoSignature(m.content).slice(0, SIGNATURE_CAP) === words);
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
      const userSigs = messages.map((m) => (isUserRole(m.role) ? echoSignature(m.content).slice(0, SIGNATURE_CAP) : null));
      const seen = new Map<string, number>();
      return messages.map((message, index) => {
        if (!isUserRole(message.role)) return message;
        const base = `${message.content}\0${message.timestamp}`;
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        const key = echoKeyOf(message, occurrence);
        const bound = this.db.query<{ messageId: string }, [string, string]>(
          "SELECT messageId FROM deliveries WHERE conversationId = ? AND echoKey = ? ORDER BY submittedAt").all(conversationId, key);
        if (bound.length) return { ...message, deliveryIds: bound.map((b) => b.messageId) };
        // A tool's result rides a user-role record and is nobody's send.
        if (isHarnessEmittedUserTurn(message.content) || message.toolResults?.length) return message;
        open ??= this.db.query<DeliveryRow, [string]>(
          "SELECT * FROM deliveries WHERE conversationId = ? AND echoKey IS NULL ORDER BY submittedAt").all(conversationId);
        const laterSameWords = userSigs.slice(index + 1).filter((sig) => sig === userSigs[index]).length;
        const paired = pairTurn(open, message, laterSameWords);
        if (!paired.length) return message;
        const now = Date.now();
        for (const d of paired) this.db.query("UPDATE deliveries SET echoKey = ?, echoedAt = ? WHERE messageId = ?").run(key, now, d.messageId);
        open = open.filter((d) => !paired.includes(d));
        return { ...message, deliveryIds: paired.map((d) => d.messageId) };
      });
    }).immediate();
  }

  prune(now = Date.now()): void {
    this.db.query("DELETE FROM deliveries WHERE COALESCE(lastSubmittedAt, submittedAt) < ?").run(now - RETENTION_MS);
  }

  close(): void { this.db.close(); }
}

let ledger: DeliveryEchoLedger | undefined;
export function deliveryEchoLedger(): DeliveryEchoLedger {
  return ledger ??= new DeliveryEchoLedger(join(defaultConfigDir(), "delivery-echoes.sqlite"));
}

/** A record id derived from the delivery id, for a backend that takes one (Claude cloud events). */
export function deliveryRecordUuid(messageId: string, namespace = "codecast-cloud"): string {
  const h = createHash("sha256").update(`${namespace}:${messageId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
