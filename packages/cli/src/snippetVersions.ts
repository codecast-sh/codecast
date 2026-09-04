// Per-snippet version labels. These are NOT the rewrite key: the installer
// decides reinstalls by a content hash of the body it ships (snippetStale /
// stampSnippet, ./snippets.ts), so editing a body needs no bump here. They are
// written alongside the hash as a display value and as a compat shadow — an
// older CLI compares its own constant against the config key, so a downgrade
// still finds the value it expects instead of rewriting on every run. Bump one
// when you want the recorded version to say something meaningful to a human.
//
// They live beside the snippet code rather than in ./update.ts: they say
// nothing about the self updater, which is now @platform/cli-kit/update.
// ./update.ts re-exports every getter here, so existing importers are unchanged.

const MEMORY_VERSION = "14"; // bumped: --state done / dormant, states answer who acts next
const TASK_VERSION = "6"; // bumped: issue_* events on --on (Linear and GitHub issues)
const WORK_VERSION = "9"; // bumped: cast task start --spawn; tasks backed by a Linear or GitHub issue print its identifier and link
const PLAN_VERSION = "2";
const WORKFLOW_VERSION = "1";
const MESSAGING_VERSION = "9"; // bumped: a plain stash pops back on a trigger wake; cast stash --hide keeps it silent
const VISUAL_VERSION = "6"; // bumped: image captions from alt text + side-by-side rows for adjacent images
const FORKS_VERSION = "6"; // bumped: cast exec — print mode for every harness (run, print, exit)
const PUBLISH_VERSION = "4"; // bumped: cast image cross-reference for single-image sharing; never link local paths
const BROWSER_VERSION = "12";
const CHAT_VERSION = "1"; // first release: channels, threads, search, anchor replies
const DECIDE_VERSION = "2"; // v2: age + messages-since on ls, stale-ask sweeping guidance
const CALLS_VERSION = "1"; // first release: cast calls / cast call (transcripts, summaries)
const LIMITS_VERSION = "1"; // first release: usage limits are a pause, not a stop; cast usage
const STATE_VERSION = "6"; // bumped: blocked declaration resurfaces a stashed session (the attention claim)

export function getMemoryVersion(): string {
  return MEMORY_VERSION;
}

export function getTaskVersion(): string {
  return TASK_VERSION;
}

export function getWorkVersion(): string {
  return WORK_VERSION;
}

export function getPlanVersion(): string {
  return PLAN_VERSION;
}

export function getWorkflowVersion(): string {
  return WORKFLOW_VERSION;
}

export function getMessagingVersion(): string {
  return MESSAGING_VERSION;
}

export function getVisualVersion(): string {
  return VISUAL_VERSION;
}

export function getForksVersion(): string {
  return FORKS_VERSION;
}

export function getStateVersion(): string {
  return STATE_VERSION;
}

export function getPublishVersion(): string {
  return PUBLISH_VERSION;
}

export function getBrowserVersion(): string {
  return BROWSER_VERSION;
}

export function getChatVersion(): string {
  return CHAT_VERSION;
}

export function getDecideVersion(): string {
  return DECIDE_VERSION;
}

export function getCallsVersion(): string {
  return CALLS_VERSION;
}

export function getLimitsVersion(): string {
  return LIMITS_VERSION;
}
