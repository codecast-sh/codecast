// How a station's session ended, in words. The session runner records its station's output as `work_state: <state>`
// and what the session pinned (cli runner.ts waitOnStation), so a stop that quotes that output (`$review.output`)
// printed the raw field: "The reviewer left no verdict, so the change is not judged. work_state: needs_input".
// The runner says it in words when it writes a stop, and `cast workflow runs | show` say so for rows written before.

const ENDED: Record<string, string> = {
  needs_input: "Its session stopped, waiting for input.",
  done: "Its session finished.",
  dormant: "Its session paused, waiting on a wake.",
  idle: "Its session ended its turn.",
  working: "Its session was still working.",
};

/** `text` with each `work_state: <state>` said in words. */
export function sessionEndWords(text: string): string {
  return text.replace(/(^|\s)work_state: (\w+)(?=\s|$)/g, (_m, pre: string, state: string) => `${pre}${ENDED[state] ?? `Its session read ${state.replace(/_/g, " ")}.`}`);
}
