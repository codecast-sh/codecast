// Every feature guide. Loaded lazily (GuideLayer), never from the tours
// registry, so the scenes stay out of the app's first load.
import { ORG_GUIDE } from "./orgGuide";
import { FLOWS_GUIDE } from "./flowsGuide";
import type { GuideDef } from "./types";

export const GUIDES: GuideDef[] = [ORG_GUIDE, FLOWS_GUIDE];
