// A wall-clock budget for work that must fit in one frame. On a developer's
// machine that is the frame itself, 16 ms. A shared CI runner times the same
// work at 17 to 24 ms on a quiet day (Nov 26: blame landing, quick open), so
// there the budget catches a regression of several times rather than a noisy
// neighbour. A budget that can count work instead of time should.
export const FRAME_BUDGET_MS = process.env.CI ? 48 : 16;
