// The cards on screen whose owners a card draws (components/inbox/CoOwnerFaces):
// a card under the owners model holds its id here while it is in the viewport
// (watchOwnerCard, one IntersectionObserver for the window), and one feeder
// (hooks/useSyncVisibleSessionOwners) reads their owners in batched queries.
// The key is the topmost CAP held ids, sorted: a stable set for the feeder.
// Window-local and ephemeral: which cards are on screen is no server fact, so
// it lives beside the store, not in it. A phone list reports its viewable
// rows instead (setViewableOwnerCards); elsewhere with no observer (a
// DOM-less test) a hold lasts while the card is mounted.

/** The server reads at most this many (LIST_OWNERS_FOR_CAP). */
export const OWNER_CARDS_CAP = 60;

const held = new Map<string, { n: number; top: number }>();
const listeners = new Set<() => void>();
let key = "";
let batching = false;

function changed() {
  if (batching) return;
  const next = [...held.entries()].sort((a, b) => a[1].top - b[1].top).slice(0, OWNER_CARDS_CAP).map(([id]) => id).sort().join(",");
  if (next === key) return;
  key = next;
  for (const l of listeners) l();
}

/** Hold a card's id (at its distance from the top of the viewport); the returned function lets it go. */
export function holdOwnerCard(id: string, top = 0): () => void {
  const h = held.get(id);
  held.set(id, { n: (h?.n ?? 0) + 1, top: Math.min(h?.top ?? top, top) });
  changed();
  return () => {
    const n = (held.get(id)?.n ?? 1) - 1;
    if (n > 0) held.set(id, { ...held.get(id)!, n });
    else held.delete(id);
    changed();
  };
}

type Watch = { id: string; watchers: number; release: (() => void) | null };
const watched = new Map<Element, Watch>();
let observer: IntersectionObserver | null = null;

function observerOf(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver((entries) => {
    batching = true;
    try {
      for (const e of entries) {
        const w = watched.get(e.target);
        if (!w) continue;
        if (e.isIntersecting && !w.release) w.release = holdOwnerCard(w.id, e.boundingClientRect.top);
        else if (!e.isIntersecting && w.release) { w.release(); w.release = null; }
      }
    } finally {
      batching = false;
    }
    changed();
  });
  return observer;
}

/** Hold a card's id while its element is in the viewport. */
export function watchOwnerCard(el: Element, id: string): () => void {
  const io = observerOf();
  if (!io) return holdOwnerCard(id);
  const w = watched.get(el);
  if (w) w.watchers++;
  else { watched.set(el, { id, watchers: 1, release: null }); io.observe(el); }
  return () => {
    const cur = watched.get(el);
    if (!cur || --cur.watchers > 0) return;
    io.unobserve(el);
    watched.delete(el);
    cur.release?.();
  };
}

// A phone list's rows on screen (FlatList onViewableItemsChanged), by list:
// each list's holds are replaced whole with each report, ordered by index.
const viewableHolds = new Map<string, Array<() => void>>();

/** The rows a list shows now, in list order; the ids it held before go. */
export function setViewableOwnerCards(listKey: string, ids: readonly string[]): void {
  batching = true;
  try {
    for (const release of viewableHolds.get(listKey) ?? []) release();
    viewableHolds.set(listKey, ids.map((id, index) => holdOwnerCard(id, index)));
    if (!ids.length) viewableHolds.delete(listKey);
  } finally {
    batching = false;
  }
  changed();
}

export function subscribeOwnerCards(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The held ids, sorted and joined: a stable key for the feeder. */
export function ownerCardsKey(): string {
  return key;
}
