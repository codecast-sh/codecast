// The steps a role's flow runs (the-line.md L2): a workflow slug, absent
// meaning the shipped "line" template, which people read as "Standard". A leaf, so the template manifest can
// check a slug without loading all of orgProposal.ts.
export const DEFAULT_LINE_SLUG = "line";
/** What a person reads as the shipped template's name. */
export const DEFAULT_STEPS_LABEL = "Standard";
/** The steps a role's flow runs: its own pick, else the shipped template. */
export const lineSlugOf = (role: { line_workflow_slug?: string | null }): string => role.line_workflow_slug || DEFAULT_LINE_SLUG;
export const LINE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
