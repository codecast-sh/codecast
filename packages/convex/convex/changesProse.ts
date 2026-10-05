// Prose for the Changes page (docs/proposals/changes-page.md 7.4, 7.5, 7.8).
// Layer 0 (changes.ts) writes every story and edition with deterministic text
// first; this module replaces it with model prose once a story has settled,
// then writes the day's edition from the stories. rebuildDay
// (changesSchedule.ts) runs it after each build, so a page view never spends
// tokens.
//
// Prompts read sessions only through teamVisibleInputs(), checked again when
// the reply is written: a session that narrowed or went private while the call
// was out takes the reply with it. Every call adds its tokens and dollars to
// the row it wrote, and a team day stops calling once its rows have spent the
// daily cap; the deterministic text then stays.
//
// The request builders and reply parsers are pure and exported, so the evals
// (packages/evals) replay exactly what prod sends. A change to the story
// prompt bumps STORY_PROMPT_VERSION in changes.ts, which moves every story's
// inputs_hash; a change to the edition prompt bumps EDITION_PROMPT_VERSION.

import { v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  DEK_MAX,
  HEADLINE_MAX,
  areaOf,
  cleanSubject,
  clip,
  clipToSentence,
  splitArea,
  fitProse,
  splitSentences,
  hash64,
  subjectKind,
  type ChangeCommit,
  type ChangeKind,
} from "@codecast/shared/changes";
import { callModel, modelCost, parseJsonBlock, type SurfaceRequest } from "./lib/anthropic";
import { PROSE_MODEL } from "./lib/changesProseModel";
import { teamVisibleInputs, teamVisibleMedia, type ChangesInputMode, type ChangesMedia } from "./lib/changesAccess";
import { changesZone, markDayDirty } from "./lib/changesDirty";
import { teamDayBounds } from "./lib/teamDay";
import { normalizeRepository } from "./lib/gitRefs";
import { hasEditionProse, projectCommit } from "./changes";

export const EDITION_PROMPT_VERSION = "edition-3";

/** A story is written once no commit has joined it for this long, or once its day has ended (spec 7.4). */
export const SETTLE_MS = 20 * 60_000;
/** A live day's edition is rewritten at most this often; after the day ends it is written once more as final. */
export const EDITION_INTERVAL_MS = 60 * 60_000;
/** What one team day's prose may spend, stories and editions together (spec 7.8). */
export const DAILY_CAP_USD = 2;
export { PROSE_MODEL };
/** Story calls in flight at once. */
const STORY_PARALLEL = 8;

// The strong model thinks before it answers and its thinking counts toward
// max_tokens, so the caps leave room for it; only tokens used are billed.
const STORY_MAX_TOKENS = 4000;
const EDITION_MAX_TOKENS = 8000;
const STORY_TIMEOUT_MS = 120_000;
const EDITION_TIMEOUT_MS = 180_000;
/** A prose pass starts no new story batch after this long, so the action stays inside Convex's 10 minutes; the rest go to the next run. */
export const PROSE_WALL_MS = 5 * 60_000;

/** Story prompt inputs (spec 7.4). */
const PROMPT_COMMITS = 12;
const PROMPT_PATHS = 8;
/** A pull request's description is often a squash merge's only account of why: room for the whole argument, not its opening. */
const PR_BODY_CHARS = 2400;
const PROMPT_TURNS = 8;
const ASK_CHARS = 300;
const DID_CHARS = 160;
/** A risk line keeps the whole sentences that fit this. */
const RISK_LINE_CHARS = 320;
/** The article a story opens to: words the prompt asks for, and the characters a reply is cut to. */
const BODY_WORDS = 250;
export const BODY_CHARS = 3200;
/** A single fix or feature commit with a subject this long already reads as a headline (the skip path). */
export const SKIP_SUBJECT_CHARS = 60;

/** Edition prompt inputs (spec 7.5). */
const EDITION_STORIES = 80;
const EDITION_BRANCHES = 10;
const EDITION_BLOCKED = 5;
export const EDITION_HEADLINE_MAX = 110;
/** What the prompts ask for; the MAX values are only the clip for a reply that runs over. */
const HEADLINE_TARGET = 60;
const DEK_TARGET = 80;
const EDITION_HEADLINE_TARGET = 80;
/** How far past its target an edition or week headline may run before it is cut back to a clause. */
export const HEADLINE_SLACK = 40;
/** The same allowance for a story headline. */
const STORY_HEADLINE_HARD = HEADLINE_MAX + 30;
export const STANDFIRST_WORDS = 60;

/** Commits per read: a commit someone opened on /commit carries its patches. */
const COMMIT_READ_CHUNK = 8;

const KINDS: readonly ChangeKind[] = ["feature", "fix", "perf", "infra", "docs", "test", "release", "revert"];

export type WhySource = "session" | "commit" | "pr" | "none";

// ── Story prompt ─────────────────────────────────────────────────────────

export type StoryPromptCommit = {
  sha: string;
  subject: string;
  body?: string;
  insertions: number;
  deletions: number;
  /** Set when only these areas of a larger commit belong to the story. */
  partial?: string[];
};

export type StoryPromptSession = {
  headline?: string;
  summary: string;
  /** Present only for a session the team sees at `full`. */
  turns?: Array<{ ask: string; did: string[] }>;
};

/** A screenshot the story may place, by ref; its URL stays out of the prompt. */
export type StoryPromptImage = { ref: string; at: string; context: string; origin?: string };

/** An edit to instruction text (a prompt, a skill, an agent guide) from a session the team sees in full. */
export type StoryPromptEdit = { path: string; before: string; after: string };

/** Everything the story prompt reads, as plain data: what the evals freeze and replay. */
export type StoryPromptInput = {
  area: string;
  branch: string;
  /** Largest first, at most 12. */
  commits: StoryPromptCommit[];
  /** Commits in the story beyond those shown. */
  more_commits: number;
  areas: Array<{ area: string; files: number; insertions: number; deletions: number }>;
  top_paths: string[];
  release: { surface: string; version?: string; sha: string } | null;
  prs: Array<{ number: number; title: string; body: string }>;
  sessions: StoryPromptSession[];
  risks: Array<{ code: string; evidence: string[] }>;
  images: StoryPromptImage[];
  /** Ref to URL for `images`: never rendered into the prompt, read by the parser to place them. */
  image_urls: Record<string, string>;
  edits: StoryPromptEdit[];
  /** Pages and canvases the sessions made, by ref (page1, canvas1). */
  embeds: Array<{ ref: string; kind: "page" | "canvas"; title: string }>;
  /** Ref to what an `embed:` line becomes: a page URL, or a canvas's whole block. Never rendered into the prompt. */
  embed_blocks: Record<string, string>;
};

/** The story facts the prompt is built from: a change_stories row, narrowed. */
export type StoryFacts = Pick<
  Doc<"change_stories">,
  "area" | "branch" | "commit_shas" | "area_counts" | "release" | "risks"
>;

