/** The asks column (S19): the panel's own 380px. */
export const STAFFING_ASKS_W = 380;

/** The conversation's column to its left: wider, as the eye should land
 *  there; `roomy` when the window leaves a strip of chart beside both,
 *  `tight` when it does not. */
export const STAFFING_LEAD_W = { roomy: 600, tight: 420 } as const;
