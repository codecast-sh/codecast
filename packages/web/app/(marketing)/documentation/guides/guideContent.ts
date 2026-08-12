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
import threadState from "./content/thread-state.md?raw";

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
  "thread-state": threadState,
};

export function getGuideContent(slug: string): string | undefined {
  return CONTENT[slug];
}
