// The one Convex client, and the origin apps run on: the same deployment's
// .convex.site, a different site from the shell (SPEC "Runtime").
import { ConvexReactClient } from "convex/react";

const url = import.meta.env.CONVEX_URL as string;

export const convex = new ConvexReactClient(url);

export const RUN_ORIGIN: string = (import.meta.env.VITE_RUN_ORIGIN as string | undefined) ?? url.replace(/\.convex\.cloud$/, ".convex.site");
