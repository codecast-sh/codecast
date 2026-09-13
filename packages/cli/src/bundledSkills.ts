// Files the CLI installs under ~/.claude, embedded at build time.
//
// A compiled binary carries no source tree beside it. The orchestration
// installer resolved `../orchestration` relative to the executable and, on
// every release install, found nothing and wrote nothing: the v1.1.132 binary
// contains none of the orchestrate skill's text. Text imports put the bytes
// inside the binary, the way browser/appIdentity.ts embeds its icon and
// computer/helperPayload.ts its helper tar, so a brew install and
// `bun run src/main.ts` install the same files.
//
// Adding a skill is three edits, and bundledSkills.test.ts fails when any one
// of them is missing: a directory packages/cli/skills/<name>/SKILL.md whose
// frontmatter `name` equals the directory name (the agentskills.io identity
// rule the capability inventory enforces), one import here, and the name in
// CODECAST_SKILL_NAMES (codecastOwned.ts) so the home mirror never prunes it.

import { CODECAST_SKILL_NAMES, ORCH_AGENT_FILES } from "./codecastOwned.js";

import orchestrateSkill from "../orchestration/skills/orchestrate/SKILL.md" with { type: "text" };
import implementerAgent from "../orchestration/agents/implementer.md" with { type: "text" };
import reviewerAgent from "../orchestration/agents/reviewer.md" with { type: "text" };
import criticAgent from "../orchestration/agents/critic.md" with { type: "text" };
import agentCompleteScript from "../orchestration/scripts/agent-complete.sh" with { type: "text" };
import regroundScript from "../orchestration/scripts/reground.sh" with { type: "text" };
import orchestrationHooks from "../orchestration/hooks.json";

import whySkill from "../skills/codecast-why/SKILL.md" with { type: "text" };
import conflictsSkill from "../skills/codecast-conflicts/SKILL.md" with { type: "text" };
import secondOpinionSkill from "../skills/codecast-second-opinion/SKILL.md" with { type: "text" };
import standupSkill from "../skills/codecast-standup/SKILL.md" with { type: "text" };

export interface OrchestrationHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** The orchestration snippet's files: one skill, the three agents, the hook
 *  scripts and the settings.json entries that point at them. */
export const ORCHESTRATION_BUNDLE = {
  skill: orchestrateSkill,
  agents: {
    "implementer.md": implementerAgent,
    "reviewer.md": reviewerAgent,
    "critic.md": criticAgent,
  } satisfies Record<(typeof ORCH_AGENT_FILES)[number], string>,
  scripts: {
    "agent-complete.sh": agentCompleteScript,
    "reground.sh": regroundScript,
  } as Record<string, string>,
  hooks: (orchestrationHooks as { hooks: Record<string, OrchestrationHookEntry[]> }).hooks,
};

export interface BundledSkill {
  /** Directory name under ~/.claude/skills, equal to the frontmatter name. */
  name: (typeof CODECAST_SKILL_NAMES)[number];
  body: string;
}

/** The codecast skills: slash commands over the team's shared state. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { name: "codecast-why", body: whySkill },
  { name: "codecast-conflicts", body: conflictsSkill },
  { name: "codecast-second-opinion", body: secondOpinionSkill },
  { name: "codecast-standup", body: standupSkill },
];
