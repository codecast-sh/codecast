// The audit trail of server writes this window sent, the write-side twin of
// __navLog (store/viewNav.ts). Every dispatch passes through one binding
// (lib/dispatchBinding.ts), which records the action, the rows it names, what
// set it off and how it ended. A session that was killed with no click on
// record (jx7970z, 2026-10-06) took a prod dump and analytics forensics to
// trace to a keyboard chord; `__writeLog()` in the acting window answers that
// in one read.
//
// `source` is read from the DOM event being handled when the write is sent:
// the first send runs synchronously inside the action call, so a key or click
// is still `window.event`. No event means the write came from an effect, a
// timer, a sync handler or an outbox replay, and those entries keep a short
// stack so the writer can be named.

import { windowFlavor } from "./viewNav";

export type WriteEvent = {
  ts: number;
  action: string;
  /** Row ids the write names: the first string arg, then `table:id` per patched row. */
  ids: string[];
  source: "key" | "click" | "auto";
  /** The key and modifiers when a keydown sent it, e.g. "ctrl+shift+Backspace". */
  key?: string;
  /** Set when the write settles: true on success, the error text on failure. */
  ok?: true;
  err?: string;
  win: string;
  stack?: string;
};

const LOG_KEY = "codecast.writeLog";
const LOG_CAP = 300;
const MAX_IDS = 10;

let writeLog: WriteEvent[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadLog(): WriteEvent[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LOG_KEY) : null;
    return raw ? (JSON.parse(raw) as WriteEvent[]) : [];
  } catch {
    return [];
  }
}

// Writes arrive in bursts (a bulk kill, an outbox drain), so the ring is
// persisted once per burst rather than once per write.
function schedulePersist(): void {
  if (persistTimer || typeof localStorage === "undefined") return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(writeLog));
    } catch {
      // Quota/private mode: keep the in-memory log.
    }
  }, 500);
}

function idsOf(args: unknown, patches: unknown): string[] {
  const ids: string[] = [];
  const first = Array.isArray(args) ? args[0] : undefined;
  if (typeof first === "string") ids.push(first);
  else if (Array.isArray(first)) for (const id of first) if (typeof id === "string") ids.push(id);
  if (patches && typeof patches === "object") {
    for (const [table, rows] of Object.entries(patches as Record<string, unknown>)) {
      if (rows && typeof rows === "object") for (const id of Object.keys(rows)) ids.push(`${table}:${id}`);
    }
  }
  return ids.slice(0, MAX_IDS);
}

function currentSource(): Pick<WriteEvent, "source" | "key"> {
  const ev = typeof window !== "undefined" ? (window as any).event : undefined;
  if (ev && ev.type === "keydown") {
    const mods = [ev.ctrlKey && "ctrl", ev.metaKey && "meta", ev.altKey && "alt", ev.shiftKey && "shift"].filter(Boolean);
    return { source: "key", key: [...mods, ev.key].join("+") };
  }
  if (ev && /^(click|pointer|mouse|touch|submit|change|input)/.test(ev.type)) return { source: "click" };
  return { source: "auto" };
}

/** Record one write as it leaves; the returned function settles it. */
export function recordWrite(action: string, args: unknown, patches: unknown): (outcome: { ok: true } | { err: unknown }) => void {
  if (writeLog === null) writeLog = loadLog();
  const src = currentSource();
  const event: WriteEvent = {
    ts: Date.now(),
    action,
    ids: idsOf(args, patches),
    ...src,
    win: windowFlavor(),
    stack: src.source === "auto" ? new Error().stack?.split("\n").slice(3, 9).join("\n") : undefined,
  };
  writeLog.push(event);
  if (writeLog.length > LOG_CAP) writeLog.splice(0, writeLog.length - LOG_CAP);
  schedulePersist();
  return (outcome) => {
    if ("ok" in outcome) event.ok = true;
    else event.err = String((outcome.err as Error)?.message ?? outcome.err).slice(0, 200);
    schedulePersist();
  };
}

export function getWriteLog(): WriteEvent[] {
  if (writeLog === null) writeLog = loadLog();
  return writeLog;
}

// Always exposed (prod desktop is where this gets debugged).
if (typeof window !== "undefined") {
  (window as any).__writeLog = getWriteLog;
}

/** Test-only: clear the in-memory log. */
export function _resetWriteLogForTests(): void {
  writeLog = [];
}
