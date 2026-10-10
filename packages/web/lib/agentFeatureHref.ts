/** The Agent features page opened on one feature's detail. */
export function agentFeatureHref(slug: string): string {
  return `/agent-features?feature=${encodeURIComponent(slug)}`;
}
