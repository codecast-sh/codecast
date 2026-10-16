// The line a role's tasks run on (the-line.md L2): a workflow slug, absent
// meaning the shipped "line" template. A leaf, so the template manifest can
// check a slug without loading all of orgProposal.ts.
export const DEFAULT_LINE_SLUG = "line";
/** The line a role runs: its own pick, else the shipped line. */
export const lineSlugOf = (role: { line_workflow_slug?: string | null }): string => role.line_workflow_slug || DEFAULT_LINE_SLUG;
export const LINE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