/** A session that passed the gate when the prompt was built. */
export type GatedSession = {
  conversation_id: Id<"conversations">;
  mode: ChangesInputMode;
  outcome_type: string | null;
  headline?: string;
  summary: string;
  turns?: Array<{ ask: string; did: string[] }>;
  /** Only for a session the team sees in full (changesAccess.teamVisibleMedia). */
  media?: ChangesMedia;
};

const shortSha = (s: string) => (/^[0-9a-f]{40}$/i.test(s) ? s.slice(0, 9) : s);

/** The first turns carry what was asked for and the last ones what landed; the middle goes when there are too many. */
function pickTurns(turns: ReadonlyArray<{ ask: string; did: string[] }>): Array<{ ask: string; did: string[] }> {
  const kept = turns.length <= PROMPT_TURNS ? turns : [...turns.slice(0, 2), ...turns.slice(turns.length - (PROMPT_TURNS - 2))];
  return kept.map((t) => ({ ask: clip(t.ask, ASK_CHARS), did: t.did.map((d) => clip(d, DID_CHARS)) }));
}

/**
 * The commit's areas as the story names them: layer 0 may have split the day's
 * dominant area into its subareas (narrowAreas), so an area the story lacks is
 * split the same way when that names areas the story has.
 */
function storyAreasOf(c: ChangeCommit, storyAreas: ReadonlySet<string>): ChangeCommit {
  let out = c;
  for (const a of Object.keys(c.areas)) {
    if (storyAreas.has(a)) continue;
    const split = splitArea(out, a);
    if (split !== out && Object.keys(split.areas).some((k) => !(k in out.areas) && storyAreas.has(k))) out = split;
  }
  return out;
}

/** A commit's share of a story: the whole commit, or the story's areas of it when it touched others too. Takes the commit as storyAreasOf names its areas. */
function commitShare(c: ChangeCommit, storyAreas: ReadonlySet<string>): StoryPromptCommit {
  const areas = Object.keys(c.areas);
  const inStory = areas.filter((a) => storyAreas.has(a));
  const partial = areas.length > 0 && inStory.length < areas.length;
  const lines = partial
    ? inStory.reduce((n, a) => ({ i: n.i + c.areas[a].insertions, d: n.d + c.areas[a].deletions }), { i: 0, d: 0 })
    : { i: c.insertions, d: c.deletions };
  return {
    sha: shortSha(c.sha),
    subject: c.subject,
    ...(c.body ? { body: c.body } : {}),
    insertions: lines.i,
    deletions: lines.d,
    ...(partial ? { partial: inStory } : {}),
  };
}

/**
 * The story prompt's input from the row, its commits (as layer 0 projects
 * them), the sessions that pass the gate now, and its pull requests. A blocked
 * risk's evidence names sessions by id; it is worded from their headlines.
 */
export function storyPromptInput(
  story: StoryFacts,
  commits: readonly ChangeCommit[],
  sessions: readonly GatedSession[],
  prs: ReadonlyArray<{ number: number; title: string; body: string }>,
): StoryPromptInput {
  const storyAreas = new Set(Object.keys(story.area_counts));
  const wanted = new Set(story.commit_shas);
  const shares = commits
    .filter((c) => wanted.has(c.sha))
    .map((raw) => storyAreasOf(raw, storyAreas))
    .map((c) => ({ c, share: commitShare(c, storyAreas) }))
    .sort((a, b) => b.share.insertions + b.share.deletions - (a.share.insertions + a.share.deletions) || a.c.timestamp - b.c.timestamp || a.c.sha.localeCompare(b.c.sha));

  const areas = Object.entries(story.area_counts).map(([area, files]) => {
    let insertions = 0;
    let deletions = 0;
    for (const { c } of shares) {
      insertions += c.areas[area]?.insertions ?? 0;
      deletions += c.areas[area]?.deletions ?? 0;
    }
    return { area, files, insertions, deletions };
  });
  const paths: string[] = [];
  for (const { c } of shares) {
    for (const p of c.top_paths ?? []) if (storyAreas.has(areaOf(p)) && !paths.includes(p)) paths.push(p);
  }

  const headlineOf = new Map(sessions.map((s) => [String(s.conversation_id), s.headline || s.summary]));
  const risks = story.risks.map((r) => ({
    code: r.code,
    evidence: r.code === "blocked"
      ? r.evidence.map((id) => headlineOf.get(id)).filter((h): h is string => !!h).map((h) => `a session reports it is blocked: ${clip(h, 160)}`)
      : r.evidence.map(shortSha),
  }));

  return {
    area: story.area,
    branch: story.branch,
    commits: shares.slice(0, PROMPT_COMMITS).map((s) => s.share),
    more_commits: Math.max(0, shares.length - PROMPT_COMMITS),
    areas,
    top_paths: paths.slice(0, PROMPT_PATHS),
    release: story.release ? { surface: story.release.surface, ...(story.release.version ? { version: story.release.version } : {}), sha: shortSha(story.release.sha) } : null,
    prs: prs.map((p) => ({ number: p.number, title: p.title, body: clipToSentence(p.body ?? "", PR_BODY_CHARS) })),
    sessions: sessions.map((s) => ({
      ...(s.headline ? { headline: s.headline } : {}),
      summary: s.summary,
      ...(s.mode === "full" && s.turns?.length ? { turns: pickTurns(s.turns) } : {}),
    })),
    risks,
    ...storyMedia(sessions),
  };
}

const PROMPT_IMAGES = 6;
const PROMPT_EDITS = 3;
const PROMPT_EMBEDS = 4;

/** The sessions' images, oldest first and numbered, with their URLs aside; and their instruction edits, largest first. */
function storyMedia(sessions: readonly GatedSession[]): Pick<StoryPromptInput, "images" | "image_urls" | "edits" | "embeds" | "embed_blocks"> {
  const full = sessions.filter((s) => s.mode === "full" && s.media);
  const found = full.flatMap((s) => s.media!.images).sort((a, b) => a.timestamp - b.timestamp).slice(-PROMPT_IMAGES);
  const images: StoryPromptImage[] = [];
  const image_urls: Record<string, string> = {};
  found.forEach((img, i) => {
    const ref = `img${i + 1}`;
    images.push({ ref, at: new Date(img.timestamp).toISOString().slice(0, 16).replace("T", " "), context: img.context, ...(img.origin ? { origin: img.origin } : {}) });
    image_urls[ref] = img.url;
  });
  const edits = full
    .flatMap((s) => s.media!.edits)
    .sort((a, b) => b.before.length + b.after.length - (a.before.length + a.after.length))
    .slice(0, PROMPT_EDITS)
    .map((e) => ({ path: e.path, before: e.before, after: e.after }));
  const embeds: StoryPromptInput["embeds"] = [];
  const embed_blocks: Record<string, string> = {};
  const counts = { page: 0, canvas: 0 };
  for (const a of full.flatMap((s) => s.media!.artifacts ?? []).sort((x, y) => x.timestamp - y.timestamp).slice(-PROMPT_EMBEDS)) {
    const ref = `${a.kind}${++counts[a.kind]}`;
    embeds.push({ ref, kind: a.kind, title: a.title || (a.kind === "page" ? "a published page" : "a canvas") });
    embed_blocks[ref] = a.kind === "page" ? a.url : a.block;
  }
  return { images, image_urls, edits, embeds, embed_blocks };
}

