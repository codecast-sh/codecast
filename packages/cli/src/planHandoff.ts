// A session started from an accepted plan opens with a pointer to the
// planning session's transcript; the daemon links the two and sends the
// planner's messages on to the session doing the work. A compaction summary
// uses the same pointer, and a fork or a reconstituted copy carries its
// source's summary, so only a pointer that says it was written on leaving
// plan mode counts. If Claude Code rewords that sentence, handoffs stop
// linking and messages stay where they were sent; nothing is misdelivered.

/** The parent session a user message hands off from: null when the message
 *  carries no transcript pointer, "" when its pointer is not a plan handoff or names no other
 *  session. */
export function handoffParentSessionId(content: string, ownSessionId: string): string | null {
  if (!/read the full transcript at:\s*\S+\.jsonl/i.test(content)) return null;
  const pointer = content.match(/before exiting plan mode\b[^\n]*?read the full transcript at:\s*(\S+\.jsonl)/i);
  if (!pointer) return "";
  const parent = pointer[1].match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? "";
  return parent === ownSessionId ? "" : parent;
}

/** Records that `parent`'s messages belong to `child`. One conversation can
 *  answer to several session ids (a resume repair or an agent switch keeps the
 *  old id), so a pointer to an older id of the same conversation still reaches
 *  here: a conversation never becomes its own child. */
export function linkPlanHandoffChild(children: Map<string, string>, parent: string, child: string): boolean {
  if (parent === child) return false;
  children.set(parent, child);
  return true;
}

/** Where a message sent to `conversationId` belongs: the last session down its
 *  handoff chain, or undefined when it has none. A chain that loops has no
 *  last session, so the message stays where it was sent. */
export function planHandoffTarget(children: ReadonlyMap<string, string>, conversationId: string): string | undefined {
  const seen = new Set([conversationId]);
  let target: string | undefined;
  for (let next = children.get(conversationId); next; next = children.get(next)) {
    if (seen.has(next)) return undefined;
    seen.add(next);
    target = next;
  }
  return target;
}
