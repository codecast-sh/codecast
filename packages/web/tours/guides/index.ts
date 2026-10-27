import type { TeamFeatureKey } from "@codecast/shared/contracts";

export { GuideLayer } from "./GuideLayer";

/** The guide that teaches a team feature, by its tour id. */
export const GUIDE_FOR: Partial<Record<TeamFeatureKey, string>> = { org: "org-guide", line: "flows-guide" };
