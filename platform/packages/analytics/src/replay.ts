// The semantic replay recorder (codecast docs/architecture/external-data.md X5).
//
// A replay is what a person did and what the page said back, as events an
// agent reads as text and turns into a repro: navigation, clicks, typed
// lengths, submits, a few keys, coarse scroll, console warnings and errors,
// failed or slow requests, errors, and a visible text outline of the page.
// Never pixels, never an input value.
//
// Overhead is the design constraint, after the August 2026 rrweb slowdown in
// codecast: one capture listener per event type, a patch on history, console,
// fetch and XHR, and a throttled outline walk at navigation and before an
// error. No MutationObserver, nothing per frame, nothing per DOM change.
//
// The recorder keeps the last 60 seconds in a ring buffer. An error (any item
// the sink captures) always uploads the buffer and keeps the recording going;
// a sampled share of sessions (sampleRate) records from the start. Chunks are
// gzipped JSON PUT to a presigned URL from the door's replay-sign endpoint,
// then a replay manifest item goes through the sink.

import { gzipText, sha256Hex, type CodecastErrorItem, type CodecastSink } from "./codecast";

// The event shapes match codecast packages/shared/contracts/replay.ts exactly
// (codecast typechecks the two against each other). The platform package must
// not import codecast, so they are spelled here.
export const REPLAY_KEYS = ["Enter", "Escape", "Tab"] as const;
export type ReplayKey = (typeof REPLAY_KEYS)[number];
export const REPLAY_CONSOLE_LEVELS = ["warn", "error"] as const;
export type ReplayConsoleLevel = (typeof REPLAY_CONSOLE_LEVELS)[number];

interface At {
  t: number;
}

export type ReplayEvent =
  | (At & { type: "nav"; url: string; title?: string })
  | (At & { type: "click"; label: string; role?: string; selector: string; text?: string })
  | (At & { type: "input"; label: string; selector: string; length: number; redacted: true })
  | (At & { type: "submit"; label: string; selector: string })
  | (At & { type: "key"; key: ReplayKey })
  | (At & { type: "scroll"; y: number; of: number })
  | (At & { type: "console"; level: ReplayConsoleLevel; message: string })
  | (At & { type: "network"; method: string; url: string; status: number; ms: number })
  | (At & { type: "error"; message: string; stack?: string })
  | (At & { type: "view"; outline: string })
  | (At & { type: "mark"; name: string; data?: Record<string, unknown> });

export const REPLAY_LIMITS = {
  ring_buffer_ms: 60_000,
  scroll_min_interval_ms: 1_000,
  network_slow_ms: 2_000,
  view_outline_max_chars: 4 * 1024,
  timeline_md_max_chars: 32 * 1024,
  console_message_max_chars: 1_000,
  error_stack_max_chars: 8 * 1024,
  label_max_chars: 200,
  selector_max_chars: 300,
  url_max_chars: 2_048,
  mark_data_max_chars: 2_000,
  chunk_max_events: 5_000,
  chunk_max_bytes: 2 * 1024 * 1024,
  max_chunks_per_replay: 60,
  retention_days: 30,
  signed_url_ttl_s: 300,
} as const;

/** How often a kept recording ships what it gathered since the last chunk. */
const CHUNK_INTERVAL_MS = 10_000;
/** At most one outline walk in this window: navigation bursts and error storms walk once. */
const OUTLINE_MIN_INTERVAL_MS = 2_000;
/** Settle time after a navigation before the outline walk, so the new route has painted. */
const OUTLINE_AFTER_NAV_MS = 500;
/** Hard cap on nodes one outline walk visits, whatever the page size. */
const OUTLINE_MAX_NODES = 4_000;

