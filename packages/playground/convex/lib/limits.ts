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
export const TIMELINE_MAX = 500;
export const GALLERY_MAX = 48;

/** The runtime data layer (app_data). A collection read returns at most
 *  DATA_LIST_MAX docs, so one live list stays a few MB at worst. */
export const MAX_DATA_DOCS_PER_APP = 5_000;
export const MAX_DATA_BYTES_PER_APP = 20_000_000;
export const MAX_DATA_DOC_BYTES = 16_000;
export const DATA_LIST_MAX = 400;
export const DATA_NAME_MAX = 64;
export const MAX_DATA_DEPTH = 16;
/** usePresence().setMyState: small per-person state (a cursor, a pick). */
export const MAX_PRESENCE_STATE_BYTES = 2_000;

/** The builder (convex/builder). A build that passes its deadline or cost
 *  ceiling fails; budgets are per UTC day, in dollars. */
export const BUILD_DEADLINE_MS = 180_000;
export const BUILD_CEILING_USD = 1;
/** Times the agent may call finish on a draft that does not validate. */
export const BUILD_FINISH_ATTEMPTS = 3;
export const APP_DAILY_BUDGET_USD = 10;
export const GLOBAL_DAILY_BUDGET_USD = 150;
/** A build card keeps its latest narration lines, each one short. */
export const NARRATION_LINES_MAX = 40;
export const NARRATION_LINE_MAX = 200;
/** The room context the builder and triage read. */
export const BUILD_ROOM_CONTEXT = 12;
export const BUILD_HISTORY_CONTEXT = 20;
/** Files this size or less (in total) go to the builder inline, which saves
 *  it a round trip per read. */
export const BUILD_INLINE_FILES_BYTES = 80_000;

export type RateRule = { max: number; windowMs: number };

/** Fixed-window rate rules, keyed by what they protect. */
export const RATE = {
  register: { max: 1_000, windowMs: 60_000 },
  createApp: { max: 5, windowMs: 10 * 60_000 },
  message: { max: 20, windowMs: 60_000 },
  appMessage: { max: 120, windowMs: 60_000 },
  dataWrite: { max: 240, windowMs: 60_000 },
  appDataWrite: { max: 1_200, windowMs: 60_000 },
  /** The SDK sends presence state at most ~10 times a second. */
  presenceState: { max: 900, windowMs: 60_000 },
  build: { max: 8, windowMs: 10 * 60_000 },
  appBuild: { max: 40, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateRule>;
