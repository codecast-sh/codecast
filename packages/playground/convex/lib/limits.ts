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

/** The runtime data layer (app_data). */
export const MAX_DATA_DOCS_PER_APP = 5_000;
export const MAX_DATA_DOC_BYTES = 64_000;

export type RateRule = { max: number; windowMs: number };

/** Fixed-window rate rules, keyed by what they protect. */
export const RATE = {
  register: { max: 1_000, windowMs: 60_000 },
  createApp: { max: 5, windowMs: 10 * 60_000 },
  message: { max: 20, windowMs: 60_000 },
  appMessage: { max: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;