export interface ReplayOptions {
  sink: CodecastSink;
  /** Share of sessions recorded and uploaded from the start. Errors always upload. Default 0. */
  sampleRate?: number;
  /** URLs to leave out entirely: navigation to them and requests to them are not recorded. */
  redactUrl?: RegExp | ((url: string) => boolean);
  /** For tests. */
  now?: () => number;
  random?: () => number;
  fetch?: typeof fetch;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ReplayRecorder {
  readonly replayId: string;
  /** True once an error or the sample kept this recording; it then uploads as it goes. */
  readonly kept: boolean;
  /** Events still held locally (the ring buffer, or what waits for the next chunk). */
  readonly events: readonly ReplayEvent[];
  /** An app-defined state marker. */
  mark(name: string, data?: Record<string, unknown>): void;
  /** Keep the recording and upload what is held now. */
  upload(): Promise<void>;
  stop(): void;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Inside an element the app marked private: no label text, no outline. */
export function isPrivate(el: Element | null): boolean {
  return !!el?.closest?.("[data-private]");
}

const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

/** Inside a rich text editor, whose text is whatever the person typed. */
export function isEditable(el: Element | null): boolean {
  return !!el && ((el as HTMLElement).isContentEditable === true || !!el.closest?.(EDITABLE));
}

/** Containers whose text would sweep in typed or private content below them. */
const HOLDS_UNREADABLE = `textarea,[data-private],${EDITABLE}`;

/**
 * An element's own visible text, or "" when reading it could leak a value:
 * a field, anything private or editable, or a container holding one.
 */
export function readableText(el: Element): string {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "FORM") return "";
  if (isPrivate(el) || isEditable(el) || el.querySelector(HOLDS_UNREADABLE)) return "";
  return squash((el as HTMLElement).innerText ?? el.textContent);
}

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  A: "link",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  SUMMARY: "button",
  FORM: "form",
};

export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  if (el.tagName === "A" && !el.hasAttribute("href")) return undefined;
  return IMPLICIT_ROLES[el.tagName];
}

/** A short selector a person and a Playwright locator can both use. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++) {
    const tag = node.tagName.toLowerCase();
    const testId = node.getAttribute("data-testid");
    if (testId) {
      parts.unshift(`[data-testid="${testId}"]`);
      break;
    }
    if (node.id && !/\d{3,}/.test(node.id)) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    const name = node.getAttribute("name");
    if (name && (tag === "input" || tag === "select" || tag === "textarea" || tag === "form")) {
      parts.unshift(`${tag}[name="${name}"]`);
      break;
    }
    parts.unshift(tag);
    node = node.parentElement;
    if (node?.tagName === "BODY") break;
  }
  return clip(parts.join(" > "), REPLAY_LIMITS.selector_max_chars);
}

/**
 * What a person would call this element: aria-label, aria-labelledby, its
 * <label>, then (for anything that is not a field) its own text, then title,
 * alt or placeholder. A field's own value is never read.
 */
export function labelOf(el: Element): string {
  const max = REPLAY_LIMITS.label_max_chars;
  if (isPrivate(el)) return "[private]";
  const aria = squash(el.getAttribute("aria-label"));
  if (aria) return clip(aria, max);
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy && doc) {
    const text = squash(labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" "));
    if (text) return clip(text, max);
  }
  if (el.id && doc) {
    const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
    const forLabel = doc.querySelector(`label[for="${id}"]`);
    const text = squash(forLabel?.textContent);
    if (text) return clip(text, max);
  }
  const wrapping = el.closest("label");
  if (wrapping && wrapping !== el) {
    // The wrapping label's text, minus the field itself.
    const text = squash(Array.from(wrapping.childNodes).filter((n) => !(n as Element).tagName || !["INPUT", "TEXTAREA", "SELECT"].includes((n as Element).tagName)).map((n) => n.textContent).join(" "));
    if (text) return clip(text, max);
  }
  const text = readableText(el);
  if (text) return clip(text, max);
  for (const attr of ["title", "alt", "placeholder", "name"]) {
    const v = squash(el.getAttribute(attr));
    if (v) return clip(v, max);
  }
  return el.tagName.toLowerCase();
}

const INTERACTIVE = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=option],[role=switch],[onclick]";

/** Text inside these is never part of the outline. */
const OUTLINE_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "INPUT", "TEXTAREA", "SELECT", "OPTION", "IFRAME", "CANVAS"]);

