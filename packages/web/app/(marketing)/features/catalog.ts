/**
 * The feature deep dives, one entry per /features/<slug> page. The route,
 * the SEO manifest, the prerender and the /features index all derive from
 * this list; each page's body lives in ./<slug>/Page.tsx (wired in ./pages.tsx).
 */
export type FeatureDeepDive = {
  slug: string;
  /** Short name for links and cards. */
  name: string;
  /** The page's headline-length title, used for the document title and social card. */
  title: string;
  /** One or two sentences: what it is and why it matters. Meta description and card copy. */
  dek: string;
  /** The command a reader would type first. */
  command: string;
  color: string;
};

export const FEATURE_DEEP_DIVES: FeatureDeepDive[] = [
  { slug: "browser", name: "cast browser", command: "cast browser open <url>", color: "#dc322f",
    title: "cast browser: your agents drive your own Chrome",
    dek: "Agents verify UI, read behind sign-ins and reproduce bugs in a background tab of the Chrome you already use, with every screenshot and console error landing in the conversation." },
  { slug: "computer", name: "cast computer", command: "cast computer get-app-state --app com.apple.Preview", color: "#d33682",
    title: "cast computer: agents that use your Mac's native apps",
    dek: "Agents read any macOS window as an accessibility tree and act on it by name, in the background, without taking your screen, your mouse or your keyboard." },
  { slug: "publish", name: "cast publish", command: "cast publish report.html", color: "#2aa198",
    title: "cast publish: a URL for everything your agent makes",
    dek: "Reports, dashboards and mockups go live at a stable link with versions, diffs, comments and gates, and render inline in the conversation that made them." },
  { slug: "triggers", name: "Triggers", command: 'cast trigger add "Check CI" --in 30m', color: "#cb4b16",
    title: "Triggers: agent work that runs after the session ends",
    dek: "Schedule follow-ups, standing monitors and event reactions that wake a session or spawn a fresh one, and report only when a person needs to read it." },
  { slug: "agents", name: "Spawn and fork", command: 'cast spawn --subagent -- "<task>"', color: "#859900",
    title: "Spawn, fork and switch: many agents, one thread you steer",
    dek: "Delegate to workers on any backend, branch a conversation into parallel directions, or move a session to another agent without losing a line of history." },
  { slug: "memory", name: "Team memory", command: 'cast search "auth" -s 7d', color: "#6c71c4",
    title: "Team memory: every agent reads what every other agent learned",
    dek: "Search, ask and blame across every session your team has run, so an agent starts from the decisions already made instead of rediscovering them." },
  { slug: "decisions", name: "Decisions", command: 'cast decide "Backoff?" -o "Exponential" -o "Fixed"', color: "#b58900",
    title: "Decisions: one queue for the calls only you can make",
    dek: "Agents queue the choices that need a person, with the evidence attached, and keep working while you clear the queue in one sitting." },
  { slug: "pull-requests", name: "Pull requests", command: "cast pr shepherd on", color: "#2aa198",
    title: "Pull requests that know the session that wrote them",
    dek: "The session that opened a PR owns it until merge: it wakes for reviews, fixes failing checks and answers threads, and every line traces back to the conversation behind it." },
  { slug: "cloud", name: "Cloud hosts", command: 'cast spawn --cloud "<task>"', color: "#268bd2",
    title: "Cloud hosts: run sessions on your own box, steer from anywhere",
    dek: "Start a session on your cloud host from this checkout, uncommitted work included, mirror its tree back live, and migrate sessions between laptop and host mid-turn." },
  { slug: "calls", name: "Calls", command: "cast call <id> --transcript", color: "#d33682",
    title: "Calls: huddles your agents were on",
    dek: "Team calls transcribed by speaker, summarized with action items, and readable by every agent, so what was decided out loud reaches the work." },
];

export function getFeatureDeepDive(slug: string): FeatureDeepDive | undefined {
  return FEATURE_DEEP_DIVES.find((f) => f.slug === slug);
}

export function featureHref(slug: string): string {
  return `/features/${slug}`;
}
