/**
 * Guide markdown bodies, split from the registry (guides.ts) so the registry
 * stays pure data. The `?raw` imports here are Vite-only syntax; keeping them
 * out of guides.ts lets the Bun-run server (server/bot-meta.ts) and bun tests
 * import the registry via lib/seoRoutes without a markdown loader.
 */

import agentSnippets from "./content/agent-snippets.md?raw";
import memory from "./content/memory.md?raw";
import messaging from "./content/messaging.md?raw";
import ambientAwareness from "./content/ambient-awareness.md?raw";
import forksAndSpawn from "./content/forks-and-spawn.md?raw";
import tasksAndPlans from "./content/tasks-and-plans.md?raw";
import triggers from "./content/triggers.md?raw";
import workflows from "./content/workflows.md?raw";
import orchestration from "./content/orchestration.md?raw";
import visualCanvas from "./content/visual-canvas.md?raw";
import publish from "./content/publish.md?raw";
import teamSessions from "./content/team-sessions.md?raw";
import shareASession from "./content/share-a-session.md?raw";
import whichSessionWroteThisLine from "./content/which-session-wrote-this-line.md?raw";
import searchSessionsAcrossMachines from "./content/search-sessions-across-machines.md?raw";
import threadState from "./content/thread-state.md?raw";
import decisions from "./content/decisions.md?raw";
import pullRequests from "./content/pull-requests.md?raw";
import orgRoles from "./content/org-roles.md?raw";
import browser from "./content/browser.md?raw";
import computer from "./content/computer.md?raw";
import typecheck from "./content/typecheck.md?raw";
import skills from "./content/skills.md?raw";
import usageLimits from "./content/usage-limits.md?raw";
import syncEngine from "./content/sync-engine.md?raw";
import teamChat from "./content/team-chat.md?raw";
import calls from "./content/calls.md?raw";
import remoteAndCloudSessions from "./content/remote-and-cloud-sessions.md?raw";

const CONTENT: Record<string, string> = {
  "agent-snippets": agentSnippets,
  "memory": memory,
  "messaging": messaging,
  "ambient-awareness": ambientAwareness,
  "forks-and-spawn": forksAndSpawn,
  "tasks-and-plans": tasksAndPlans,
  "triggers": triggers,
  "workflows": workflows,
  "orchestration": orchestration,
  "visual-canvas": visualCanvas,
  "publish": publish,
  "team-sessions": teamSessions,
  "share-a-session": shareASession,
  "which-session-wrote-this-line": whichSessionWroteThisLine,
  "search-sessions-across-machines": searchSessionsAcrossMachines,
  "thread-state": threadState,
  "decisions": decisions,
  "pull-requests": pullRequests,
  "org-roles": orgRoles,
  "browser": browser,
  "computer": computer,
  "typecheck": typecheck,
  "skills": skills,
  "usage-limits": usageLimits,
  "sync-engine": syncEngine,
  "team-chat": teamChat,
  "calls": calls,
  "remote-and-cloud-sessions": remoteAndCloudSessions,
};

export function getGuideContent(slug: string): string | undefined {
  return CONTENT[slug];
}
