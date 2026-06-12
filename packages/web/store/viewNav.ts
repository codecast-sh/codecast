// View-motion intent + audit trail.
//
// "Which conversation is the user looking at" (inboxStore.currentSessionId,
// and its async twin pendingNavigateId) may only change through a write that
// FIRST declares why — a ViewNavSource. mutativeMiddleware enforces this for
// every action()/sync() (via patches) and for raw setState (via a wrapper):
// an undeclared change to another conversation is reverted and logged instead
// of applied. This is the structural fix for the recurring "desktop randomly
// jumps to another session" bug class (ct-36620 → ct-36951 → ct-37102): each
// earlier round gated specific writers; this makes an ungated writer
// impossible rather than merely unlikely.
//
// Every attempt — allowed or blocked — lands in a ring buffer persisted to
// localStorage, so one console call after a jump names the culprit:
//   __navLog()           // in any build, dev or prod
export type ViewNavSource =
  | "gesture" // a click/keypress in this window — always allowed
  | "boot-restore" // hydration putting the client back on its own last position
  | "adopt" // machine picking a view because there is none (boot-only)
  | "rekey" // same logical conversation under a new id (stub→server, ghost→twin)
  | "undo" // user-invoked undo restoring a snapshot
  | "deeplink" // codecast:// arrival (manual link or policy-cleared handoff)
  | "sync"; // server-driven (must never move the view directly — toast instead)

export type NavEvent = {
  ts: number;
  field: "currentSessionId" | "pendingNavigateId";
  from: string | null;
  to: string | null;
  source: string;
  /** Present when the change was rejected; names the reason. */
  blocked?: string;
  /** Window flavor — the palette popup shares localStorage with the app. */
  win: string;
  stack?: string;
};

let pendingSource: ViewNavSource | null = null;
// Count of applied view changes this window lifetime. "adopt" is only legal
// while this is 0: a machine may give an empty boot a view, never replace one.
let appliedNavCount = 0;

const LOG_KEY = "codecast.navLog";
const LOG_CAP = 200;

/** Declare intent for the view write that immediately follows (same task). */
export function declareViewNav(source: ViewNavSource): void {
  pendingSource = source;
}

/** One-shot read: the middleware consumes the token on every store write. */
export function consumeViewNav(): ViewNavSource | null {
  const s = pendingSource;
  pendingSource = null;
  return s;
}

export function hasViewNavigated(): boolean {
  return appliedNavCount > 0;
}

export function noteViewNavApplied(): void {
  appliedNavCount++;
}

function windowFlavor(): string {
  if (typeof window === "undefined") return "ssr";
  return window.location?.pathname?.startsWith("/palette") ? "palette" : "main";
}

function loadLog(): NavEvent[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LOG_KEY) : null;
    return raw ? (JSON.parse(raw) as NavEvent[]) : [];
  } catch {
    return [];
  }
}

let navLog: NavEvent[] | null = null;

export function recordNavEvent(e: Omit<NavEvent, "ts" | "win" | "stack">): void {
  if (navLog === null) navLog = loadLog();
  // Stacks only for problem events (blocked / untracked writers) — they're what
  // the log exists to name, and stacks on every allowed click would bloat the
  // persisted ring.
  const needsStack = !!e.blocked || e.source.startsWith("untracked");
  const event: NavEvent = {
    ts: Date.now(),
    win: windowFlavor(),
    stack: needsStack ? new Error().stack?.split("\n").slice(2, 8).join("\n") : undefined,
    ...e,
  };
  navLog.push(event);
  if (navLog.length > LOG_CAP) navLog.splice(0, navLog.length - LOG_CAP);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(navLog));
  } catch {
    // Quota/private mode: keep the in-memory log.
  }
  if (e.blocked) {
    // Loud on purpose, in every build: a blocked write is a bug being contained.
    console.error(
      `[viewNav] BLOCKED ${e.field} ${e.from} → ${e.to} (source=${e.source}, reason=${e.blocked})`,
      event.stack,
    );
  }
}

export function getNavLog(): NavEvent[] {
  if (navLog === null) navLog = loadLog();
  return navLog;
}

// Always exposed (prod desktop is where this gets debugged).
if (typeof window !== "undefined") {
  (window as any).__navLog = getNavLog;
}

/** Test-only: clear the one-shot token, lifetime counter, and in-memory log. */
export function _resetViewNavForTests(): void {
  pendingSource = null;
  appliedNavCount = 0;
  navLog = [];
}
