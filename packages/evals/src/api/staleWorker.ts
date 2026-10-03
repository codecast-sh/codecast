import type { StalenessWord } from '@codecast/shared/contracts/evalsApi';

import { surfaces } from '../registry';
import { staleness, type Staleness } from '../state';

// Each surface's staleness word (commands/stale.ts), computed in a worker:
// staleness() runs git synchronously, which under load takes seconds, so the
// api child asks for it alongside the index load instead of after it.

declare const self: Worker;

/** The one word the home wall shows for each surface. */
export function stalenessWordsOf(s: Pick<Staleness, 'stale' | 'waiting' | 'due' | 'blocked'>, metas = surfaces()): Record<string, StalenessWord> {
  const has = (list: Array<{ id: string }>, id: string) => list.some((m) => m.id === id);
  return Object.fromEntries(metas.map((m) => [m.id, has(s.blocked, m.id) ? 'blocked' : has(s.waiting, m.id) ? 'waiting' : has(s.due, m.id) && m.route === 'call' ? 'due' : has(s.stale, m.id) ? 'stale' : 'fresh']));
}

if (typeof self !== 'undefined' && !Bun.isMainThread) {
  self.onmessage = () => {
    let words: Record<string, StalenessWord> | null = null;
    try {
      words = stalenessWordsOf(staleness(surfaces()));
    } catch {
      // No git here: the caller reads every surface as fresh.
    }
    self.postMessage(words);
  };
}
