// A stop whose words the runner writes itself and that name the one restart that fits: a change the run could not
// freeze again because something reset or rebased the run's worktree (ct-102477). Resuming would refuse the same
// way, and a fresh run of the session's edits would rebuild the branch it left; the worktree's branch as it stands is
// what whoever moved it meant to ship, so the restart runs that branch on the same task. The session hears these
// words, `cast workflow show` prints their restart, and the run page shows them whole: all read them here.

/** Why the refreeze refused: who acted, and where the worktree and the change stand. */
export function worktreeMovedWords(head: string, frozenTip: string): string {
  return `Something reset or rebased the run's worktree to ${head.slice(0, 10)}, off the change as last frozen (${frozenTip.slice(0, 10)}), so the run left it as it is`;
}

/** The restart that fits that stop: run the worktree's branch as it stands, on the same task. */
export const worktreeMovedRestart = (flow: string, task: string, branch: string) => `cast flow run ${flow} --task ${task} --branch ${branch}`;

/** The sentence that names it, after the stop's words. */
export const worktreeMovedRestartWords = (command: string) => `To ship that worktree's branch as it stands now, run it again on this task: \`${command}\`.`;

// Only a reason that opens with the runner's own words for this stop names it: outside text quoted into another
// stop's reason (a reviewer's finding, a script's output) never does.
const OWN = /^Could not freeze (?:session [\w-]+'s|the checkout's) change again: Something reset or rebased the run's worktree to [0-9a-f]+, off the change as last frozen \([0-9a-f]+\), so the run left it as it is\. To ship that worktree's branch as it stands now, run it again on this task: `(cast flow run [\w.-]+ --task ct-\d+ --branch [\w./-]+)`\.$/;

/** The restart a failed run's own reason names (the command), or null for any other reason. */
export function ownRestartOf(failReason: string | null | undefined): string | null {
  return OWN.exec((failReason ?? "").trim())?.[1] ?? null;
}
