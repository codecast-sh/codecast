/**
 * `cast resume` runs the agent in the foreground on THIS machine, so the
 * conversation must be owned by this machine too. The server routes every
 * message and restart sent from the web to `owner_device_id`, and the daemon on
 * any other machine refuses to deliver (the single-owner guard). A resume that
 * left ownership behind kept the old machine as the delivery target: once it
 * slept, messages from the web waited on a daemon that was gone while the
 * session ran fine here, and the old machine's copy kept answering in parallel
 * when it woke.
 *
 * Adopting goes through moveSessionToDevice with resume:false, the same flip a
 * web move makes minus the daemon resume (this process is the resume): it
 * restamps the owner, writes the machine-switch divider, and tells the old
 * machine to release its copy.
 */

export interface ResumeOwnershipDeps {
  thisDeviceId: string;
  /** The conversation's current owner device, or null when it has none. Throws on a failed lookup. */
  getOwnerDeviceId: () => Promise<string | null>;
  /** Make this machine the owner and release the previous one. */
  moveHere: (projectPath: string) => Promise<unknown>;
}

export type ResumeOwnershipResult =
  | { kind: "already_here" }
  | { kind: "adopted"; from: string | null }
  | { kind: "failed"; error: string };

export async function adoptConversationForResume(
  deps: ResumeOwnershipDeps,
  projectPath: string,
): Promise<ResumeOwnershipResult> {
  let owner: string | null;
  try {
    owner = await deps.getOwnerDeviceId();
  } catch (err) {
    return { kind: "failed", error: errorText(err) };
  }
  if (owner === deps.thisDeviceId) return { kind: "already_here" };
  try {
    await deps.moveHere(projectPath);
  } catch (err) {
    return { kind: "failed", error: errorText(err) };
  }
  return { kind: "adopted", from: owner };
}

/** The line `cast resume` prints for a result, or null when there is nothing to say. */
export function describeResumeOwnership(result: ResumeOwnershipResult, sessionRef: string): string | null {
  switch (result.kind) {
    case "already_here":
      return null;
    case "adopted":
      return result.from
        ? "Moved this session to this machine: messages sent from codecast now come here, and the other machine stops its copy."
        : null;
    case "failed":
      return `Couldn't move this session to this machine (${result.error}). Messages sent from codecast may still go to the machine it ran on before; run \`cast pull ${sessionRef}\` to move it here.`;
  }
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Convex wraps server errors as "[Request ID: …] Server Error\nUncaught Error: <message>\n    at …".
  const uncaught = raw.match(/Uncaught Error:\s*([^\n]+)/);
  return (uncaught ? uncaught[1] : raw.split("\n")[0]).trim();
}
