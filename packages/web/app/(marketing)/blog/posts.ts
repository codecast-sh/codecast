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
    slug: "an-inbox-for-your-agents",
    title: "An inbox for your agents",
    dek: "Agents don't fail loudly. They finish, or stall, and wait for you to notice. The inbox makes the waiting visible — every session, every machine, sorted by who needs you.",
    author: "the codecast team",
    date: "2026-08-08",
    dateLabel: "August 2026",
    readingMinutes: 5,
  },
  {
    slug: "git-blame-for-ai-agents",
    title: "git blame for AI agents",
    dek: "When an agent writes the line, the author column goes blank. cast blame fills it back in — with the conversation that wrote it.",
    author: "the codecast team",
    date: "2026-07-20",
    dateLabel: "July 2026",
    readingMinutes: 6,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
