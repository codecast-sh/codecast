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
const TASK_VERSION = "9"; // bumped: product events and --source, and the external data verbs (sources, events, replay, metrics, connector)
const WORK_VERSION = "12"; // bumped: hand a code change off with a change guide (--guide)
const PLAN_VERSION = "2";
const WORKFLOW_VERSION = "2";
const MESSAGING_VERSION = "10";
const VISUAL_VERSION = "7"; // 7: image sizing, "wide"/"small" titles; 6: image captions from alt text + side-by-side rows for adjacent images
const FORKS_VERSION = "8"; // bumped: with N directions this thread takes the first; a branch is seeded as its human's own turn, never a message from the parent
const PUBLISH_VERSION = "4"; // bumped: cast image cross-reference for single-image sharing; never link local paths
const BROWSER_VERSION = "17"; // bumped: reuse abandoned Cast tabs on the same URL; Grok is not keyed by pane
const CHAT_VERSION = "1"; // first release: channels, threads, search, anchor replies
const DECIDE_VERSION = "3"; // v3: never post a probe or test decision; every ask reaches the real queue
const CALLS_VERSION = "6"; // 6: filmed lines marked in the transcript, --crop and --tiles for small screen text; 5: a frame is shown by its citation, --share is public and only on request, the snap spellings; 4: cast call snap, frames of a recorded call; 3: cl-N short ids and cl-N:a-b line embeds
const LIMITS_VERSION = "2"; // 2: a subagent or workflow agent stopped on a limit gets its work run again; 1: usage limits are a pause, not a stop; cast usage
const COMPUTER_VERSION = "1"; // first release: cast computer, the macOS accessibility loop
const CHECK_VERSION = "1"; // first release: cast check, one shared tsc watcher per tree and project
const SIM_VERSION = "1"; // first release: cast sim, the shared simulator pool on a laptop or a cloud Mac
const SKILLS_VERSION = "2"; // bumped: cast-ship opens PRs with cast pr create (change guide walkthrough)
const PR_VERSION = "2"; // bumped: cast pr create, the change guide as the walkthrough
const MODS_VERSION = "1"; // first release: cast mod, panes, commands and fences in the app
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

export function getComputerVersion(): string {
  return COMPUTER_VERSION;
}

export function getSimVersion(): string {
  return SIM_VERSION;
}

export function getCheckVersion(): string {
  return CHECK_VERSION;
}

/** Display only: the skills installer byte-compares each file, so an edited
 *  body lands without a bump. Bump when a skill is added or removed. */
export function getSkillsVersion(): string {
  return SKILLS_VERSION;
}

export function getPrVersion(): string {
  return PR_VERSION;
}

export function getModsVersion(): string {
  return MODS_VERSION;
}
