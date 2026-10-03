/** True when the viewer asked the system for less animation. Read live rather
 *  than cached at module load, because the setting can change mid session. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
