// A label's identity (line-workspace.md LW4), shared by the line model and the
// store action that writes it, so the store does not import the whole model.
// The server's twin is convex lineWorkspace.lineLabelKey.

export type LabelVerdict = "right" | "wrong";

/** One label's identity: one verdict per person per decision. */
export const lineLabelKey = (runId: string, stepId: string, userId: string) => `${runId}:${stepId}:${userId}`;
