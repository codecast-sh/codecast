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
};

export const POSTS: BlogPost[] = [
  {
    slug: "a-url-for-everything-your-agent-makes",
    title: "A URL for everything your agent makes",
    dek: "Reports, dashboards, design proposals — agents produce them daily, and chat transcripts bury them. cast publish turns a file into a live page with versions, comments, and a link you can actually send.",
    author: "the codecast team",
    date: "2026-08-30",
    dateLabel: "August 30, 2026",
    readingMinutes: 5,
  },
  {
    slug: "this-post-wrote-itself",
    title: "This post wrote itself (on a schedule)",
    dek: "Codecast triggers run full agent sessions on a timer. The proof is this blog: last week's post and this one were both written, unattended, by runs of the same weekly trigger.",
    author: "the codecast team",
    date: "2026-08-22",
    dateLabel: "August 22, 2026",
    readingMinutes: 5,
  },
  {
    slug: "your-agents-forget-your-team-does-not",
    title: "Your agents forget. Your team doesn't have to.",
    dek: "Every agent session is a problem being solved out loud, and then the terminal closes. Codecast keeps the record searchable — so the next agent, or the next person, starts from the answer.",
    author: "the codecast team",
    date: "2026-08-15",
    dateLabel: "August 15, 2026",
    readingMinutes: 5,
  },
  {
    slug: "an-inbox-for-your-agents",
    title: "An inbox for your agents",
    dek: "Agents don't fail loudly. They finish, or stall, and wait for you to notice. The inbox makes the waiting visible — every session, every machine, sorted by who needs you.",
    author: "the codecast team",
    date: "2026-08-08",
    dateLabel: "August 8, 2026",
    readingMinutes: 5,
  },
  {
    slug: "git-blame-for-ai-agents",
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
