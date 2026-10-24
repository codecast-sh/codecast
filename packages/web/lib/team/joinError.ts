import { ConvexError } from "convex/values";

/** What a failed join says. A seat refusal (convex teams.seatRefusal) comes
 *  as data: the joiner cannot upgrade, so it names who can. */
export function joinErrorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const code = (err.data as { code?: string } | null)?.code;
    if (code === "upgrade_required" || code === "subscription_lapsed") return "This team has no free seats. Ask a team admin to upgrade it to Pro.";
  }
  return err instanceof Error ? err.message : "Could not join the team. Try again.";
}
