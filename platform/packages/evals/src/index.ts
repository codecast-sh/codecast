/**
 * @platform/evals: read conversations, freeze a moment, replay and simulate
 * it, judge the result. The model and the adapter seams are here; the
 * terminal renderers are `./render`, the pages `./html`, the commander
 * commands `./cli`, and the on-disk run layout with a file backed freeze
 * store `./fs`.
 */
export * from './model';
export { ASSISTANT_ID, AUDIENCE_WORDS, assignHues, buildStory, deriveParticipants, type Roster } from './story';
