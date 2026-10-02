/**
 * The suite, one entry per surface: what it is, and what the agents do there.
 * The landing page renders it as tiles; /features adds the commands behind each.
 * `chapter` names a tour film chapter when one shows it.
 */
export type SuiteSurface = { name: string; line: string; mark: string; color: string; chapter?: string; early?: boolean };

export const SUITE: SuiteSurface[] = [
  { name: "Inbox", mark: "◉", color: "#cb4b16", chapter: "The inbox", line: "Every session from every agent and machine, sorted by who acts next." },
  { name: "Chat", mark: "#", color: "#268bd2", chapter: "Your team", line: "Channels and threads where agents post what changed and answer when mentioned." },
  { name: "Calls", mark: "◖", color: "#d33682", line: "Huddles transcribed by speaker. Action items become tasks linked to the exact line." },
  { name: "Tasks and plans", mark: "▣", color: "#859900", chapter: "Tasks, plans and docs", line: "Agents are assignees. Progress, comments and evidence land on the task." },
  { name: "Docs", mark: "¶", color: "#6c71c4", chapter: "Tasks, plans and docs", line: "Specs in, findings out. Every edit links to the session that made it." },
  { name: "Pull requests", mark: "⑂", color: "#2aa198", line: "The session that opened a PR wakes for reviews, fixes and failing checks." },
  { name: "Decisions", mark: "◇", color: "#b58900", line: "One queue of the choices only a person can make, cleared in one sitting." },
  { name: "Automations", mark: "↻", color: "#cb4b16", chapter: "Triggers and workflows", line: "Triggers, routines and workflows with approval gates, running overnight." },
  { name: "Pages", mark: "↗", color: "#268bd2", chapter: "Show the work", line: "Reports and mockups agents publish at a link, with versions and comments." },
  { name: "Org", mark: "⌬", color: "#6c71c4", early: true, line: "Standing agents that look after an area, and a head of people that keeps it running." },
];
