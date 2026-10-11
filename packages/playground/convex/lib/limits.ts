// Every cap in the playground backend, in one place, so the builder's
// validation, the room and the runtime data layer agree on the numbers.

/** Files of one version. Text only in v1; binary assets would go to storage. */
export const MAX_FILES_PER_VERSION = 60;
export const MAX_FILE_BYTES = 200_000;
export const MAX_VERSION_BYTES = 1_500_000;
export const MAX_PATH_LENGTH = 120;
export const MAX_PATH_DEPTH = 6;

/** The room. */
export const MESSAGE_BODY_MAX = 2_000;
export const ELEMENT_FIELD_MAX = { selector: 300, tag: 40, text: 200, snippet: 600 } as const;
export const VERSION_SUMMARY_MAX = 160;
export const MESSAGE_PAGE_MAX = 100;
/** The newest messages the app's link follows while its room is closed. */
export const LATEST_MESSAGES = 6;
export const TIMELINE_MAX = 500;
export const GALLERY_MAX = 48;

/** A version's gallery picture (stills.ts): the app as an 800x800 page, the
 *  size the gallery lays every thumbnail out at, so a still and the live
 *  preview over it match. Wide enough for an app's desktop layout, narrow
 *  enough that a third-width tile still reads; square, so the gallery's big
 *  tile shows the whole page and a wide tile shows its top. */
export const STILL_VIEWPORT = { width: 800, height: 800 } as const;
export const STILL_MAX_BYTES = 400_000;
export const STILL_TYPES = ["image/webp", "image/jpeg", "image/png"];
/** The version's author's screen shows it first; anyone may picture it after. */
export const STILL_AUTHOR_FIRST_MS = 30_000;
/** An app's runtime error as the room's note quotes it. */
export const RUNTIME_ERROR_MAX = 300;
/** The change ideas Clay leaves for the empty room. */
export const IDEAS_MAX = 3;
export const IDEA_MAX = 60;

/** The runtime data layer (app_data). A collection read returns its newest
 *  DATA_LIST_MAX docs (after the read's `where`), so one live list stays a
 *  few MB at worst. SDK_DOCS states both caps to the builder. */
export const MAX_DATA_DOCS_PER_APP = 5_000;
export const MAX_DATA_BYTES_PER_APP = 20_000_000;
export const MAX_DATA_DOC_BYTES = 16_000;
/** Forks copy their source's data. A copy this small happens inside the fork
 *  itself (an exact snapshot); a bigger one runs in pages after it. The bytes
 *  copied count against daily budgets, overall and per forker, so forking a
 *  full app over and over cannot fill the deployment. */
export const COPY_PAGE_DOCS = 100;
export const COPY_INLINE_BYTES = 1_000_000;
export const COPY_DAILY_BYTES = 2_000_000_000;
export const VISITOR_COPY_DAILY_BYTES = 60_000_000;
export const DATA_LIST_MAX = 400;
/** removeWhere deletes at most this many docs a call; the SDK calls again
 *  until none match. One call counts as one write. */
export const DATA_REMOVE_PAGE = 200;
/** Fields one `where` may match on. */
export const DATA_WHERE_FIELDS_MAX = 4;
export const DATA_NAME_MAX = 64;
export const MAX_DATA_DEPTH = 16;
/** usePresence().setMyState: small per-person state (a cursor, a pick). */
export const MAX_PRESENCE_STATE_BYTES = 2_000;
/** The most people one app's presence reads return. Visitors are free to
 *  mint, so this is what keeps a flooded room (and the gallery, which reads
 *  every card's room) a bounded read for everyone watching it. */
export const HERE_MAX = 100;

/** The builder (convex/builder). A build that passes its deadline or cost
 *  ceiling fails; budgets are per UTC day, in dollars. */
export const BUILD_DEADLINE_MS = 180_000;
export const BUILD_CEILING_USD = 1;
/** Times the agent may call finish on a draft that does not validate. */
export const BUILD_FINISH_ATTEMPTS = 3;
export const APP_DAILY_BUDGET_USD = 10;
/** What one visitor's requests may cost a day, wherever they ask. */
export const VISITOR_DAILY_BUDGET_USD = 3;
export const GLOBAL_DAILY_BUDGET_USD = 150;
/** Triage holds this much against the budgets from the moment it is asked
 *  until the call's real cost is charged (builder/triage.ts). */
export const TRIAGE_CEILING_USD = 0.02;
/** A build card keeps its latest narration lines, each one short. */
export const NARRATION_LINES_MAX = 40;
export const NARRATION_LINE_MAX = 200;
/** What a version says about where to look: the element its change is about
 *  (a CSS selector) and, for a change people find by doing, what to try. */
export const SPOTLIGHT_MAX = 200;
export const TRY_MAX = 60;
/** The room context the builder and triage read. */
export const BUILD_ROOM_CONTEXT = 12;
export const BUILD_HISTORY_CONTEXT = 20;
/** Files this size or less (in total) go to the builder inline, which saves
 *  it a round trip per read. */
export const BUILD_INLINE_FILES_BYTES = 80_000;

/** Reporting an app (reports.ts): why, in a person's words. */
export const REPORT_REASON_MAX = 500;

export type RateRule = { max: number; windowMs: number };

/** Fixed-window rate rules, keyed by what they protect. A visitor costs a
 *  proof of work to mint (lib/proof), so per-visitor rules bound what a
 *  script can do per CPU second; the per-app rules bound what lands on one
 *  app. No rule counts everyone together: a shared counter is one an abuser
 *  can spend for everyone. */
export const RATE = {
  /** Registrations the deployment takes at the base proof before it asks
   *  every newcomer for the harder one. Never refuses anyone. */
  registerCalm: { max: 300, windowMs: 60_000 },
  createApp: { max: 5, windowMs: 10 * 60_000 },
  /** Heartbeats that write and typing pings: about 10 a minute, more while
   *  someone steps through the timeline (each step says what they view). */
  presence: { max: 300, windowMs: 60_000 },
  /** Each character change re-renders every room the visitor is in. */
  character: { max: 20, windowMs: 60_000 },
  report: { max: 10, windowMs: 60 * 60_000 },
  message: { max: 20, windowMs: 60_000 },
  appMessage: { max: 120, windowMs: 60_000 },
  dataWrite: { max: 240, windowMs: 60_000 },
  appDataWrite: { max: 1_200, windowMs: 60_000 },
  /** The SDK sends presence state at most ~10 times a second. */
  presenceState: { max: 900, windowMs: 60_000 },
  build: { max: 8, windowMs: 10 * 60_000 },
  restore: { max: 20, windowMs: 10 * 60_000 },
  appRestore: { max: 60, windowMs: 10 * 60_000 },
  appBuild: { max: 40, windowMs: 10 * 60_000 },
  /** Gallery pictures: one per version, so a visitor opening apps needs few. */
  still: { max: 30, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateRule>;

/** A counter whose window opened this long ago has lapsed under every rule. */
export const RATE_WINDOW_MAX_MS = Math.max(...Object.values(RATE).map((r) => r.windowMs));
