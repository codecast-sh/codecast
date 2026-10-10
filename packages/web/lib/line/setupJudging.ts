// "Set up judging" and "Improve this judge" (docs/architecture/learning-loop.md
// LL4): one action that starts a session in the project's checkout, on the
// machine that holds it, with the setup pass. The pass itself lives in the
// CLI (packages/cli/src/judgingSetup.md, printed by `cast line judging`), so
// the session reads the same words wherever it was started from; this brief
// only names the project, the judge to start from, and the cases a person
// marked wrong. The session goes through the one spawn route the web has
// (lib/spawnSession), so it paints at once and lands in the inbox; what it
// drafts reaches a person as a card, never as an applied change.
import { toast } from "sonner";
import { defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { spawnSessionWithPrompt } from "../spawnSession";

/** A decision of the judge that a person marked wrong: where to find it, and what they said. */
export type WrongCase = { ref: string; note?: string | null };

export type JudgingFocus = {
  /** The judge to start from ("Improve this judge"); absent sets up the whole project. */
  judge?: string | null;
  wrong?: WrongCase[];
};

type ProjectRow = {
  title?: string;
  short_id?: string | null;
  project_path?: string | null;
  line_profile?: { root?: string; device_id?: string } | null;
};

/** The most wrong cases the brief carries; the session finds the rest from the judge. */
export const WRONG_CASES_SHOWN = 20;

/** The session's brief: the project, the focus, and the pass to follow. */
export function judgingSetupPrompt(project: ProjectRow, focus: JudgingFocus = {}): string {
  const title = project.title || "this project";
  const ref = project.short_id || `"${title}"`;
  const judge = focus.judge?.trim();
  const command = `cast line judging --project ${ref}${judge ? ` --judge ${judge}` : ""}`;
  const lines = [
    judge
      ? `Improve the judge ${judge} for ${title} (${ref}). Run \`${command}\` and follow the pass it prints, starting from this judge.`
      : `Set up judging for ${title} (${ref}). Run \`${command}\` and follow the pass it prints: draft what the project needs to learn, try it on real recent data, and bring one card to turn it on.`,
    "Nothing goes live, ships, is published or spends before a person answers that card.",
  ];
  const wrong = (focus.wrong ?? []).filter((c) => c.ref?.trim());
  if (judge && wrong.length) {
    lines.push("", "Cases a person marked wrong:");
    for (const c of wrong.slice(0, WRONG_CASES_SHOWN)) lines.push(`- ${c.ref.trim()}${c.note?.trim() ? `: ${c.note.trim()}` : ""}`);
    if (wrong.length > WRONG_CASES_SHOWN) lines.push(`- and ${wrong.length - WRONG_CASES_SHOWN} more`);
  }
  return lines.join("\n");
}

/**
 * Where the session runs: the checkout and machine that published the
 * project's line profile (the repo the judges live in), else the project's
 * folder on whatever machine starts it.
 */
export function judgingSetupPlace(project: ProjectRow | undefined): { projectPath?: string; targetDeviceId?: string } {
  const lp = project?.line_profile;
  const projectPath = lp?.root || project?.project_path || undefined;
  return { ...(projectPath ? { projectPath } : {}), ...(lp?.root && lp.device_id ? { targetDeviceId: lp.device_id } : {}) };
}

/** Start the session; the stub id is the session, usable at once to link to it. */
export function startJudgingSetup(projectId: string, focus: JudgingFocus = {}): { stubId: string } {
  const st = useInboxStore.getState() as any;
  const project: ProjectRow | undefined = st.projects?.[projectId];
  const place = judgingSetupPlace(project);
  const { stubId } = spawnSessionWithPrompt({
    prompt: judgingSetupPrompt(project ?? {}, focus),
    projectPath: place.projectPath ?? defaultNewSessionPath(st) ?? undefined,
    targetDeviceId: place.targetDeviceId,
    failureLabel: focus.judge ? "Failed to start improving the judge" : "Failed to start setting up judging",
  });
  toast.success(focus.judge ? `A session is improving ${focus.judge}` : "A session is setting up judging", {
    description: "It will bring you one card when it has something to turn on.",
  });
  return { stubId };
}
