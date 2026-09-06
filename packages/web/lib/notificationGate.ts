// Whether an OS banner goes up in a plain browser tab (ct-49551).
//
// On the desktop the shell owns this decision — it is the one process that sees
// every window — and its copy of the policy lives in packages/electron/
// notificationRouter.js. A browser tab has no shell, so it applies the same
// three rules to itself. The two cannot share a file: the shell is a CommonJS
// module inside the Electron asar, this one is bundled into the web app.
//
//   1. Stay silent only when this tab has focus AND already shows what the
//      banner is about. The old rule dropped every banner while the tab had
//      focus, so a session finishing in a conversation you were not reading
//      said nothing at all.
//   2. One banner per conversation per 5 s, bounded to 50 keys.
//   3. Hold anything that is not a completion for 250 ms, so a completion
//      arriving in the same burst is the one that fires.

const BANNER_COOLDOWN_MS = 5_000;
const BANNER_COOLDOWN_KEYS = 50;
const BANNER_GRACE_MS = 250;

// `session_idle` is codecast's completion: the daemon writes it when a
// session's turn settles. It outranks a permission request for the same
// conversation, which only says the agent stopped.
const COMPLETION_KINDS = new Set(["session_idle"]);

export function bannerRank(kind?: string): number {
  return COMPLETION_KINDS.has(String(kind || "")) ? 1 : 0;
}

// True when the page on screen already shows what the banner points at. The
// paths must match and must name something: a list page (/inbox, /tasks) is not
// the banner's target, and neither is a banner with no route.
export function showsBannerEntity(active: string | null | undefined, route?: string): boolean {
  if (!active || !route) return false;
  const strip = (p: string) => p.split(/[?#]/)[0].replace(/\/+$/, "");
  const target = strip(route);
  return strip(active) === target && target.split("/").filter(Boolean).length >= 2;
}

export type BannerRequest = {
  route?: string;
  conversationId?: string;
  kind?: string;
  force?: boolean;
};

export type BannerVerdict = { shown: boolean; reason?: string };

/** What the tab shows right now, as reported by reportDesktopWindowState. */
export type BannerView = { focused: boolean; active: string | null };

export class BrowserBannerGate {
  private cooldown = new Map<string, number>();
  private held = new Map<string, { timer: unknown; resolve: (v: BannerVerdict) => void }>();
  private now: () => number;
  private graceMs: number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;

  constructor(opts: {
    now?: () => number;
    graceMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
  } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.graceMs = opts.graceMs ?? BANNER_GRACE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  /** A promise while a banner waits out the grace, an answer otherwise. */
  admit(view: BannerView, req: BannerRequest): BannerVerdict | Promise<BannerVerdict> {
    const route = req.route ?? (req.conversationId ? `/conversation/${req.conversationId}` : undefined);
    // A ring is for a person who is not looking, and "the tab is in front" does
    // not mean they are. It skips every rule here.
    if (!req.force && view.focused && showsBannerEntity(view.active, route)) {
      return { shown: false, reason: "focused-active" };
    }
    // The burst rules are per conversation. A chat, task or doc banner carries
    // no conversation and goes up as it always did.
    const key = req.conversationId ? `conversation:${req.conversationId}` : null;
    if (req.force || !key) return { shown: true };

    if (bannerRank(req.kind) > 0) {
      this.release(key, { shown: false, reason: "superseded" });
      return this.fire(key);
    }
    if (this.held.has(key)) return { shown: false, reason: "burst" };
    // Answered at once: a banner the cooldown will drop must not sit out the
    // grace first to be told so.
    if (this.cooling(key)) return { shown: false, reason: "cooldown" };
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.held.delete(key);
        resolve(this.fire(key));
      }, this.graceMs);
      this.held.set(key, { timer, resolve });
    });
  }

  // Drop whatever is waiting out the grace for this conversation.
  private release(key: string, result: BannerVerdict): void {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.clearTimer(held.timer);
    held.resolve(result);
  }

  private cooling(key: string): boolean {
    const last = this.cooldown.get(key);
    return last !== undefined && this.now() - last <= BANNER_COOLDOWN_MS;
  }

  private fire(key: string): BannerVerdict {
    if (this.cooling(key)) return { shown: false, reason: "cooldown" };
    const now = this.now();
    this.cooldown.delete(key);
    this.cooldown.set(key, now);
    // Map iterates in insertion order, so the front is the least recent.
    while (this.cooldown.size > BANNER_COOLDOWN_KEYS) {
      const oldest = this.cooldown.keys().next();
      if (oldest.done) break;
      this.cooldown.delete(oldest.value);
    }
    return { shown: true };
  }
}
