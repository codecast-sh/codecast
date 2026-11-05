// The comparison registry's types and the codecast column every table shares,
// imported by comparisons.ts and the entry modules it assembles.

export interface ComparisonRow {
  dimension: string;
  codecast: string;
  competitor: string;
}

export interface ProsCons {
  pros: string[];
  cons: string[];
}

export interface DeepDive {
  heading: string;
  /** Plain paragraphs; one idea each. */
  paragraphs: string[];
  /** Labelled items rendered as a list under the paragraphs, for sections that enumerate. */
  points?: { label: string; text: string }[];
}

export interface Comparison {
  slug: string;
  /** Competitor product name as it renders in headings and the table column. */
  competitor: string;
  competitorUrl: string;
  title: string;
  dek: string;
  /** One factual sentence per product, rendered as the opening frame. */
  codecastIs: string;
  competitorIs: string;
  rows: ComparisonRow[];
  whenCompetitor: string[];
  whenCodecast: string[];
  /** How the two compose, when they genuinely do; omit when they don't. */
  together?: string;
  /** One-paragraph bottom line, rendered as a callout under the opening frame. */
  bottomLine?: string;
  /** Strengths and weaknesses of each product, rendered as two cards under the table. */
  strengths?: { codecast: ProsCons; competitor: ProsCons };
  /** Long-form sections for comparisons that need more than a table. */
  deepDives?: DeepDive[];
  /** ISO date the competitor's docs were last read; rendered so a reader knows how fresh the facts are. */
  verifiedOn?: string;
}

export const SHARED_ROWS = {
  model: {
    dimension: "Core model",
    codecast:
      "Records and steers every agent session you run, wherever you start it, from the history the agent already writes; a team layer is there when you want one",
  },
  agents: {
    dimension: "Agents supported",
    codecast:
      "Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok and Muse Spark, plus Cursor and Codex cloud agents",
  },
  team: {
    dimension: "Team visibility",
    codecast:
      "Every teammate's sessions in one feed and inbox, with per-directory privacy controls",
  },
  memory: {
    dimension: "Search & memory",
    codecast:
      "Full-text search across all past sessions; agents query team history themselves (cast search / cast ask)",
  },
  blame: {
    dimension: "Line-level attribution",
    codecast: "cast blame traces any line of code to the conversation that wrote it",
  },
  remote: {
    dimension: "Remote steering",
    codecast:
      "Web, macOS desktop and iOS apps; send messages into a live terminal session and answer permission prompts from any device",
  },
  oss: {
    dimension: "Open source",
    codecast: "MIT, with a backend you can host yourself",
  },
} as const;
