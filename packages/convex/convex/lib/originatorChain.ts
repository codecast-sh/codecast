// The walk from a session up to the one that started its line of work, and
// the read that gathers every person's typed line along it
// (/cli/sessions/originator, `cast flow asker`). Pure over the loaders and
// steps it is handed, so the HTTP route and the tests drive the same code.

/** Conversations a walk holds at most, the starting one included. */
export const ORIGINATOR_MAX_HOPS = 8;

/** How a session links to the one above it, in the order the walk tries them. */
export type ChainLink = "spawned_by" | "parent" | "forked_from" | "handed_off" | "workflow_run" | "agent_task";

/** Why a walk ended before a session with no link above it. */
export type ChainStop = "access_denied" | "missing" | "cycle" | "depth_cap";

export type ChainConversation = {
  _id: string;
  spawned_by_conversation_id?: string | null;
  parent_conversation_id?: string | null;
  forked_from?: string | null;
  handed_off_from_conversation_id?: string | null;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean | null;
  agent_task_id?: string | null;
};

export type ChainLoader<C extends ChainConversation> = {
  conversation: (id: string) => Promise<C | null>;
  canRead: (conversation: C) => Promise<boolean>;
  /** A workflow run's spawner_conversation_id, and whether it only stands in for a session that started the run. */
  runSpawner: (runId: string) => Promise<{ id: string; standIn: boolean } | null>;
  /** A scheduled task's created_by_conversation_id. */
  scheduleCreator: (agentTaskId: string) => Promise<string | null>;
};

export type ChainHop<C> = {
  conversation: C;
  /** The link followed (or, on the last hop of a stopped walk, tried) to the next session up. */
  link: ChainLink | null;
};

async function nextUp<C extends ChainConversation>(
  loader: ChainLoader<C>,
  c: C,
): Promise<{ link: ChainLink; id: string } | null> {
  const run = c.workflow_run_id ? await loader.runSpawner(String(c.workflow_run_id)) : null;
  // A run's station sessions nest under the run's session (spawn.ts runSpawnerOf); their own workflow_run_id, when
  // they have one, is a run they started themselves (a Workflow tool run, workflow_runs.ingestSnapshot).
  const parentRow = c.parent_conversation_id ? await loader.conversation(String(c.parent_conversation_id)) : null;
  const stationOf = parentRow?.is_workflow_primary && parentRow.workflow_run_id ? await loader.runSpawner(String(parentRow.workflow_run_id)) : null;
  // A stand-in spawner started nothing, and a stand-in run's stations name it as their spawner: no link climbs to it.
  const standIns = new Set([run, stationOf].filter((r) => r?.standIn).map((r) => r!.id));
  const to = (id: string | null | undefined) => (id && !standIns.has(String(id)) ? String(id) : null);
  const spawnedBy = to(c.spawned_by_conversation_id);
  if (spawnedBy) return { link: "spawned_by", id: spawnedBy };
  const parent = to(c.parent_conversation_id);
  if (parent) return { link: "parent", id: parent };
  if (c.forked_from) return { link: "forked_from", id: String(c.forked_from) };
  if (c.handed_off_from_conversation_id) return { link: "handed_off", id: String(c.handed_off_from_conversation_id) };
  if (run && !run.standIn) return { link: "workflow_run", id: run.id };
  const creator = c.agent_task_id ? await loader.scheduleCreator(String(c.agent_task_id)) : null;
  if (creator) return { link: "agent_task", id: creator };
  return null;
}

/**
 * Walk up from `start` (already known readable) until a session links to
 * nothing above it. Every hop returned is one the caller may read; the walk
 * stops before a session it may not, one that is gone, one already seen, or
 * past `maxHops`, and says which.
 */
