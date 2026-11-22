// The walk from a session up to the one that started its line of work, and
// the read that gathers every person's typed line along it
// (/cli/sessions/originator, `cast flow asker`). Pure over the loaders and
// steps it is handed, so the HTTP route and the tests drive the same code.

/** Conversations a walk holds at most, the starting one included. */
export const ORIGINATOR_MAX_HOPS = 8;

/** How a session links to the one above it, in the order the walk tries them. */
export type ChainLink = "spawned_by" | "parent" | "forked_from" | "workflow_run" | "agent_task";

/** Why a walk ended before a session with no link above it. */
export type ChainStop = "access_denied" | "missing" | "cycle" | "depth_cap";

export type ChainConversation = {
  _id: string;
  spawned_by_conversation_id?: string | null;
  parent_conversation_id?: string | null;
  forked_from?: string | null;
  workflow_run_id?: string | null;
  agent_task_id?: string | null;
};

export type ChainLoader<C extends ChainConversation> = {
  conversation: (id: string) => Promise<C | null>;
  canRead: (conversation: C) => Promise<boolean>;
  /** A workflow run's spawner_conversation_id. */
  runSpawner: (runId: string) => Promise<string | null>;
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
  if (c.spawned_by_conversation_id) return { link: "spawned_by", id: String(c.spawned_by_conversation_id) };
  if (c.parent_conversation_id) return { link: "parent", id: String(c.parent_conversation_id) };
  if (c.forked_from) return { link: "forked_from", id: String(c.forked_from) };
  const spawner = c.workflow_run_id ? await loader.runSpawner(String(c.workflow_run_id)) : null;
  if (spawner) return { link: "workflow_run", id: spawner };
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
