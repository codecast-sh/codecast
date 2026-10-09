/**
 * Blog post registry — the single list the index renders from. Each post is its
 * own route under blog/<slug>/page.tsx; the entry here carries the metadata the
 * index card and the post header both read, so the two never drift.
 */

export type BlogPost = {
  slug: string;
  title: string;
  /** One-line standfirst shown on the index card and under the post title. */
  dek: string;
  author: string;
  /** ISO date; `dateLabel` is the human form shown in the UI. */
  date: string;
  dateLabel: string;
  readingMinutes: number;
  /** The image the index shows for the post, under public/blog/<slug>/. */
  cover: { src: string; alt: string };
};

export const POSTS: BlogPost[] = [
  {
    slug: "codecast-in-the-cloud",
    title: "Codecast in the cloud",
    dek: "Every cloud feature, end to end: a host in your own AWS account that starts from your uncommitted work, carries your agent config and logins, mirrors its edits back to your laptop, takes whole batches of running sessions mid-flight, and sleeps when nothing is happening.",
    author: "the codecast team",
    date: "2026-10-07",
    dateLabel: "October 7, 2026",
    readingMinutes: 16,
    cover: { src: "/blog/codecast-in-the-cloud/cover.png", alt: "What moves between a laptop and a cloud host: spawn, home mirror, logins, live sync, migrate, browser sync" },
  },
  {
    slug: "the-tree-at-the-end-of-every-turn",
    title: "The tree at the end of every turn",
    dek: "A transcript shows the edits an agent made with its editing tools. It never sees what a shell command, a formatter or a person changed. Codecast now records the whole working tree at the end of every turn, as git commits you can diff and rewind to.",
    author: "the codecast team",
    date: "2026-10-07",
    dateLabel: "October 7, 2026",
    readingMinutes: 6,
    cover: { src: "/blog/the-tree-at-the-end-of-every-turn/cover.png", alt: "cast diff --turns listing a session's 64 turn snapshots" },
  },
  {
    slug: "field-manual",
    cover: { src: "/blog/field-manual/inbox-hero.webp", alt: "The codecast inbox beside an open conversation" },
    title: "The codecast field manual: running a company of agents",
    dek: "The org your agents report into, the inbox that sorts them by who acts next, moving a live conversation from Claude to Codex without losing a word, and ten things only codecast does. Thirteen chapters, with the real product on every page.",
    author: "the codecast team",
    date: "2026-10-06",
    dateLabel: "October 6, 2026",
    readingMinutes: 4,
  },
  {
    slug: "fewer-bigger-jumps",
    cover: { src: "/blog/fewer-bigger-jumps/cover.png", alt: "Sixteen small hops against one coiled leap and three shrinking corrections" },
    title: "Fewer, bigger jumps",
    dek: "When you work with coding agents, tokens are cheap and your attention is not. Ask for a leap that lands near the goal, close the gap in shrinking corrections, and spend the time it buys on the next leap.",
    author: "the codecast team",
    date: "2026-10-04",
    dateLabel: "October 4, 2026",
    readingMinutes: 7,
  },
  {
    slug: "one-repository-twenty-checkouts",
    cover: { src: "/blog/one-repository-twenty-checkouts/cover.png", alt: "cast ws ls listing the repository's agent worktrees" },
    title: "One repository, twenty checkouts",
    dek: "Running several agents at once is easy until two of them edit the same file. Codecast gives each one its own worktree, with the env files, dependencies and a port of its own, in one command.",
    author: "the codecast team",
    date: "2026-10-04",
    dateLabel: "October 4, 2026",
    readingMinutes: 5,
  },
  {
    slug: "what-your-team-sees",
    cover: { src: "/blog/what-your-team-sees/page-top.png", alt: "The sharing page: what a team can see of your sessions" },
    title: "What your team sees",
    dek: "Sharing your Claude Code sessions with a team is a great idea right up to the session where you pasted a customer's data. Codecast answers with two dials, a dry run, and one command that shows the whole picture.",
    author: "the codecast team",
    date: "2026-09-24",
    dateLabel: "September 24, 2026",
    readingMinutes: 6,
  },
  {
    slug: "the-pull-request-that-knows-its-sessions",
    cover: { src: "/blog/the-pull-request-that-knows-its-sessions/pr-checks.png", alt: "A pull request in codecast with its checks and sessions" },
    title: "The pull request that knows its sessions",
    dek: "When agents write most of the code, a pull request is the end of a conversation you were not in. Codecast keeps the two attached: every PR carries its checks, its reviews, and the sessions that made it, and a review can wake the agent that owns it.",
    author: "the codecast team",
    date: "2026-09-17",
    dateLabel: "September 17, 2026",
    readingMinutes: 6,
  },
  {
    slug: "agents-that-talk-to-each-other",
    cover: { src: "/blog/agents-that-talk-to-each-other/message-card.png", alt: "A message card one agent sent another" },
    title: "Agents that talk to each other",
    dek: "A Claude Code agent shipped a change that silently stalled 27 transcripts. A Codex agent in the same checkout found it, fixed it, and told the first one. No human relayed a word.",
    author: "the codecast team",
    date: "2026-09-10",
    dateLabel: "September 10, 2026",
    readingMinutes: 6,
  },
  {
    slug: "a-url-for-everything-your-agent-makes",
    cover: { src: "/blog/a-url-for-everything-your-agent-makes/published-page.png", alt: "A page an agent published with cast publish" },
    title: "A URL for everything your agent makes",
    dek: "Reports, dashboards, design proposals — agents produce them daily, and chat transcripts bury them. cast publish turns a file into a live page with versions, comments, and a link you can actually send.",
    author: "the codecast team",
    date: "2026-08-30",
    dateLabel: "August 30, 2026",
    readingMinutes: 5,
  },
  {
    slug: "this-post-wrote-itself",
    cover: { src: "/blog/this-post-wrote-itself/trigger-card.png", alt: "The weekly trigger that wrote this blog" },
    title: "This post wrote itself (on a schedule)",
    dek: "Codecast triggers run full agent sessions on a timer. The proof is this blog: last week's post and this one were both written, unattended, by runs of the same weekly trigger.",
    author: "the codecast team",
    date: "2026-08-22",
    dateLabel: "August 22, 2026",
    readingMinutes: 5,
  },
  {
    slug: "your-agents-forget-your-team-does-not",
    cover: { src: "/blog/your-agents-forget-your-team-does-not/search.png", alt: "Search across the team's agent sessions" },
    title: "Your agents forget. Your team doesn't have to.",
    dek: "Every agent session is a problem being solved out loud, and then the terminal closes. Codecast keeps the record searchable — so the next agent, or the next person, starts from the answer.",
    author: "the codecast team",
    date: "2026-08-15",
    dateLabel: "August 15, 2026",
    readingMinutes: 5,
  },
  {
    slug: "an-inbox-for-your-agents",
    cover: { src: "/blog/an-inbox-for-your-agents/workspace-feed.png", alt: "The inbox of agent sessions, sorted by who needs you" },
    title: "An inbox for your agents",
    dek: "Agents don't fail loudly. They finish, or stall, and wait for you to notice. The inbox makes the waiting visible — every session, every machine, sorted by who needs you.",
    author: "the codecast team",
    date: "2026-08-08",
    dateLabel: "August 8, 2026",
    readingMinutes: 5,
  },
  {
    slug: "git-blame-for-ai-agents",
    cover: { src: "/blog/git-blame-for-ai-agents/cover.png", alt: "cast blame naming the session behind each line" },
    title: "git blame for AI agents",
    dek: "When an agent writes the line, the author column goes blank. cast blame fills it back in — with the conversation that wrote it.",
    author: "the codecast team",
    date: "2026-07-20",
    dateLabel: "July 20, 2026",
    readingMinutes: 6,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
