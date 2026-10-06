// Restore and fork (ct-57516) are not on the deployment yet. Their shapes as
// the shell calls them live here, in one place, so when they land this file
// becomes `api.versions.restore` / `api.apps.fork` and nothing else changes.
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";

type Creds = { visitor_id: string; secret: string };

/** Append a new live version with version `number`'s files; posts the restore note. */
export const restoreVersion = makeFunctionReference<"mutation", Creds & { app_id: Id<"apps">; number: number }, { number: number }>("versions:restore");

/** A new app whose v1 copies version `number` (and a copy of the data); posts the fork note. */
export const forkApp = makeFunctionReference<"mutation", Creds & { app_id: Id<"apps">; number: number; name: string }, { app_id: Id<"apps">; slug: string }>("apps:fork");
