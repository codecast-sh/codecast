import { STRONG_MODEL } from "./anthropic";

// The model the Changes page's prose asks, in a leaf of its own so a reader
// that only needs the pin (the evals' surface metas) never loads the prose
// module and the function graph behind it.

/**
 * Stories and editions both ask the strong model. On the evals Haiku kept
 * supplying motives no input stated (14 of 20 story replays passed against
 * Sonnet's 20 of 20), and the page is only worth reading if every reason on it
 * is sourced. A day costs cents either way, under changesProse's DAILY_CAP_USD.
 */
export const PROSE_MODEL = STRONG_MODEL;
