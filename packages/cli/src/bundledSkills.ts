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
//
// The set installs as ONE snippet, `skills`, so the Settings page, the wizard
// and `cast install skills` all toggle it the way they toggle memory or tasks.

import { CODECAST_SKILL_NAMES, ORCH_AGENT_FILES } from "./codecastOwned.js";

import orchestrateSkill from "../orchestration/skills/orchestrate/SKILL.md" with { type: "text" };
import implementerAgent from "../orchestration/agents/implementer.md" with { type: "text" };
import reviewerAgent from "../orchestration/agents/reviewer.md" with { type: "text" };
import criticAgent from "../orchestration/agents/critic.md" with { type: "text" };
import agentCompleteScript from "../orchestration/scripts/agent-complete.sh" with { type: "text" };
import regroundScript from "../orchestration/scripts/reground.sh" with { type: "text" };
import orchestrationHooks from "../orchestration/hooks.json";

import whySkill from "../skills/cast-why/SKILL.md" with { type: "text" };
import conflictsSkill from "../skills/cast-conflicts/SKILL.md" with { type: "text" };
import secondOpinionSkill from "../skills/cast-second-opinion/SKILL.md" with { type: "text" };
import standupSkill from "../skills/cast-standup/SKILL.md" with { type: "text" };
import pickupSkill from "../skills/cast-pickup/SKILL.md" with { type: "text" };
import handoffSkill from "../skills/cast-handoff/SKILL.md" with { type: "text" };
import planSkill from "../skills/cast-plan/SKILL.md" with { type: "text" };
import shipSkill from "../skills/cast-ship/SKILL.md" with { type: "text" };
import verifySkill from "../skills/cast-verify/SKILL.md" with { type: "text" };
import reviewSkill from "../skills/cast-review/SKILL.md" with { type: "text" };
import learnSkill from "../skills/cast-learn/SKILL.md" with { type: "text" };
import morningSkill from "../skills/cast-morning/SKILL.md" with { type: "text" };
import eodSkill from "../skills/cast-eod/SKILL.md" with { type: "text" };
import bakeoffSkill from "../skills/cast-bakeoff/SKILL.md" with { type: "text" };
import lessonsSkill from "../skills/cast-lessons/SKILL.md" with { type: "text" };
import passSkill from "../skills/cast-pass/SKILL.md" with { type: "text" };
import askteamSkill from "../skills/cast-ask-team/SKILL.md" with { type: "text" };
import triageSkill from "../skills/cast-triage/SKILL.md" with { type: "text" };
import fromcallSkill from "../skills/cast-from-call/SKILL.md" with { type: "text" };
import loopSkill from "../skills/cast-loop/SKILL.md" with { type: "text" };
import worktreeSkill from "../skills/cast-worktree/SKILL.md" with { type: "text" };
import rethinkSkill from "../skills/cast-rethink/SKILL.md" with { type: "text" };
import orgSkill from "../skills/cast-org/SKILL.md" with { type: "text" };

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
  { name: "cast-why", body: whySkill },
  { name: "cast-conflicts", body: conflictsSkill },
  { name: "cast-second-opinion", body: secondOpinionSkill },
  { name: "cast-standup", body: standupSkill },
  { name: "cast-pickup", body: pickupSkill },
  { name: "cast-handoff", body: handoffSkill },
  { name: "cast-plan", body: planSkill },
  { name: "cast-ship", body: shipSkill },
  { name: "cast-verify", body: verifySkill },
  { name: "cast-review", body: reviewSkill },
  { name: "cast-learn", body: learnSkill },
  { name: "cast-morning", body: morningSkill },
  { name: "cast-eod", body: eodSkill },
  { name: "cast-bakeoff", body: bakeoffSkill },
  { name: "cast-lessons", body: lessonsSkill },
  { name: "cast-pass", body: passSkill },
  { name: "cast-ask-team", body: askteamSkill },
  { name: "cast-triage", body: triageSkill },
  { name: "cast-from-call", body: fromcallSkill },
  { name: "cast-loop", body: loopSkill },
  { name: "cast-worktree", body: worktreeSkill },
  { name: "cast-rethink", body: rethinkSkill },
  { name: "cast-org", body: orgSkill },
];

