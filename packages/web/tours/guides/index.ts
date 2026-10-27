import { lazy } from "react";
import type { TeamFeatureKey } from "@codecast/shared/contracts";

export { GuideLayer } from "./GuideLayer";
export { FeatureOfferAnywhere } from "./FeatureOfferAnywhere";

/** The guide that teaches a team feature, by its tour id. */
export const GUIDE_FOR: Partial<Record<TeamFeatureKey, string>> = { org: "org-guide", line: "flows-guide" };

/** A feature's landing while it is off (FeatureLanding); loads the guides' scenes, so only when shown. */
export const FeatureLanding = lazy(() => import("./FeatureLanding"));