/**
 * The visible text of the page as a compact outline, at most `max` chars:
 * headings, buttons and links marked, everything else as text lines. Skips
 * fields, [data-private], hidden subtrees and aria-hidden. Bounded twice, by
 * characters and by nodes visited, so a huge page costs the same as a small one.
 */
export function visibleOutline(root: Element | null, max: number = REPLAY_LIMITS.view_outline_max_chars): string {
  if (!root) return "";
  const lines: string[] = [];
  let size = 0;
  let visited = 0;
  let last = "";
  const push = (line: string) => {
    if (!line || line === last || size >= max) return;
    last = line;
    const room = max - size;
    const out = line.length + 1 > room ? line.slice(0, Math.max(0, room - 1)) : line;
    if (!out) return;
    lines.push(out);
    size += out.length + 1;
  };
  const walk = (el: Element) => {
    if (size >= max || visited++ > OUTLINE_MAX_NODES) return;
    if (OUTLINE_SKIP.has(el.tagName.toUpperCase())) return;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-private")) return;
    // An editor's text is what the person typed. The walk starts outside one,
    // so checking the element itself is enough.
    if (el.matches(EDITABLE)) return;
    // display:none, visibility:hidden and content-visibility subtrees. Styles
    // are clean at the moments this runs, so the check reads, not recomputes.
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (check && !check.call(el, { visibilityProperty: true })) return;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const heading = readableText(el);
      return heading ? push(`${"#".repeat(Number(tag[1]))} ${heading}`) : undefined;
    }
    if (tag === "BUTTON" || el.getAttribute("role") === "button") return push(`[button] ${labelOf(el)}`);
    if (tag === "A") return push(`[link] ${labelOf(el)}`);
    let text = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1) {
        if (text.trim()) push(squash(text));
        text = "";
        walk(child as Element);
      }
    }
    if (text.trim()) push(squash(text));
  };
  walk(root);
  return lines.join("\n");
}

/** Query values can carry tokens; keep the keys, drop the values. */
export function cleanUrl(raw: string, base?: string): string {
  try {
    const u = new URL(raw, base);
    for (const key of Array.from(u.searchParams.keys())) u.searchParams.set(key, "");
    u.hash = u.hash ? "#" : "";
    return clip(u.toString(), REPLAY_LIMITS.url_max_chars);
  } catch {
    return clip(raw.split("?")[0], REPLAY_LIMITS.url_max_chars);
  }
}

function formatConsoleArgs(args: unknown[]): string {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return clip(text, REPLAY_LIMITS.console_message_max_chars);
}

function newReplayId(random: () => number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `r${Date.now().toString(36)}${Math.floor(random() * 1e12).toString(36)}`;
}

let active: ReplayRecorder | null = null;

