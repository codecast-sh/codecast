// The publish review for a weekly card (components/consequential): what goes
// on the open web and what stays out. Pure, so it is tested without a browser.
import { weekRangeLabel, type WeekCardStats } from "@codecast/shared/contracts/weeklyCard";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";

export function weekCardLedger(stats: WeekCardStats, opts: { show_projects?: boolean; show_tokens?: boolean }): SwitchLedger {
  const shows = ["Your name", "Sessions, hours, active days", "Agents and their share", "Machine count and kinds", "Hours per day"];
  const hidden = ["Titles, prompts, transcripts", "Repos, file paths, hostnames", "Teammates"];
  const projects = opts.show_projects && stats.projects.length > 0;
  const tokens = opts.show_tokens && stats.tokens !== null;
  if (projects) shows.push(`Projects: ${stats.projects.slice(0, 3).map((p) => p.name).join(", ")}`);
  else hidden.push("Project names");
  if (tokens) shows.push("Token total");
  else hidden.push("Tokens");
  return {
    name: "Publish weekly card",
    subject: `${weekRangeLabel(stats)}${stats.partial ? " (so far)" : ""}`,
    shift: ["Private", "Public link"],
    figures: [
      { value: String(stats.sessions), label: "sessions" },
      { value: `${stats.agent_hours}h`, label: "agents working" },
      { value: String(stats.agents.length), label: stats.agents.length === 1 ? "agent" : "agents" },
    ],
    rows: [
      { k: "Shows", v: `${shows.length} things`, list: shows },
      { k: "Never shows", v: `${hidden.length} things`, tone: "ok", list: hidden },
      { k: "Who can open", v: "Anyone with the link" },
      { k: "Link preview", v: "This card as the image" },
    ],
    stop: "Unpublish, one press",
    confirm: "Publish",
  };
}
