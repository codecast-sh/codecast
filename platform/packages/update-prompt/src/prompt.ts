import { RECHECK_MS, STALE_PROMPT_AFTER_MS, updatePromptKind, type UpdatePromptKind } from "./kind";

// The per-window half: remember when the first update arrived, ask the server
// what is deployed now, and raise the app's card when updatePromptKind says
// so. The card itself belongs to the app; this only decides when to show it
// and what Later means.

/** The served /version.json, as far as the prompt reads it. Apps put more beside these. */
export type ServedVersion = { promptGeneration?: number; promptMessage?: string };

type KeyValue = Pick<Storage, "getItem" | "setItem">;

export type UpdatePromptOptions = {
  /** Namespaces the storage keys: `<appKey>:update-prompt:…`. */
  appKey: string;
  /** The generation baked into this bundle (the Vite plugin's promptGeneration). */
  bakedGeneration: number;
  /**
   * Draws the card. `close` is Later: call it when the person dismisses the
   * card, however they do it. Reload is the app's to do.
   */
  show: (kind: UpdatePromptKind, served: ServedVersion, close: () => void) => void;
  versionUrl?: string;
  storage?: KeyValue | null;
  fetchServed?: () => Promise<ServedVersion | null>;
  now?: () => number;
  every?: (fn: () => void, ms: number) => unknown;
};

export type UpdatePrompt = {
  /** Call each time a new deploy takes over this window (the service worker's onNeedReload). */
  noteUpdateWaiting: () => void;
  /** Shows the card now, skipping the rules. For a dev console hook. */
  show: (kind: UpdatePromptKind, served?: ServedVersion) => void;
  /** Resolves when the check started by the last noteUpdateWaiting has finished. Tests await it. */
  settled: () => Promise<void>;
};

export function updatePromptKeys(appKey: string) {
  return {
    dismissed: `${appKey}:update-prompt:dismissed-generation`,
    snoozed: `${appKey}:update-prompt:stale-snoozed-until`,
  };
}

export async function fetchServedVersion(url = "/version.json"): Promise<ServedVersion | null> {
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as ServedVersion) : null;
  } catch {
    return null;
  }
}

function browserStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createUpdatePrompt(opts: UpdatePromptOptions): UpdatePrompt {
  const keys = updatePromptKeys(opts.appKey);
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const fetchServed = opts.fetchServed ?? (() => fetchServedVersion(opts.versionUrl));
  const now = opts.now ?? Date.now;
  const every = opts.every ?? ((fn, ms) => setInterval(fn, ms));

  const readNumber = (key: string) => {
    try { return Number(storage?.getItem(key)) || 0; } catch { return 0; }
  };
  const writeNumber = (key: string, value: number) => {
    try { storage?.setItem(key, String(value)); } catch {}
  };

  // Per window: when the first update arrived, and whether the card is up.
  let waitingSince: number | null = null;
  let shown = false;
  let pending: Promise<void> = Promise.resolve();

  const show = (kind: UpdatePromptKind, served: ServedVersion = {}) => {
    shown = true;
    let closed = false;
    opts.show(kind, served, () => {
      if (closed) return;
      closed = true;
      shown = false;
      if (kind === "release") writeNumber(keys.dismissed, Math.max(served.promptGeneration ?? 0, readNumber(keys.dismissed)));
      else writeNumber(keys.snoozed, now() + STALE_PROMPT_AFTER_MS);
    });
  };

  const evaluate = async () => {
    if (shown || waitingSince === null) return;
    const served = await fetchServed();
    if (!served || shown) return;
    const kind = updatePromptKind({
      bakedGeneration: opts.bakedGeneration,
      servedGeneration: served.promptGeneration ?? 0,
      dismissedGeneration: readNumber(keys.dismissed),
      updateWaitingSince: waitingSince,
      staleSnoozedUntil: readNumber(keys.snoozed),
      now: now(),
    });
    if (kind) show(kind, served);
  };

  return {
    noteUpdateWaiting() {
      if (waitingSince === null) {
        waitingSince = now();
        every(() => { pending = evaluate(); }, RECHECK_MS);
      }
      pending = evaluate();
    },
    show,
    settled: () => pending,
  };
}
