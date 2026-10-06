/**
 * Chapter markdown bodies, split from the registry (chapters.ts) because the
 * `?raw` imports are Vite-only syntax; same split as documentation/guides.
 */

import theOrg from "./content/the-org.md?raw";
import theInbox from "./content/the-inbox.md?raw";
import switchingAgents from "./content/switching-agents.md?raw";
import teamMemory from "./content/team-memory.md?raw";
import decisions from "./content/decisions.md?raw";
import triggers from "./content/triggers.md?raw";
import publish from "./content/publish.md?raw";
import pullRequests from "./content/pull-requests.md?raw";
import browser from "./content/browser.md?raw";
import computer from "./content/computer.md?raw";
import cloudHosts from "./content/cloud-hosts.md?raw";
import calls from "./content/calls.md?raw";
import mods from "./content/mods.md?raw";

const CONTENT: Record<string, string> = {
  "the-org": theOrg,
  "the-inbox": theInbox,
  "switching-agents": switchingAgents,
  "team-memory": teamMemory,
  "decisions": decisions,
  "triggers": triggers,
  "publish": publish,
  "pull-requests": pullRequests,
  "browser": browser,
  "computer": computer,
  "cloud-hosts": cloudHosts,
  "calls": calls,
  "mods": mods,
};

export function getChapterContent(slug: string): string | undefined {
  return CONTENT[slug];
}
