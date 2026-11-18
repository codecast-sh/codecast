// The shapes commandGroups.ts lists: type-only, so the list stays a leaf at runtime.
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import type { FlowDeps } from "./flowCommand.js";
import type { RestrictionKey } from "./config/managedPolicy.js";

/** Everything any group's register function asks for: the backend deps every
 *  command needs, plus the one lookup `cast integrations` adds. A register
 *  function destructures the keys it uses, so a wider object is harmless.
 *  Type-only imports, so this stays a leaf at runtime. */
export interface GroupDeps extends PublishDeps {
  resolveProjectId: (ref: string) => Promise<string>;
  /** What `cast flow` reads beyond the backend: the caller's session, its cwd and the team's pool. */
  flow: FlowDeps;
}

export interface CommandGroup {
  /** The first token that names this group. */
  token: string;
  /** Alternate first tokens. The first also shows in the root help term. */
  aliases?: readonly string[];
  /** Hidden from the root help, as the real command is. */
  hidden?: boolean;
  /** Positional terms, exactly as the root help prints them. */
  args?: readonly string[];
  /** Whether the real command declares options, which the term shows. */
  hasOptions?: boolean;
  /** The group's description. The single copy; the group module reads it back. */
  description: string;
  /** The dynamic import of the real registration. Never make this static. */
  load: () => Promise<(program: Command, deps: GroupDeps) => void>;
  /** A managed policy restriction that turns the group off, but for the verbs in `allow` (reading, tearing down). */
  policy?: { key: RestrictionKey; allow?: readonly string[] };
}