export async function walkOriginatorChain<C extends ChainConversation>(
  loader: ChainLoader<C>,
  start: C,
  maxHops = ORIGINATOR_MAX_HOPS,
): Promise<{ hops: ChainHop<C>[]; stopped?: ChainStop }> {
  const hops: ChainHop<C>[] = [{ conversation: start, link: null }];
  const seen = new Set([String(start._id)]);
  for (;;) {
    const last = hops[hops.length - 1];
    const up = await nextUp(loader, last.conversation);
    if (!up) return { hops };
    last.link = up.link;
    if (seen.has(up.id)) return { hops, stopped: "cycle" };
    if (hops.length >= maxHops) return { hops, stopped: "depth_cap" };
    const next = await loader.conversation(up.id);
    if (!next) return { hops, stopped: "missing" };
    if (!(await loader.canRead(next))) return { hops, stopped: "access_denied" };
    seen.add(up.id);
    hops.push({ conversation: next, link: null });
  }
}

export type TypedLine = {
  conversation_id: string;
  short_id: string;
  line: number;
  message_id: string;
  user_id: string;
  user_name: string | null;
  provenance: "typed_composer" | "typed_local";
  text: string;
  created_at: string;
};

type ChainHead = {
  chain: Array<{ conversation_id: string }>;
  task?: { chain: Array<{ conversation_id: string }> };
};

type OriginatorSteps<H extends ChainHead> = {
  head: () => Promise<H | { error: string }>;
  typedStep: (conversationId: string, state: unknown) => Promise<{ typed: TypedLine[]; state?: unknown } | { error: string }>;
};

/** The chain and its originator, then every typed line of each session on it (a task's filing chain included). */
export async function readOriginator<H extends ChainHead>(steps: OriginatorSteps<H>): Promise<(H & { typed: TypedLine[] }) | { error: string }> {
  const head = await steps.head();
  if ("error" in head) return head;
  const typed: TypedLine[] = [];
  const done = new Set<string>();
  for (const hop of [...head.chain, ...(head.task?.chain ?? [])]) {
    if (done.has(hop.conversation_id)) continue;
    done.add(hop.conversation_id);
    let state: unknown = undefined;
    do {
      const step = await steps.typedStep(hop.conversation_id, state);
      if ("error" in step) return step;
      typed.push(...step.typed);
      state = step.state;
    } while (state !== undefined);
  }
  return { ...head, typed };
}

/** The line a flow says a person authorized its change on (`cast flow intent-verify --cite`). */
export type Cite = { conversation_short_id: string; line: number };

/** What a verified word cites: a line the starter typed, or their answer to a decision card. */
export type WordCite = Cite | { card: string };

/** A citation as the task and intent.json name it: `<session>:<line>` or `card:sd-N`. */
export const citeRef = (cite: WordCite): string => ("card" in cite ? `card:${cite.card}` : `${cite.conversation_short_id}:${cite.line}`);

/** What the server knows of the run a citation clears: who started it, and the sessions its change came through. */
export type CiteRun = {
  starter_id: string;
  starter_name: string | null;
  starter_is_bot: boolean;
  chain: Array<{ conversation_id: string; short_id: string }>;
  /** The run's task, whose own cards a citation may name. */
  task_id?: string;
  /** The newest verdict a person gave on the task's Ship cards. */
  verdict?: { ref: string; at: number; ship: boolean; label: string };
};

/** `said_at`: when the cited line was typed (ms). */
export type CitedLine = { conversation_id: string; short_id: string; line: number; user_id: string; user_name: string | null; quote: string; said_at: number };

/** Whitespace runs read as one space, so a quote matches across the line breaks a model folds. */
export const normalizeQuote = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether a cited line is the run's starter's own typed word holding the quote: the cited session is on the run's
 * change chain, its line is one a person typed (typedStep leaves out every program line), that person started the
 * run and is no agent account, the line holds the quote once whitespace is folded, and no person gave a verdict other
 * than Ship on the task's cards after it was typed. A refusal says which failed.
 */