/** Start the recorder. One per page: a second call returns the first. */
export function startReplay(options: ReplayOptions): ReplayRecorder {
  if (active) return active;
  const { sink } = options;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const setTimer = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const win = typeof window !== "undefined" ? window : undefined;
  const doc = typeof document !== "undefined" ? document : undefined;
  const replayId = newReplayId(random);
  const startedAt = now();
  // Every URL the recording keeps goes through the sink's rewrite too, so a
  // page whose address is a credential is named by its shape, not its key.
  const keepUrl = (raw: string, base?: string) => sink.scrubUrl(cleanUrl(raw, base));
  const startUrl = win ? keepUrl(win.location.href) : undefined;
  const t = () => now() - startedAt;
  // The recorder's own traffic (the door, the presigned PUT) never records.
  const ownUrl = (url: string) => url.startsWith(sink.endpoint) || uploadUrls.has(url);
  const uploadUrls = new Set<string>();
  const redacted = (url: string) => {
    if (ownUrl(url)) return true;
    const rule = options.redactUrl;
    if (!rule) return false;
    return typeof rule === "function" ? rule(url) : rule.test(url);
  };
  // fetch as it was before the wrap below, so uploads are not themselves recorded.
  const baseFetch = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);

  let events: ReplayEvent[] = [];
  let kept = (options.sampleRate ?? 0) > 0 && random() < (options.sampleRate ?? 0);
  let stopped = false;
  let chunks = 0;
  let chunkTimer: unknown = null;
  let outlineTimer: unknown = null;
  let lastOutlineAt = -Infinity;
  let lastScrollAt = -Infinity;
  let uploading: Promise<void> | null = null;
  // Uploads that failed in a row. A door that keeps refusing (no replay
  // storage yet, a revoked key) drops the recording back to the ring, so it
  // stops growing and the next error tries again.
  let failures = 0;
  const MAX_FAILURES = 3;
  const counts = { clicks: 0, errors: 0, failed_requests: 0 };
  const cleanups: Array<() => void> = [];

  const push = (event: ReplayEvent) => {
    if (stopped) return;
    events.push(event);
    if (!kept) {
      // The ring: anything older than the window falls off the front.
      const floor = event.t - REPLAY_LIMITS.ring_buffer_ms;
      let drop = 0;
      while (drop < events.length && events[drop].t < floor) drop++;
      if (drop) events = events.slice(drop);
    } else if (events.length >= REPLAY_LIMITS.chunk_max_events) {
      void upload();
    }
  };

  const takeOutline = (force = false) => {
    if (!doc?.body) return;
    const at = now();
    if (!force && at - lastOutlineAt < OUTLINE_MIN_INTERVAL_MS) return;
    lastOutlineAt = at;
    const outline = visibleOutline(doc.body);
    if (outline) push({ type: "view", t: t(), outline });
  };

  const recordNav = () => {
    if (!win) return;
    const href = win.location.href;
    if (redacted(href)) return;
    push({ type: "nav", t: t(), url: keepUrl(href), ...(doc?.title ? { title: clip(doc.title, REPLAY_LIMITS.label_max_chars) } : {}) });
    if (outlineTimer !== null) clearTimer(outlineTimer);
    outlineTimer = setTimer(() => {
      outlineTimer = null;
      takeOutline();
    }, OUTLINE_AFTER_NAV_MS);
  };

  const scheduleChunks = () => {
    if (chunkTimer !== null || stopped) return;
    chunkTimer = setTimer(() => {
      chunkTimer = null;
      void upload();
    }, CHUNK_INTERVAL_MS);
  };

  const putChunk = async (batch: ReplayEvent[]): Promise<boolean> => {
    if (!baseFetch) return false;
    const text = JSON.stringify(batch);
    // Gzipped where the runtime can; the door reads plain JSON chunks too.
    const bytes = (await gzipText(text)) ?? new TextEncoder().encode(text);
    const signed = await sink.signReplayChunk({ replay_id: replayId, seq: chunks, sha256: await sha256Hex(bytes), size: bytes.byteLength });
    if (!signed) return false;
    if ("exists" in signed) return true;
    uploadUrls.add(signed.upload_url);
    try {
      // No Content-Encoding: the object is stored as these exact bytes, and
      // its key names their sha256. Marked gzip, a reader's fetch would
      // decompress it on the way out and the hash would no longer match.
      const res = await baseFetch(signed.upload_url, { method: "PUT", body: bytes });
      return res.ok;
    } catch {
      return false;
    } finally {
      uploadUrls.delete(signed.upload_url);
    }
  };

  // Back to the ring: nothing ships until something keeps the recording again,
  // and memory is bounded by the window instead of growing.
  const dropToRing = () => {
    kept = false;
    const floor = t() - REPLAY_LIMITS.ring_buffer_ms;
    events = events.filter((e) => e.t >= floor);
  };
  const full = () => chunks >= REPLAY_LIMITS.max_chunks_per_replay;

  async function upload(): Promise<void> {
    // A recording that used up its chunks has nowhere to send more.
    if (full()) return dropToRing();
    kept = true;
    if (uploading) return uploading;
    uploading = (async () => {
      while (events.length && !full() && !sink.stopped) {
        let n = Math.min(events.length, REPLAY_LIMITS.chunk_max_events);
        // Halve until the raw JSON fits the chunk cap; gzip only makes it smaller.
        while (n > 1 && JSON.stringify(events.slice(0, n)).length > REPLAY_LIMITS.chunk_max_bytes) n = Math.ceil(n / 2);
        const batch = events.slice(0, n);
        if (!(await putChunk(batch))) {
          // Keep the events for the next attempt, unless the door keeps refusing.
          if (++failures >= MAX_FAILURES) {
            failures = 0;
            dropToRing();
          }
          break;
        }
        failures = 0;
        events = events.slice(n);
        chunks++;
        sink.replay({
          replay_id: replayId,
          ...(startUrl ? { url: startUrl } : {}),
          started_at: startedAt,
          duration_ms: now() - startedAt,
          chunks,
          counts: { ...counts },
        });
      }
    })().finally(() => {
      uploading = null;
    });
    await uploading;
    if (full()) dropToRing();
    if (kept) scheduleChunks();
  }

  const listen = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
    if (!doc) return;
    const handler = (e: DocumentEventMap[K]) => {
      try {
        fn(e);
      } catch {
        // the recorder never breaks the page it watches
      }
    };
    doc.addEventListener(type, handler, { capture: true, passive: true });
    cleanups.push(() => doc.removeEventListener(type, handler, { capture: true }));
  };

  listen("click", (e) => {
    const target = e.target as Element | null;
    if (!target?.closest) return;
    const el = target.closest(INTERACTIVE) ?? target;
    counts.clicks++;
    const text = readableText(el);
    const label = labelOf(el);
    const role = roleOf(el);
    push({
      type: "click",
      t: t(),
      label,
      ...(role ? { role } : {}),
      selector: selectorOf(el),
      ...(text && text !== label ? { text: clip(text, REPLAY_LIMITS.label_max_chars) } : {}),
    });
  });

  const fieldNames = new WeakMap<Element, { label: string; selector: string }>();
  // Typing becomes one event per field and burst: the newest keystroke
  // replaces the previous one for the same field. Only the length is kept.
  const onField = (e: Event) => {
    const el = e.target as HTMLInputElement | null;
    if (!el?.tagName) return;
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    // A checkbox, radio or select change is a choice, not typing: its click
    // (or the select's change) already names it; a length would mean nothing.
    const value = typeof el.value === "string" ? el.value : (el.textContent ?? "");
    // Typing fires per keystroke; a field's name and selector are read once.
    let names = fieldNames.get(el);
    if (!names) fieldNames.set(el, (names = { label: labelOf(el), selector: selectorOf(el) }));
    const { selector } = names;
    const event: ReplayEvent = { type: "input", t: t(), label: names.label, selector, length: type === "checkbox" || type === "radio" ? 0 : value.length, redacted: true };
    const prev = events[events.length - 1];
    if (prev?.type === "input" && prev.selector === selector) events[events.length - 1] = event;
    else push(event);
  };
  listen("input", onField);
  listen("change", onField);

  listen("submit", (e) => {
    const form = e.target as Element | null;
    if (!form?.tagName) return;
    push({ type: "submit", t: t(), label: labelOf(form), selector: selectorOf(form) });
  });

  listen("keydown", (e) => {
    if ((REPLAY_KEYS as readonly string[]).includes(e.key)) push({ type: "key", t: t(), key: e.key as ReplayKey });
  });

  if (win) {
    const onScroll = () => {
      const at = now();
      if (at - lastScrollAt < REPLAY_LIMITS.scroll_min_interval_ms) return;
      lastScrollAt = at;
      push({ type: "scroll", t: t(), y: Math.round(win.scrollY), of: Math.round(doc?.documentElement?.scrollHeight ?? 0) });
    };
    win.addEventListener("scroll", onScroll, { passive: true });
    cleanups.push(() => win.removeEventListener("scroll", onScroll));

    // Navigation: the History API is patched, popstate is listened to.
    const history = win.history;
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        try {
          recordNav();
        } catch {
          // never break navigation
        }
        return result;
      } as History["pushState"];
      cleanups.push(() => {
        history[method] = original;
      });
    }
    win.addEventListener("popstate", recordNav);
    cleanups.push(() => win.removeEventListener("popstate", recordNav));

    // A page going away ships what a kept recording holds, best effort.
    const onHide = () => {
      if (kept) void upload();
    };
    win.addEventListener("pagehide", onHide);
    cleanups.push(() => win.removeEventListener("pagehide", onHide));
  }

  // Console warn and error, passed through unchanged.
  if (typeof console !== "undefined") {
    for (const level of REPLAY_CONSOLE_LEVELS) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        try {
          push({ type: "console", t: t(), level, message: formatConsoleArgs(args) });
        } catch {
          // fall through to the real console
        }
        return original.apply(console, args);
      };
      cleanups.push(() => {
        console[level] = original;
      });
    }
  }

  const recordRequest = (method: string, url: string, status: number, ms: number) => {
    if (redacted(url)) return;
    const failed = status === 0 || status >= 400;
    if (!failed && ms < REPLAY_LIMITS.network_slow_ms) return;
    if (failed) counts.failed_requests++;
    push({ type: "network", t: t(), method: method.toUpperCase(), url: keepUrl(url, win?.location.href), status, ms: Math.round(ms) });
  };

  if (typeof globalThis.fetch === "function") {
    const original = globalThis.fetch;
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
      const started = now();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
      try {
        const res = await original.call(globalThis, input as RequestInfo, init);
        recordRequest(method, url, res.status, now() - started);
        return res;
      } catch (error) {
        recordRequest(method, url, 0, now() - started);
        throw error;
      }
    };
    globalThis.fetch = wrapped as typeof fetch;
    cleanups.push(() => {
      if (globalThis.fetch === (wrapped as typeof fetch)) globalThis.fetch = original;
    });
  }

  const Xhr = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : undefined;
  if (Xhr) {
    const { open, send } = Xhr.prototype;
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();
    Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      meta.set(this, { method, url: String(url), started: 0 });
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof open;
    Xhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this);
      if (m) {
        m.started = now();
        this.addEventListener("loadend", () => recordRequest(m.method, m.url, this.status, now() - m.started), { once: true });
      }
      return send.call(this, body);
    };
    cleanups.push(() => {
      Xhr.prototype.open = open;
      Xhr.prototype.send = send;
    });
  }

  // Errors arrive through the sink, so the recorder sees exactly what was
  // reported, after the same dedupe and filters, with no listener of its own.
  cleanups.push(
    sink.onError((item: CodecastErrorItem) => {
      counts.errors++;
      takeOutline();
      push({
        type: "error",
        t: t(),
        message: clip(item.message, REPLAY_LIMITS.console_message_max_chars),
        ...(item.stack ? { stack: clip(item.stack, REPLAY_LIMITS.error_stack_max_chars) } : {}),
      });
      void upload();
    }),
  );
  sink.setReplayId(replayId);
  cleanups.push(() => sink.setReplayId(undefined));

  recordNav();
  if (kept) scheduleChunks();

  const recorder: ReplayRecorder = {
    replayId,
    get kept() {
      return kept;
    },
    get events() {
      return events;
    },
    mark(name, data) {
      let bounded = data;
      if (data) {
        try {
          if (JSON.stringify(data).length > REPLAY_LIMITS.mark_data_max_chars) bounded = { _truncated: true };
        } catch {
          bounded = undefined;
        }
      }
      push({ type: "mark", t: t(), name: clip(name, REPLAY_LIMITS.label_max_chars), ...(bounded ? { data: bounded } : {}) });
    },
    upload,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      if (chunkTimer !== null) clearTimer(chunkTimer);
      if (outlineTimer !== null) clearTimer(outlineTimer);
      chunkTimer = outlineTimer = null;
      if (active === recorder) active = null;
    },
  };
  active = recorder;
  return recorder;
}
