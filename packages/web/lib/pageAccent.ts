/** The colour a page's references wear (EntityIdPill), as a CSS value — what
 *  a surface that frames the page (the inline reveal) tints its edge with. */
export function pageAccent(path: string): string {
  if (path.startsWith("/inbox") || path.startsWith("/conversation/")) return "var(--sol-blue)";
  if (path.startsWith("/tasks")) return "var(--sol-violet)";
  if (path.startsWith("/plans")) return "var(--sol-cyan)";
  if (path.startsWith("/docs")) return "var(--sol-green)";
  if (path.startsWith("/triggers") || path.startsWith("/schedules")) return "var(--sol-orange)";
  if (path.startsWith("/initiatives")) return "var(--sol-magenta)";
  if (path.startsWith("/projects")) return "var(--sol-text-muted)";
  return "var(--sol-cyan)";
}