export async function verifyCitation(
  steps: { run: () => Promise<CiteRun | { error: string }>; typedStep: OriginatorSteps<ChainHead>["typedStep"] },
  cite: Cite,
  quote: string,
): Promise<CitedLine | { refused: string }> {
  const run = await steps.run();
  if ("error" in run) return { refused: run.error };
  if (run.starter_is_bot) return { refused: "an agent account started the run, and only a person's word clears it" };
  const quoted = normalizeQuote(quote);
  if (!quoted) return { refused: "the citation quotes nothing" };
  const where = `${cite.conversation_short_id}:${cite.line}`;
  const hop = run.chain.find((h) => h.short_id === cite.conversation_short_id);
  if (!hop) return { refused: `${cite.conversation_short_id} is not a session this change came through` };
  let state: unknown = undefined;
  let typed: TypedLine | undefined;
  do {
    const step = await steps.typedStep(hop.conversation_id, state);
    if ("error" in step) return { refused: step.error };
    typed = step.typed.find((l) => l.line === cite.line);
    state = step.state;
    // Lines are numbered in order: a scan already past the cited line has shown it was not typed.
  } while (!typed && state !== undefined && !(((state as { line?: number }).line ?? 0) > cite.line));
  if (!typed) return { refused: `${where} is not a line a person typed` };
  if (typed.user_id !== run.starter_id) {
    return { refused: `${where} was typed by ${typed.user_name ?? "someone else"}, not by ${run.starter_name ?? "the person"} who started the run` };
  }
  if (!normalizeQuote(typed.text).includes(quoted)) return { refused: `${where} does not say "${quoted.slice(0, 200)}"` };
  const saidAt = Date.parse(typed.created_at);
  if (run.verdict && !run.verdict.ship && run.verdict.at > saidAt) {
    return { refused: `a person answered ${run.verdict.label} on ${run.verdict.ref} after ${where} was typed` };
  }
  return { conversation_id: hop.conversation_id, short_id: hop.short_id, line: typed.line, user_id: typed.user_id, user_name: typed.user_name, quote: quoted, said_at: saidAt };
}

/** A decision card a citation names, as the server holds it. */
export type CardFacts = {
  short_id: string;
  conversation_id: string;
  task_id?: string;
  status: string;
  answered_by?: { kind: string; id: string };
  /** The option chosen, or the words typed in its place. */
  answer: string;
  note?: string;
  resolved_at?: number;
};

export type CitedCard = { card: string; user_id: string; quote: string; said_at: number };

/**
 * Whether a cited card answer is the run starter's own word holding the quote: the card was asked in a session on
 * the run's change chain or on the run's task, a person answered it and that person started the run (no agent
 * account), its answer or note holds the quote once whitespace is folded, and no person gave a verdict other than
 * Ship on the task's cards after it. When it was answered (resolved_at) is its time for the newest-word rules.
 */
export async function verifyCardCitation(
  steps: { run: () => Promise<CiteRun | { error: string }>; card: (ref: string) => Promise<CardFacts | null | { error: string }> },
  ref: string,
  quote: string,
): Promise<CitedCard | { refused: string }> {
  const run = await steps.run();
  if ("error" in run) return { refused: run.error };
  if (run.starter_is_bot) return { refused: "an agent account started the run, and only a person's word clears it" };
  const quoted = normalizeQuote(quote);
  if (!quoted) return { refused: "the citation quotes nothing" };
  const card = await steps.card(ref);
  if (!card) return { refused: `no card ${ref}` };
  if ("error" in card) return { refused: card.error };
  const onChain = run.chain.some((h) => h.conversation_id === card.conversation_id);
  const onTask = !!run.task_id && card.task_id === run.task_id;
  if (!onChain && !onTask) return { refused: `${ref} was not asked in a session this change came through, nor on its task` };
  if (card.status !== "answered" || card.answered_by?.kind !== "user" || card.resolved_at === undefined) return { refused: `${ref} holds no person's answer` };
  if (card.answered_by.id !== run.starter_id) return { refused: `${ref} was answered by someone other than ${run.starter_name ?? "the person"} who started the run` };
  if (!normalizeQuote(`${card.answer} ${card.note ?? ""}`).includes(quoted)) return { refused: `${ref}'s answer does not say "${quoted.slice(0, 200)}"` };
  if (run.verdict && !run.verdict.ship && run.verdict.ref !== ref && run.verdict.at > card.resolved_at) {
    return { refused: `a person answered ${run.verdict.label} on ${run.verdict.ref} after ${ref} was answered` };
  }
  return { card: ref, user_id: card.answered_by.id, quote: quoted, said_at: card.resolved_at };
}
