import { spanStamp } from './collapse';
import type { Activity } from './log';
import type { RunEnvelope } from './run';

/**
 * Who owns an inbound message in a shared read. Many runs read the same feed,
 * and the feed carries messages people just sent. Without a rule, every run
 * that happens to start next treats a fresh message as an unanswered ask, and
 * several answer it. A prompt rule cannot close that race, because the runs
 * are inside each other's compose windows. So the read itself withholds: only
 * the run a message woke sees it in its ambient context.
 *
 * Our own outbound stays visible: it is the posting history a run checks
 * before repeating itself.
 */
export interface OwnershipPolicy {
  /** Inbound kinds a run owns only if it woke on that inbound. */
  ownedKinds: ReadonlySet<string>;
  /** Whether this run is NOT the owner of the inbound in its read (it was woken by something else). */
  withholds(run: RunEnvelope): boolean;
}

export interface Withheld {
  total: number;
  firstMs: number;
  lastMs: number;
  kinds: Array<{ kind: string; count: number }>;
}

/** Whether a read for this run hides owned inbound kinds. No run, or no policy: nothing is withheld. */
export const withholdsFrom = (policy: OwnershipPolicy | undefined, run: RunEnvelope | undefined): policy is OwnershipPolicy =>
  !!policy && !!run && policy.withholds(run);

/** Split a read into what this run may see and what belongs to the runs those messages woke. */
export function partitionOwned(ascending: readonly Activity[], policy: OwnershipPolicy | undefined, run: RunEnvelope | undefined): { visible: Activity[]; withheld: Activity[]; census: Withheld | null } {
  if (!withholdsFrom(policy, run)) return { visible: [...ascending], withheld: [], census: null };
  const visible: Activity[] = [];
  const withheld: Activity[] = [];
  for (const a of ascending) (policy.ownedKinds.has(a.kind) ? withheld : visible).push(a);
  if (withheld.length === 0) return { visible, withheld, census: null };
  const byKind = new Map<string, number>();
  let firstMs = withheld[0].atMs;
  let lastMs = withheld[0].atMs;
  for (const a of withheld) {
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    if (a.atMs < firstMs) firstMs = a.atMs;
    if (a.atMs > lastMs) lastMs = a.atMs;
  }
  return {
    visible,
    withheld,
    census: { total: withheld.length, firstMs, lastMs, kinds: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count) },
  };
}

/**
 * The count line. It carries NO handle on purpose: a handle is an invitation
 * to open the messages, and opening them is how a run talks itself back into
 * answering one. A run that needs a message for work it already owns reaches
 * it by searching, as a deliberate act.
 */
export function formatWithheldLine(w: Withheld): string {
  const kinds = w.kinds.map((k) => `${k.kind} x${k.count}`).join(' | ');
  return (
    `[${spanStamp(w.firstMs, w.lastMs)}] ${w.total} inbound messages withheld from this run (${kinds}): each one woke its own run, and that run answers it. ` +
    `This run was not woken by any of them, so none of them is yours to answer or act on, and none is unanswered because you cannot see it. Your own posts stay listed.`
  );
}
