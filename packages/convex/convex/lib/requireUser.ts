import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";

/** The signed-in caller, or a thrown "Not authenticated". A leaf module so
 *  a function file can take it without importing a whole sibling module. */
export async function requireUser(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}