/** The sources a story's why may name: only inputs the story actually has. */
export function allowedWhySources(input: Pick<StoryPromptInput, "sessions" | "prs">): WhySource[] {
  return [...(input.sessions.length ? ["session" as const] : []), "commit", ...(input.prs.length ? ["pr" as const] : []), "none"];
}

const STORY_SYSTEM = `You write one story for a team's Changes page, a daily edition of what the team shipped. Your reader is a teammate who was not there: they know the product but not this work, and they trust the page because it reports only what its sources say. You write like a careful reporter: what changed, plainly, and the reason only when a source gives one. Answer with one JSON object and nothing else.`;

/** "a", "a and b", "a, b and c". */
const listed = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const indent = (text: string, pad = "    ") => text.split("\n").map((l) => pad + l).join("\n");

function renderStoryInput(i: StoryPromptInput): string {
  const out: string[] = [];
  out.push(`Area: ${i.area}. Branch: ${i.branch}.`);
  if (i.release) out.push(`Shipped in: ${i.release.surface}${i.release.version ? ` ${i.release.version}` : ""} (${i.release.sha}).`);

  out.push("", "Commits, largest first:");
  for (const c of i.commits) {
    out.push(`- ${c.sha} +${c.insertions} -${c.deletions} ${c.subject}`);
    if (c.partial) out.push(`    Only its ${listed(c.partial)} ${c.partial.length === 1 ? "part belongs" : "parts belong"} to this story; other stories tell the rest.`);
    if (c.body) out.push(indent(c.body));
  }
  if (i.more_commits) out.push(`- and ${i.more_commits} smaller ${i.more_commits === 1 ? "commit" : "commits"}`);

  out.push("", "Files by area:");
  for (const a of i.areas) out.push(`- ${a.area}: ${a.files} ${a.files === 1 ? "file" : "files"}, +${a.insertions} -${a.deletions}`);
  if (i.top_paths.length) out.push("", "Largest files:", ...i.top_paths.map((p) => `- ${p}`));

  if (i.prs.length) {
    out.push("", "Pull requests:");
    for (const p of i.prs) {
      out.push(`- #${p.number} ${p.title}`);
      if (p.body.trim()) out.push(indent(p.body.trim()));
    }
  }

  if (i.sessions.length) {
    out.push("", "Notes from the agent sessions that did this work:");
    for (const s of i.sessions) {
      out.push(`- ${s.headline ?? "Session"}`);
      out.push(indent(s.summary));
      for (const t of s.turns ?? []) {
        out.push(`    Asked: ${t.ask}`);
        if (t.did.length) out.push(`    Did: ${t.did.join("; ")}`);
      }
    }
  }

  if (i.edits.length) {
    out.push("", "Edits the sessions made to instruction text (prompts, skills, agent guides), before and after:");
    for (const e of i.edits) {
      out.push(`- ${e.path}`, "    Before:", indent(e.before || "(new text)", "      "), "    After:", indent(e.after, "      "));
    }
  }

  if (i.embeds.length) {
    out.push("", "Pages and canvases the sessions made, by ref:");
    for (const e of i.embeds) out.push(`- ${e.ref} (${e.kind}): ${e.title}`);
  }

  if (i.images.length) {
    out.push("", "Screenshots from the sessions, by ref, with the words around each:");
    for (const img of i.images) out.push(`- ${img.ref} (${[img.at, img.origin].filter(Boolean).join(", ")}): ${img.context || "(no words around it)"}`);
  }

  if (i.risks.length) {
    out.push("", "Risks the page flags on this story:");
    for (const r of i.risks) out.push(`- ${r.code}${r.evidence.length ? `: ${r.evidence.join(", ")}` : ""}`);
  }
  return out.join("\n");
}

/** The story request prod posts. */
export function storyRequest(input: StoryPromptInput): SurfaceRequest {
  const sources = allowedWhySources(input);
  const riskCodes = input.risks.map((r) => r.code);
  const prompt = `${renderStoryInput(input)}

Write the story of this work.

- A teammate scans a day of these in a minute and opens the ones they want to understand. The headline and dek are the scan: the fewest plain words that carry the change. The body is for the reader who opened the story: say everything worth knowing about the change, densely, and nothing else.
- Tell it at the level of the product: what a user or teammate now sees, can do, or gets that they did not before. For engineering work, what now works differently for the people building the product, still told as behavior and not as files, functions or mechanics.
- The story is the change and its effect, not how the work was done: leave out how it was built, tested, reviewed, verified or rolled out.
- A reason is anything that says why the change was made or what it is for: a purpose, a benefit, a problem it solves, any "to ...", "so that ..." or "making it easier to ..." clause. Give one only when an input states it, and set why_source to the input it came from: ${sources.map((s) => `"${s}"`).join(", ")}. When no input states one, set why_source to "none" and write no reason anywhere: not in the headline, the dek or the body.
- Use only what the inputs say, and write as someone who knows the change: never about the inputs themselves or what they leave out. Name no person or session the inputs do not name, and copy ids such as jx7c6zk, ct-1234 and #412 exactly as written.
${riskCodes.length ? `- For each flagged risk (${riskCodes.join(", ")}), write one plain line telling a teammate what to watch, keyed by its code in risk_lines. The page shows these lines under the body, so the body leaves them out.\n` : ""}- No em dashes.

Fields:
- headline: what changed, in sentence case, short enough to read at a glance (aim for under ${HEADLINE_TARGET} characters).
- dek: one short line, not a summary of the work (aim for under ${DEK_TARGET} characters): the stated reason when there is one, otherwise the one fact the headline most needs; "" when the headline says it all. Further detail belongs in the body.
- body: markdown, "" when the headline and dek say it all, and never repeating them. A short article, at most about ${BODY_WORDS} words:
  - When the work has distinct parts, give each a short "###" heading that names the part; a single change reads as plain paragraphs, with no headings.
  - Place a screenshot where it shows the change, as ![what it shows](img1) with a ref from the list and a caption a reader can take in without the image. A screenshot earns its place by showing the product as its users see it, or a result the words cannot carry; a terminal, a log or code shows the reader nothing new. Use only listed refs.
  - When a session made a page or a canvas that shows the work better than words can (a report, a comparison, a diagram), embed it on a line of its own as embed: page1, after a sentence saying what it shows.
  - When the work changes how an agent behaves (an edit to a prompt, a skill or an agent guide), say what the agent now does differently, quote the instruction briefly as it read before and after, and give any measured result an input states.
- kind: one of ${KINDS.join(", ")}.
- importance: 1 to 5, how much a teammate needs to know this today. 5 is a change everyone will notice, 1 is housekeeping.
- why_source: as above.
- risk_lines: ${riskCodes.length ? "an object from risk code to its line" : "{}"}.

{"headline": "...", "dek": "...", "body": "...", "kind": "...", "importance": 3, "why_source": "...", "risk_lines": {}}`;
  return { model: PROSE_MODEL, max_tokens: STORY_MAX_TOKENS, system: STORY_SYSTEM, prompt };
}

