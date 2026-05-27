import { parseInteractivePrompt } from "./src/daemon.ts";

const pane = `Edit file
packages/convex/convex/schema.ts

586
587    session_insights: defineTable({
588      conversation_id: v.id("conversations"),
589 -    team_id: v.id("teams"),
589 +    team_id: v.optional(v.id("teams")),
590      actor_user_id: v.id("users"),
591      source: v.union(
592        v.literal("idle"),

Do you want to make this edit to schema.ts?
❯ 1. Yes
  2. Yes, allow all edits during this session (shift+tab)
  3. No

Esc to cancel · Tab to amend`;

console.log(JSON.stringify(parseInteractivePrompt(pane), null, 2));