export type StoryProse = {
  headline: string;
  dek: string;
  body?: string;
  kind: ChangeKind;
  importance: number;
  why_source: WhySource;
  risk_lines?: Record<string, string>;
};

export const str = (x: unknown): string => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");

/** At most `n` sentences. */
export function sentences(text: string, n: number): string {
  return splitSentences(text).slice(0, n).join(" ");
}

/** The leading whole sentences that fit `max` chars, never a partial one: "" when the first alone is longer. */
export function sentencesWithin(text: string, max: number): string {
  let out = "";
  for (const s of splitSentences(text)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * A story's article as the page shows it: its markdown kept, each screenshot
 * placed by ref swapped for the image it names, any other image dropped (a
 * reply can only show what the server offered), and a reply that runs long
 * cut at the last paragraph that fits.
 */
export function articleBody(raw: unknown, urls: Readonly<Record<string, string>>, embeds: Readonly<Record<string, string>> = {}): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\r\n?/g, "\n").replace(MD_IMAGE, (_m, alt: string, src: string) => (urls[src] ? `![${alt.trim()}](${urls[src]})` : ""));
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > BODY_CHARS) {
    const cut = text.lastIndexOf("\n\n", BODY_CHARS);
    text = (cut > 0 ? text.slice(0, cut) : sentences(text.slice(0, BODY_CHARS), 99)).trim();
  }
  // Embeds go in after the cut: a canvas is a figure, not words the limit counts.
  return text
    .replace(/^embed:\s*([a-z]+\d+)\s*$/gm, (_m, ref: string) => (embeds[ref] ? `\n${embeds[ref]}\n` : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The story a reply describes, held to its schema: lengths clipped, enums
 * checked. A reply that is not JSON, has no headline, or names a why source
 * the story does not have is unusable, and the deterministic text stays.
 */
export function parseStoryReply(text: string, input: Pick<StoryPromptInput, "sessions" | "prs" | "risks"> & Partial<Pick<StoryPromptInput, "image_urls" | "embed_blocks">>, fallback: { kind: string; importance: number }): StoryProse | null {
  const raw = parseJsonBlock(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const headline = fitProse(str(r.headline), HEADLINE_MAX, STORY_HEADLINE_HARD);
  const why = str(r.why_source) as WhySource;
  if (!headline || !allowedWhySources(input).includes(why)) return null;

  const kind = KINDS.includes(str(r.kind) as ChangeKind) ? (str(r.kind) as ChangeKind) : (KINDS.includes(fallback.kind as ChangeKind) ? fallback.kind as ChangeKind : "infra");
  const n = typeof r.importance === "number" ? Math.round(r.importance) : NaN;
  const importance = n >= 1 && n <= 5 ? n : fallback.importance;
  const body = articleBody(r.body, input.image_urls ?? {}, input.embed_blocks ?? {});
  const codes = new Set(input.risks.map((x) => x.code));
  const lines = r.risk_lines && typeof r.risk_lines === "object" && !Array.isArray(r.risk_lines)
    ? Object.fromEntries(Object.entries(r.risk_lines as Record<string, unknown>)
      .filter(([code]) => codes.has(code))
      // A line too long to keep one whole sentence is dropped, and the risk shows by its code.
      .map(([code, line]) => [code, sentencesWithin(str(line), RISK_LINE_CHARS)])
      .filter(([, line]) => line))
    : {};
  return {
    headline,
    dek: fitProse(str(r.dek), DEK_MAX, DEK_MAX + HEADLINE_SLACK),
    ...(body ? { body } : {}),
    kind,
    importance,
    why_source: why,
    ...(Object.keys(lines).length ? { risk_lines: lines } : {}),
  };
}

// ── Story rules: skip, settle ────────────────────────────────────────────

/**
 * The skip path (spec 7.4): a story of one whole fix or feature commit with no
 * session, whose subject is already a sentence, takes the subject as its
 * headline with no call. A slice of a batch commit never does: its subject
 * describes the whole batch. Neither does a subject that lists several changes
 * or would have to be clipped to fit.
 */
export function skipHeadline(story: Pick<Doc<"change_stories">, "commit_shas" | "conversation_ids" | "area_counts">, commits: readonly ChangeCommit[]): string | null {
  if (story.commit_shas.length !== 1 || story.conversation_ids.length) return null;
  const c = commits.find((x) => x.sha === story.commit_shas[0]);
  if (!c || Object.keys(c.areas).some((a) => !(a in story.area_counts))) return null;
  const kind = subjectKind(c.subject);
  const cleaned = cleanSubject(c.subject);
  if (kind !== "fix" && kind !== "feature") return null;
  return cleaned.length >= SKIP_SUBJECT_CHARS && cleaned.length <= HEADLINE_MAX && namesOneChange(cleaned) ? cleaned : null;
}

/** A subject that lists several changes ("a, b; c") is a batch summary, not a headline. */
function namesOneChange(subject: string): boolean {
  return !/[;,]\s/.test(subject);
}

/** When a story may be written: 20 minutes after its last commit, or when its day ends, whichever is first. */
export function settlesAt(story: Pick<Doc<"change_stories">, "last_at">, dayEnd: number): number {
  return Math.min(story.last_at + SETTLE_MS, dayEnd);
}

// ── Edition prompt ───────────────────────────────────────────────────────

export type EditionStory = {
  /** A short ref (s1, s2) the reply names stories by; mapped back to story keys. */
  key: string;
  area: string;
  kind: string;
  importance: number;
  headline: string;
  dek: string;
  insertions: number;
  deletions: number;
  release?: string;
  authors: number;
  sessions: number;
  risks: string[];
};

/** Everything the edition prompt reads, as plain data. Built only from story text and facts. */
export type EditionPromptInput = {
  date: string;
  stats: { commits: number; stories: number; releases: number; people: number; sessions: number } | null;
  releases: Array<{ surface: string; version?: string; sha: string; time: string }>;
  /** Default-branch stories, most important first, at most 80. */
  stories: EditionStory[];
  /** Work on other branches, as counts. */
  branches: Array<{ branch: string; commits: number; area: string }>;
  /** Headlines of team-visible sessions on today's stories that report being blocked. */
  blocked: string[];
};

const releaseName = (r: { surface: string; version?: string; sha: string }) => `${r.surface} ${r.version ?? shortSha(r.sha)}`;


const EDITION_SYSTEM = `You are the editor of a team's Changes page, a daily edition of what the team shipped and why, read by everyone on the team in about a minute and a half. You are given the day's stories, already written, and the day's facts. You decide what the day was about and how it reads. Answer with one JSON object and nothing else.`;

function renderEditionInput(i: EditionPromptInput): string {
  const out: string[] = [`Day: ${i.date}.`];
  if (i.stats) out.push(`${i.stats.commits} commits, ${i.stats.stories} stories, ${i.stats.releases} releases, ${i.stats.people} people, ${i.stats.sessions} team-visible sessions.`);
  if (i.releases.length) out.push("", "Releases and deploys:", ...i.releases.map((r) => `- ${releaseName(r)} at ${r.time}`));
  out.push("", "Stories:");
  for (const s of i.stories) {
    const facts = [s.area, s.kind, `importance ${s.importance}`, `+${s.insertions} -${s.deletions}`];
    if (s.release) facts.push(`shipped in ${s.release}`);
    facts.push(`${s.authors} ${s.authors === 1 ? "author" : "authors"}`, `${s.sessions} ${s.sessions === 1 ? "session" : "sessions"}`);
    if (s.risks.length) facts.push(`risks: ${s.risks.join(", ")}`);
    out.push(`- ${s.key} [${facts.join("; ")}] ${s.headline}`);
    if (s.dek) out.push(`    ${s.dek}`);
  }
  if (i.branches.length) out.push("", "Other branches with commits today:", ...i.branches.map((b) => `- ${b.branch}: ${b.commits} ${b.commits === 1 ? "commit" : "commits"}, mostly ${b.area}`));
  if (i.blocked.length) out.push("", "Blocked work:", ...i.blocked.map((h) => `- ${h}`));
  return out.join("\n");
}

/** The edition request prod posts. */
export function editionRequest(input: EditionPromptInput): SurfaceRequest {
  const prompt = `${renderEditionInput(input)}

Edit this day into an edition.

- The headline is the day in one short, plain sentence: the change that mattered most. It is a headline, not an inventory, so it does not string areas, releases or topics together, and it does not restate a story's own headline word for word. Sentence case, aim for under ${EDITION_HEADLINE_TARGET} characters.
- The lead is the one story a teammate most needs to read today, by its key.
- brief_story_keys lists the stories that are housekeeping (docs, tests, chores, small fixes) and read best as one line each.
- Say only what the stories and facts say. Give no reason a story does not give, name no one the stories do not name, and copy ids such as jx7c6zk and #412 exactly.
- No em dashes.

{"edition_headline": "...", "lead_story_key": "s1", "brief_story_keys": ["..."]}`;
  return { model: PROSE_MODEL, max_tokens: EDITION_MAX_TOKENS, system: EDITION_SYSTEM, prompt };
}

export type EditionProse = {
  headline: string;
  standfirst: string;
  lead_story_key: string;
  section_order: string[];
  brief_story_keys: string[];
};

/** At most `n` words, ending on a sentence when one fits. */
function words(text: string, n: number): string {
  const w = text.split(" ").filter(Boolean);
  if (w.length <= n) return text;
  const cut = w.slice(0, n).join(" ");
  const end = cut.search(/[.!?][^.!?]*$/);
  return end > 0 ? cut.slice(0, end + 1) : `${cut}…`;
}

/**
 * The edition a reply describes, with refs mapped back to story keys. Areas
 * and keys the input does not have are dropped; areas the reply left out
 * follow in the input's order. No headline or no known lead is unusable.
 */
export function parseEditionReply(text: string, input: EditionPromptInput, keyOf: Record<string, string>): EditionProse | null {
  const raw = parseJsonBlock(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const headline = fitProse(str(r.edition_headline), EDITION_HEADLINE_MAX, EDITION_HEADLINE_MAX + HEADLINE_SLACK);
  const lead = keyOf[str(r.lead_story_key)];
  if (!headline || !lead) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
  const areas = [...new Set(input.stories.map((s) => s.area))];
  const ordered = [...new Set(list(r.section_order).filter((a) => areas.includes(a)))];
  const brief = [...new Set(list(r.brief_story_keys).map((k) => keyOf[k]).filter((k): k is string => !!k && k !== lead))];
  return {
    headline,
    standfirst: words(str(r.standfirst), STANDFIRST_WORDS),
    lead_story_key: lead,
    section_order: [...ordered, ...areas.filter((a) => !ordered.includes(a))],
    brief_story_keys: brief,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────

/** What one team day's prose has spent so far: every story and edition row of that date, all repositories. */
export const spentOn = internalQuery({
  args: { team_id: v.id("teams"), date: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const stories = await ctx.db
      .query("change_stories")
      .withIndex("by_team_date", (q) => q.eq("team_id", args.team_id).eq("date", args.date))
      .collect();
    const editions = await ctx.db
      .query("digests")
      .withIndex("by_team_scope_date", (q) => q.eq("team_id", args.team_id).eq("scope", "day").eq("date", args.date))
      .collect();
    return [...stories, ...editions].reduce((n, row) => n + (row.cost_usd ?? 0), 0);
  },
});

async function gatedSessions(
  ctx: { db: any; storage?: any },
  teamId: Id<"teams">,
  ids: readonly Id<"conversations">[],
  mediaWindow?: { since: number; until: number },
): Promise<GatedSession[]> {
  const gate = await teamVisibleInputs(ctx, teamId, ids);
  const media = mediaWindow ? await teamVisibleMedia(ctx, [...gate.values()], mediaWindow) : new Map<string, ChangesMedia>();
  const out: GatedSession[] = [];
  for (const id of ids) {
    const input = gate.get(String(id));
    if (!input?.insight) continue;
    out.push({
      conversation_id: input.conversation_id,
      mode: input.mode,
      outcome_type: input.insight.outcome_type ?? null,
      ...(input.insight.headline ? { headline: input.insight.headline } : {}),
      summary: input.insight.summary,
      ...(input.insight.turns ? { turns: input.insight.turns } : {}),
      ...(media.has(String(id)) ? { media: media.get(String(id))! } : {}),
    });
  }
  return out;
}

/** How far around a story's commits its sessions' screenshots and edits count as its own. */
const MEDIA_MARGIN_MS = 6 * 60 * 60 * 1000;

export type StoryRead = {
  story: Doc<"change_stories">;
  sessions: GatedSession[];
  prs: Array<{ number: number; title: string; body: string }>;
};

/**
 * What one team day's stories were offered and what their articles placed:
 * per story, the gated sessions by mode, the screenshots, instruction edits
 * and embeds storyMedia would hand the prompt, and the images and embeds the
 * written body holds. Read-only, for measuring the media path.
 */
export const mediaAudit = internalQuery({
  args: { team_id: v.id("teams"), date: v.string() },
  handler: async (ctx, args) => {
    const stories: Doc<"change_stories">[] = await ctx.db
      .query("change_stories")
      .withIndex("by_team_date", (q) => q.eq("team_id", args.team_id).eq("date", args.date))
      .take(80);
    const out = [];
    for (const story of stories) {
      if (!story.on_default_branch) continue;
      const sessions = await gatedSessions(ctx, story.team_id, story.conversation_ids, { since: story.first_at - MEDIA_MARGIN_MS, until: story.last_at + MEDIA_MARGIN_MS });
      const media = storyMedia(sessions);
      const body = story.body ?? "";
      out.push({
        key: story.story_key,
        headline: story.headline,
        sessions: story.conversation_ids.length,
        gated: sessions.map((x) => x.mode),
        offered: { images: media.images.length, edits: media.edits.length, embeds: media.embeds.length },
        contexts: media.images.map((i) => i.context),
        embeds: media.embeds.map((e) => `${e.ref}: ${e.title}`),
        placed: { images: (body.match(/!\[/g) ?? []).length, embeds: (body.match(/```cast-canvas|codecast\.sh\/a\//g) ?? []).length },
      });
    }
    return out;
  },
});

/** A pending story with the sessions that pass the gate now and its pull requests; null once it is no longer pending. */
export const readStory = internalQuery({
  args: { story_id: v.id("change_stories") },
  handler: async (ctx, args): Promise<StoryRead | null> => {
    const story = await ctx.db.get(args.story_id);
    if (!story || story.prose_status !== "pending") return null;
    const sessions = await gatedSessions(ctx, story.team_id, story.conversation_ids, { since: story.first_at - MEDIA_MARGIN_MS, until: story.last_at + MEDIA_MARGIN_MS });
    const prs: StoryRead["prs"] = [];
    for (const prId of story.pr_ids) {
      const pr = await ctx.db.get(prId);
      if (pr && String(pr.team_id) === String(story.team_id)) prs.push({ number: pr.number, title: pr.title, body: clipToSentence(pr.body ?? "", PR_BODY_CHARS) });
    }
    return { story, sessions, prs };
  },
});

/** The team's commits in this repository among `shas`, as layer 0 projects them. */
export const readCommits = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), shas: v.array(v.string()) },
  handler: async (ctx, args): Promise<ChangeCommit[]> => {
    const repository = normalizeRepository(args.repository);
    const out: ChangeCommit[] = [];
    for (const sha of new Set(args.shas)) {
      const rows = await ctx.db.query("commits").withIndex("by_sha", (q) => q.eq("sha", sha)).take(10);
      const row = rows.find((c) => String(c.team_id) === String(args.team_id) && normalizeRepository(c.repository) === repository);
      if (row) out.push(projectCommit(row));
    }
    return out;
  },
});

const minutes = (t: number, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone }).format(new Date(t));

export type EditionLoad = {
  input: EditionPromptInput;
  /** Ref (s1) to story_key. */
  keys: Record<string, string>;
  model: string;
  hash: string;
};

/**
 * The edition prompt's input for a team day, read from the stories and the
 * edition's facts. Null when no story landed on the default branch. Runs in
 * the read before the call and again in the write after it, so an edition is
 * written only over the stories it was asked about.
 */
export async function loadEditionInput(ctx: { db: any }, teamId: Id<"teams">, repository: string, date: string): Promise<EditionLoad | null> {
  const rows: Doc<"change_stories">[] = await ctx.db
    .query("change_stories")
    .withIndex("by_team_repo_date", (q: any) => q.eq("team_id", teamId).eq("repository", repository).eq("date", date))
    .collect();
  const main = rows
    .filter((s) => s.on_default_branch)
    .sort((a, b) => b.importance - a.importance || b.insertions + b.deletions - (a.insertions + a.deletions) || a.story_key.localeCompare(b.story_key))
    .slice(0, EDITION_STORIES);
  if (!main.length) return null;

  const digest: Doc<"digests"> | null = await ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q: any) => q.eq("team_id", teamId).eq("repository", repository).eq("scope", "day").eq("date", date))
    .first();
  const day = await teamDayBounds(ctx, teamId, date);

  const branches = new Map<string, { commits: number; files: Record<string, number> }>();
  for (const s of rows) {
    if (s.on_default_branch) continue;
    const b = branches.get(s.branch) ?? { commits: 0, files: {} };
    b.commits += s.commit_shas.length;
    for (const [a, n] of Object.entries(s.area_counts)) b.files[a] = (b.files[a] ?? 0) + n;
    branches.set(s.branch, b);
  }

  const blockedIds = [...new Set(main.flatMap((s) => s.risks.filter((r) => r.code === "blocked").flatMap((r) => r.evidence)))];
  const blocked = (await gatedSessions(ctx, teamId, blockedIds as Id<"conversations">[]))
    .filter((s) => s.outcome_type === "blocked")
    .map((s) => clip(s.headline || s.summary, 160));

  const keys: Record<string, string> = {};
  const stories: EditionStory[] = main.map((s, n) => {
    const key = `s${n + 1}`;
    keys[key] = s.story_key;
    return {
      key,
      area: s.area,
      kind: s.kind,
      importance: s.importance,
      headline: s.headline,
      dek: s.dek,
      insertions: s.insertions,
      deletions: s.deletions,
      ...(s.release ? { release: releaseName(s.release) } : {}),
      authors: s.author_names.length,
      sessions: s.conversation_ids.length,
      risks: s.risks.map((r) => r.code),
    };
  });

  const input: EditionPromptInput = {
    date,
    stats: digest?.stats ? { commits: digest.stats.commits, stories: digest.stats.stories, releases: digest.stats.releases, people: digest.stats.people, sessions: digest.stats.sessions } : null,
    releases: (digest?.releases ?? []).map((r) => ({ surface: r.surface, ...(r.version ? { version: r.version } : {}), sha: shortSha(r.sha), time: minutes(r.at, day.timezone) })),
    stories,
    branches: [...branches.entries()]
      .sort((a, b) => b[1].commits - a[1].commits || a[0].localeCompare(b[0]))
      .slice(0, EDITION_BRANCHES)
      .map(([branch, b]) => ({ branch, commits: b.commits, area: Object.entries(b.files).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? "" })),
    blocked: blocked.slice(0, EDITION_BLOCKED),
  };
  const model = PROSE_MODEL;
  return { input, keys, model, hash: hash64(["edition", EDITION_PROMPT_VERSION, model, JSON.stringify(input), JSON.stringify(keys)]) };
}

export type EditionRead = {
  load: EditionLoad | null;
  digest: Pick<Doc<"digests">, "status" | "inputs_hash" | "generated_at" | "headline"> | null;
};

export const readEdition = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<EditionRead> => {
    const digest = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", args.team_id).eq("repository", args.repository).eq("scope", "day").eq("date", args.date))
      .first();
    return {
      load: await loadEditionInput(ctx, args.team_id, args.repository, args.date),
      digest: digest ? { status: digest.status, inputs_hash: digest.inputs_hash, generated_at: digest.generated_at, headline: digest.headline } : null,
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────

export const usageArg = v.object({ model: v.string(), input_tokens: v.number(), output_tokens: v.number(), cost_usd: v.number() });
export type Usage = typeof usageArg.type;

/** A row's spend after one more call. Tokens and dollars add up over every call the row has had. */
export function spend(row: { input_tokens?: number; output_tokens?: number; cost_usd?: number }, usage: Usage | undefined) {
  if (!usage) return {};
  return {
    model: usage.model,
    input_tokens: (row.input_tokens ?? 0) + usage.input_tokens,
    output_tokens: (row.output_tokens ?? 0) + usage.output_tokens,
    cost_usd: (row.cost_usd ?? 0) + usage.cost_usd,
  };
}

const storyOutcome = v.union(
  v.object({
    status: v.literal("written"),
    headline: v.string(),
    dek: v.string(),
    body: v.optional(v.string()),
    kind: v.string(),
    importance: v.number(),
    why_source: v.union(v.literal("session"), v.literal("commit"), v.literal("pr"), v.literal("none")),
    risk_lines: v.optional(v.record(v.string(), v.string())),
  }),
  // The skip path: the subject is the headline, and the commit is the why.
  v.object({ status: v.literal("skipped"), headline: v.string() }),
  // Branch work: no prose in MVP; layer 0's text keeps following the branch.
  v.object({ status: v.literal("branch") }),
  v.object({ status: v.literal("failed") }),
);

/**
 * Write one story's prose. It lands only on the row it was asked about: the
 * same inputs_hash, still pending, and every session it read still passing the
 * gate at the mode it was read at. Otherwise the reply is dropped (its cost
 * still counts) and the rebuild that the change scheduled writes it again.
 */
export const writeStoryProse = internalMutation({
  args: {
    story_id: v.id("change_stories"),
    inputs_hash: v.string(),
    used: v.array(v.object({ conversation_id: v.id("conversations"), mode: v.union(v.literal("summary"), v.literal("full")) })),
    outcome: storyOutcome,
    usage: v.optional(usageArg),
  },
  handler: async (ctx, args): Promise<"written" | "stale" | "gone"> => {
    const row = await ctx.db.get(args.story_id);
    if (!row) return "gone";
    const cost = spend(row, args.usage);

    let current = row.inputs_hash === args.inputs_hash && row.prose_status === "pending";
    if (current && args.used.length) {
      const kept = new Set(row.conversation_ids.map(String));
      const gate = await teamVisibleInputs(ctx, row.team_id, args.used.map((u) => u.conversation_id));
      current = args.used.every((u) => {
        const now = gate.get(String(u.conversation_id));
        return kept.has(String(u.conversation_id)) && !!now && !(u.mode === "full" && now.mode === "summary");
      });
    }
    if (!current) {
      if (args.usage) await ctx.db.patch(row._id, cost);
      return "stale";
    }

    const o = args.outcome;
    const at = Date.now();
    if (o.status === "written") {
      await ctx.db.patch(row._id, {
        headline: o.headline,
        dek: o.dek,
        body: o.body,
        kind: o.kind,
        importance: o.importance,
        why_source: o.why_source,
        risk_lines: o.risk_lines,
        prose_status: "written",
        prose_attempts: undefined,
        generated_at: at,
        ...cost,
      });
    } else if (o.status === "skipped") {
      await ctx.db.patch(row._id, { headline: o.headline, why_source: "commit", prose_status: "skipped", prose_attempts: undefined, generated_at: at });
    } else if (o.status === "branch") {
      await ctx.db.patch(row._id, { prose_status: "skipped" });
    } else {
      await ctx.db.patch(row._id, { prose_status: "failed", prose_attempts: (row.prose_attempts ?? 0) + 1, ...cost });
    }
    return "written";
  },
});

const editionOutcome = v.union(
  v.object({
    status: v.literal("written"),
    final: v.boolean(),
    headline: v.string(),
    standfirst: v.string(),
    lead_story_key: v.string(),
    section_order: v.array(v.string()),
    brief_story_keys: v.array(v.string()),
  }),
  // The day ended and nothing moved since the last edition: it is the final one as written.
  v.object({ status: v.literal("final") }),
  v.object({ status: v.literal("failed") }),
);

/**
 * Write the day's edition. Prose lands only over the stories it was asked
 * about (the inputs hash, recomputed now); otherwise only its cost is kept. A
 * failure leaves earlier prose alone and marks a facts-only edition failed.
 */
export const writeEditionProse = internalMutation({
  args: {
    team_id: v.id("teams"),
    repository: v.string(),
    date: v.string(),
    inputs_hash: v.string(),
    outcome: editionOutcome,
    usage: v.optional(usageArg),
  },
  handler: async (ctx, args): Promise<"written" | "stale" | "gone"> => {
    const digest = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", args.team_id).eq("repository", args.repository).eq("scope", "day").eq("date", args.date))
      .first();
    if (!digest) return "gone";
    const cost = spend(digest, args.usage);
    const o = args.outcome;

    if (o.status === "failed") {
      if (hasEditionProse(digest)) {
        if (args.usage) await ctx.db.patch(digest._id, cost);
      } else {
        await ctx.db.patch(digest._id, { status: "failed", generated_at: Date.now(), ...cost });
      }
      return "written";
    }

    const load = await loadEditionInput(ctx, args.team_id, args.repository, args.date);
    if (!load || load.hash !== args.inputs_hash) {
      if (args.usage) await ctx.db.patch(digest._id, cost);
      return "stale";
    }
    if (o.status === "final") {
      if (digest.inputs_hash === args.inputs_hash && hasEditionProse(digest)) await ctx.db.patch(digest._id, { status: "final" });
      return "written";
    }
    await ctx.db.patch(digest._id, {
      headline: o.headline,
      narrative: o.standfirst,
      lead_story_key: o.lead_story_key,
      section_order: o.section_order,
      brief_story_keys: o.brief_story_keys,
      inputs_hash: args.inputs_hash,
      status: o.final ? "final" : "written",
      generated_at: Date.now(),
      ...cost,
    });
    return "written";
  },
});

/** The cap left prose of this day unwritten. The first time is kept: spend never falls, so the day stays capped. */
export const markCapped = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const digest = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", args.team_id).eq("repository", args.repository).eq("scope", "day").eq("date", args.date))
      .first();
    if (digest && !digest.capped_at) await ctx.db.patch(digest._id, { capped_at: Date.now() });
  },
});

/** Come back to a team day after `delay`: a story still settling, or an edition inside its hourly interval. */
export const deferDay = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string(), delay: v.number() },
  handler: async (ctx, args): Promise<void> => {
    if (!(await changesZone(ctx, args.team_id))) return;
    await markDayDirty(ctx, { team_id: args.team_id, repository: args.repository, date: args.date }, Math.max(60_000, args.delay));
  },
});

// ── The pass ─────────────────────────────────────────────────────────────

export type ProseResult = {
  written: number;
  skipped: number;
  failed: number;
  stale: number;
  /** Stories left pending until they settle. */
  deferred: number;
  /** Stories left pending because the day's spend reached the cap. */
  capped: number;
  /** Stories left pending because this deployment has no model key. */
  held: number;
  edition: "written" | "final" | "unchanged" | "deferred" | "capped" | "held" | "failed" | "stale" | "none";
  spent_usd: number;
};

/** Edition outcomes of an ended day that schedule its week (changesWeek.ts). */
const WEEK_AFTER: ReadonlySet<ProseResult["edition"]> = new Set(["final", "failed", "capped", "held"]);

export const usageOf = (model: string, u: { input_tokens: number; output_tokens: number }): Usage => ({
  model,
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cost_usd: modelCost(model, u),
});

async function readStoryCommits(ctx: ActionCtx, story: Doc<"change_stories">): Promise<ChangeCommit[]> {
  const out: ChangeCommit[] = [];
  for (let i = 0; i < story.commit_shas.length; i += COMMIT_READ_CHUNK) {
    out.push(...(await ctx.runQuery(internal.changesProse.readCommits, {
      team_id: story.team_id,
      repository: story.repository,
      shas: story.commit_shas.slice(i, i + COMMIT_READ_CHUNK),
    })));
  }
  return out;
}

type Budget = { spent: number };
type StoryStep = "written" | "skipped" | "failed" | "stale" | "deferred" | "capped" | "held" | "gone";

/** A deployment without a model key writes no prose and marks nothing failed: the stories wait for one. */
export const hasModelKey = () => !!process.env.ANTHROPIC_API_KEY;

async function proseForStory(ctx: ActionCtx, storyId: Id<"change_stories">, dayEnd: number, now: number, budget: Budget, settle: number[]): Promise<StoryStep> {
  const read: StoryRead | null = await ctx.runQuery(internal.changesProse.readStory, { story_id: storyId });
  if (!read) return "gone";
  const { story, sessions, prs } = read;
  const used = sessions.map((s) => ({ conversation_id: s.conversation_id, mode: s.mode }));
  const write = async (outcome: typeof storyOutcome.type, usage?: Usage): Promise<StoryStep> => {
    const r: "written" | "stale" | "gone" = await ctx.runMutation(internal.changesProse.writeStoryProse, {
      story_id: storyId, inputs_hash: story.inputs_hash, used, outcome, ...(usage ? { usage } : {}),
    });
    if (r !== "written") return r;
    return outcome.status === "branch" ? "skipped" : outcome.status;
  };

  if (!story.on_default_branch) return await write({ status: "branch" });
  const at = settlesAt(story, dayEnd);
  if (at > now) {
    settle.push(at);
    return "deferred";
  }
  const commits = await readStoryCommits(ctx, story);
  const skip = skipHeadline(story, commits);
  if (skip) return await write({ status: "skipped", headline: skip });
  if (budget.spent >= DAILY_CAP_USD) return "capped";
  if (!hasModelKey()) return "held";

  const input = storyPromptInput(story, commits, sessions, prs);
  const req = storyRequest(input);
  const reply = await callModel({ ...req, label: "Changes story", timeout_ms: STORY_TIMEOUT_MS });
  if (!reply) return await write({ status: "failed" });
  const usage = usageOf(req.model, reply.usage);
  budget.spent += usage.cost_usd;
  const prose = parseStoryReply(reply.text, input, story);
  if (!prose) {
    console.error("Changes story: unusable reply", story.story_key, reply.text.slice(0, 300));
    return await write({ status: "failed" }, usage);
  }
  return await write({ status: "written", ...prose }, usage);
}

async function proseForEdition(
  ctx: ActionCtx,
  args: { team_id: Id<"teams">; repository: string; date: string },
  dayEnd: number,
  now: number,
  budget: Budget,
  settle: number[],
): Promise<ProseResult["edition"]> {
  const { load, digest }: EditionRead = await ctx.runQuery(internal.changesProse.readEdition, args);
  if (!load || !digest) return "none";
  const final = now >= dayEnd;
  const write = (outcome: typeof editionOutcome.type, usage?: Usage): Promise<"written" | "stale" | "gone"> =>
    ctx.runMutation(internal.changesProse.writeEditionProse, { ...args, inputs_hash: load.hash, outcome, ...(usage ? { usage } : {}) });

  if (hasEditionProse(digest) && digest.inputs_hash === load.hash) {
    if (!final || digest.status === "final") return "unchanged";
    return (await write({ status: "final" })) === "written" ? "final" : "stale";
  }
  if (budget.spent >= DAILY_CAP_USD) return "capped";
  if (!final && (digest.status === "written" || digest.status === "failed") && now - digest.generated_at < EDITION_INTERVAL_MS) {
    settle.push(digest.generated_at + EDITION_INTERVAL_MS);
    return "deferred";
  }
  if (!hasModelKey()) return "held";

  const req = editionRequest(load.input);
  const reply = await callModel({ ...req, label: "Changes edition", timeout_ms: EDITION_TIMEOUT_MS });
  if (!reply) {
    await write({ status: "failed" });
    return "failed";
  }
  const usage = usageOf(req.model, reply.usage);
  budget.spent += usage.cost_usd;
  const edition = parseEditionReply(reply.text, load.input, load.keys);
  if (!edition) {
    console.error("Changes edition: unusable reply", args.repository, args.date, reply.text.slice(0, 300));
    await write({ status: "failed" }, usage);
    return "failed";
  }
  const r = await write({ status: "written", final, ...edition }, usage);
  return r === "written" ? (final ? "final" : "written") : "stale";
}

/**
 * Prose for one built team day: its pending stories, 8 calls at a time, then
 * its edition. Stories still settling, and an edition inside its hourly
 * interval, bring the day back when they are due. A story that throws is
 * logged and left pending; the edition still runs.
 */
export async function runProse(
  ctx: ActionCtx,
  args: { team_id: Id<"teams">; repository: string; date: string; pending: readonly Id<"change_stories">[] },
): Promise<ProseResult> {
  const now = Date.now();
  const day: { end: number } = await ctx.runQuery(internal.changes.readDay, { team_id: args.team_id, repository: args.repository, date: args.date });
  const budget: Budget = { spent: await ctx.runQuery(internal.changesProse.spentOn, { team_id: args.team_id, date: args.date }) };
  const settle: number[] = [];
  const result: ProseResult = { written: 0, skipped: 0, failed: 0, stale: 0, deferred: 0, capped: 0, held: 0, edition: "none", spent_usd: 0 };
  const startSpent = budget.spent;

  let unfinished = false;
  for (let i = 0; i < args.pending.length; i += STORY_PARALLEL) {
    if (Date.now() - now > PROSE_WALL_MS) {
      unfinished = true;
      settle.push(Date.now() + 60_000);
      break;
    }
    const steps = await Promise.all(args.pending.slice(i, i + STORY_PARALLEL).map(async (id) => {
      try {
        return await proseForStory(ctx, id, day.end, now, budget, settle);
      } catch (error) {
        console.error("Changes story prose failed:", String(id), error);
        return "gone" as const;
      }
    }));
    for (const s of steps) if (s !== "gone") result[s] += 1;
  }

  // The edition reads the stories' prose, so it waits for a run that wrote them all.
  if (!unfinished) {
    try {
      result.edition = await proseForEdition(ctx, { team_id: args.team_id, repository: args.repository, date: args.date }, day.end, now, budget, settle);
    } catch (error) {
      console.error("Changes edition prose failed:", args.repository, args.date, error);
    }
  }

  if (result.capped || result.edition === "capped") {
    await ctx.runMutation(internal.changesProse.markCapped, { team_id: args.team_id, repository: args.repository, date: args.date });
  }
  // An ended day's edition is as written as it will get (prose, or facts the
  // cap, a missing key or a failure left): its week is built from it.
  if (now >= day.end && WEEK_AFTER.has(result.edition)) {
    await ctx.runMutation(internal.changesWeek.scheduleWeek, { team_id: args.team_id, repository: args.repository, date: args.date });
  }
  if (settle.length) {
    await ctx.runMutation(internal.changesProse.deferDay, {
      team_id: args.team_id, repository: args.repository, date: args.date, delay: Math.min(...settle) - now,
    });
  }
  result.spent_usd = budget.spent - startSpent;
  return result;
}
