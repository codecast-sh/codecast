/**
 * A snapshot that describes one page at one moment.
 *
 * The engine reads the accessibility tree in one pass, but a page can be in the
 * middle of changing while it does: a React list re-rendering after a click, a
 * spinner swapping for results, a redirect landing mid-capture. The snapshot
 * then mixes two states, or describes a document that is already gone, and
 * every ref minted from it points at the wrong thing.
 *
 * So after the engine captures, one probe asks the page two questions:
 *
 *   - Is this document younger than the capture? `performance.now()` counts
 *     from the document's own start, so a value smaller than the time the
 *     capture took means the main frame navigated while we read it. Recapture,
 *     up to three times, a moment apart.
 *   - Did the DOM change during the capture? A mutation clock installed at
 *     document start (the engine's init script, engine.ts) records when the
 *     tree last changed. If that was inside the capture, wait for the DOM to go
 *     quiet (55 ms without a mutation, 550 ms at most) and recapture once.
 *
 * The numbers are OpenCode browse's (snapshot.ts), which tuned them against
 * real apps. A page that never stops mutating (a carousel, a ticking clock)
 * costs at most the 550 ms cap and one extra capture, never a loop.
 *
 * The probe also returns the page URL, which the ref table records so a stale
 * ref is never recovered onto a different page (refMemory.ts), and the values
 * of password, one-time-code and card fields, which the snapshot text then
 * omits (redaction.ts redactSnapshotValues).
 *
 * The probe runs through the engine's own `eval`, which does not await
 * promises, so the quiet wait is a short poll from here rather than a promise
 * in the page.
 */

/** Installs the mutation clock once per document. Runs as part of the init
 *  script at document start, and again from the probe for a page that loaded
 *  before the script was registered. `last` is when anything changed. `gone`
 *  maps the accessible-name candidates of every interactive element that
 *  left the page (aria-label, text, title, alt, placeholder; "" for an
 *  unnamed one) to when it left: the engine re-aims a ref only when its own
 *  node is gone, so that is the one change that can move a ref onto a
 *  namesake (refMemory.ts preflightRefPlan). `__castDoc` names the document,
 *  so a reload of the same URL is told apart from the page a snapshot read. */
export const MUTATION_CLOCK_SOURCE = `(() => {
  if (window.__castSettle && window.__castSettle.gone) return;
  const m = { last: -1, gone: new Map() };
  window.__castSettle = m;
  if (!window.__castDoc) window.__castDoc = Math.random().toString(36).slice(2);
  const interactive = "a[href],button,input,select,textarea,summary,option,[role],[tabindex],[contenteditable]";
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const names = (el) => {
    const out = [el.getAttribute("aria-label"), el.textContent, el.getAttribute("title"), el.getAttribute("alt"), el.getAttribute("placeholder")];
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) out.push(el.value);
    const got = out.map(norm).filter(Boolean);
    return got.length ? got : [""];
  };
  const note = (el, now) => {
    let seen = 0;
    const each = (e) => { for (const n of names(e)) { if (m.gone.size >= 2000) m.gone.clear(); m.gone.set(n.slice(0, 200), now); } };
    if (el.matches && el.matches(interactive)) each(el);
    if (el.querySelectorAll) for (const e of el.querySelectorAll(interactive)) { if (++seen > 300) break; each(e); }
  };
  try {
    new MutationObserver((records) => {
      const now = performance.now();
      m.last = now;
      for (const r of records) if (r.type === "childList") for (const n of r.removedNodes) if (n.nodeType === 1) note(n, now);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch {}
})()`;

/**
 * Values a snapshot must not show. Password fields always, and fields that
 * hold one-time codes, PINs or card numbers by their type, name, id or
 * autocomplete; every text field's value when the agent asks for
 * `--redact-values`. Read in the page because the accessibility tree does not
 * say which textbox is a password field.
 */
const HIDDEN_VALUES_SOURCE = (all: boolean) => `(() => {
  const all = ${all ? "true" : "false"};
  // By what the field is, never by a substring of its name: "pass" is also
  // passenger, passport and compass. A password input; an autocomplete token
  // for a password, one-time code or card secret; or a name or id whose whole
  // words include otp, pin, cvc, cvv, csc or ssn.
  const secretAuto = /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)$/;
  const secretWord = /^(otp|totp|pin|cvc|cvv|csc|ssn)$/;
  const words = (s) => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const skip = ["checkbox", "radio", "submit", "button", "hidden", "file", "image", "reset", "range", "color"];
  const out = [];
  for (const el of document.querySelectorAll("input, textarea")) {
    const v = el.value;
    if (!v || out.length >= 50) continue;
    const t = (el.type || "").toLowerCase();
    if (skip.includes(t)) continue;
    const auto = String(el.autocomplete || "").toLowerCase().split(/\\s+/);
    const named = [...words(el.name), ...words(el.id)].some((w) => secretWord.test(w));
    if (all || t === "password" || auto.some((a) => secretAuto.test(a)) || named) out.push(String(v).slice(0, 200));
  }
  return out;
})()`;

/** One synchronous expression for the engine's `eval`: installs the clock if
 *  the page has none, reads it, and lists the values to hide. */
export function settleProbeSource(redactAllValues = false, refName?: string): string {
  return `(() => {
  const fresh = !(window.__castSettle && window.__castSettle.gone);
  ${MUTATION_CLOCK_SOURCE};
  const now = performance.now();
  const last = window.__castSettle ? window.__castSettle.last : -1;
  const asked = ${refName === undefined ? "undefined" : JSON.stringify(refName.replace(/\s+/g, " ").trim().slice(0, 200))};
  const goneAt = asked === undefined || fresh || !window.__castSettle ? null : window.__castSettle.gone.has(asked) ? window.__castSettle.gone.get(asked) : -1;
  let hidden = [];
  try { hidden = ${HIDDEN_VALUES_SOURCE(redactAllValues)}; } catch {}
  return JSON.stringify({
    url: location.href,
    sinceLoad: now,
    sinceMutation: fresh ? null : last < 0 ? now : now - last,
    doc: window.__castDoc || null,
    goneAt,
    hidden,
  });
})()`;
}

export interface SettleProbe {
  url: string;
  /** ms since this document started. */
  sinceLoad: number;
  /** ms since the DOM last changed; null when the clock was only just
   *  installed and cannot know. */
  sinceMutation: number | null;
  /** This document's token; null when the page could not hold one. */
  doc: string | null;
  /** For a probe asked about one name: page time (performance.now) an
   *  interactive element of that name last left the page; -1 never, null
   *  when not asked or the clock was only just installed and cannot know. */
  goneAt: number | null;
  /** Field values the snapshot text must not show. */
  hidden: string[];
}

/** The page a snapshot described: what the ref table records with its refs
 *  (refMemory.ts), so an action on a ref can check the page is still that
 *  one. `at` is the page's own clock when it was read. */
export interface PageStamp {
  url: string;
  doc: string | null;
  at: number;
}

export function pageStamp(p: SettleProbe): PageStamp {
  return { url: p.url, doc: p.doc, at: p.sinceLoad };
}

export const QUIET_MS = 55;
export const SETTLE_CAP_MS = 550;
/** A clock installed by the probe has seen nothing yet; watch this long
 *  before calling the page quiet. */
export const FIRST_LOOK_MS = 120;
export const NAV_RETRY_DELAY_MS = 100;
export const MAX_CAPTURES = 3;

/** Parse the probe's answer (the engine prints the returned string as JSON). */
export function parseSettleProbe(stdout: string): SettleProbe | null {
  try {
    let v: unknown = JSON.parse(stdout.trim());
    if (v && typeof v === "object" && "data" in (v as object)) v = (v as { data: { result?: unknown } }).data?.result;
    if (typeof v === "string") v = JSON.parse(v);
    const p = v as Partial<SettleProbe>;
    if (!p || typeof p.url !== "string" || typeof p.sinceLoad !== "number") return null;
    return {
      url: p.url,
      sinceLoad: p.sinceLoad,
      sinceMutation: typeof p.sinceMutation === "number" ? p.sinceMutation : null,
      doc: typeof p.doc === "string" ? p.doc : null,
      goneAt: typeof p.goneAt === "number" ? p.goneAt : null,
      hidden: Array.isArray(p.hidden) ? p.hidden.filter((v): v is string => typeof v === "string") : [],
    };
  } catch {
    return null;
  }
}

/**
 * What a probe taken right after a capture says to do. `elapsedMs` is how long
 * ago the capture began, measured here.
 *
 *   - `navigated`: the document is younger than the capture.
 *   - `mutated`: the DOM changed after the capture began.
 *   - `unknown`: the clock was just installed; take a first look.
 *   - `stable`: nothing moved.
 */
export function judgeCapture(probe: SettleProbe, elapsedMs: number): "navigated" | "mutated" | "unknown" | "stable" {
  if (probe.sinceLoad < elapsedMs) return "navigated";
  if (probe.sinceMutation === null) return "unknown";
  return probe.sinceMutation < elapsedMs ? "mutated" : "stable";
}

export interface CaptureRun {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SettleDeps<R extends CaptureRun> {
  capture: () => R;
  probe: () => SettleProbe | null;
  sleep: (ms: number) => void;
  now: () => number;
}

export interface SettledCapture<R extends CaptureRun> {
  res: R;
  /** The page the kept capture describes, or null when the probe could not
   *  read it. */
  page: PageStamp | null;
  /** Field values to keep out of the kept capture's text. */
  hidden: string[];
  /** Set when the main frame kept navigating through every attempt. */
  navigating?: boolean;
  /** How many captures it took, for tests and narration. */
  captures: number;
}

/**
 * Capture, then recapture while the page is moving, within the bounds above.
 * Synchronous because its callers are (findRefs, stale-ref recovery); the
 * waits are tens of milliseconds and only happen on a page that is changing.
 */
export function captureSettled<R extends CaptureRun>(deps: SettleDeps<R>): SettledCapture<R> {
  let settledOnce = false;
  for (let captures = 1; ; captures++) {
    const began = deps.now();
    const res = deps.capture();
    if (res.status !== 0) return { res, page: null, hidden: [], captures };
    const probe = deps.probe();
    if (!probe) return { res, page: null, hidden: [], captures };
    const kept = { res, page: pageStamp(probe), hidden: probe.hidden, captures };
    const verdict = judgeCapture(probe, deps.now() - began);
    if (verdict === "navigated") {
      if (captures >= MAX_CAPTURES) return { ...kept, navigating: true };
      deps.sleep(NAV_RETRY_DELAY_MS);
      continue;
    }
    if (verdict === "stable" || settledOnce) return kept;
    // Mutated, or not yet known: wait for quiet, then decide.
    const moved = waitForQuiet(deps, verdict === "unknown");
    if (!moved) return kept;
    settledOnce = true;
  }
}

/**
 * Poll until the DOM has been quiet for QUIET_MS, or SETTLE_CAP_MS has passed.
 * Returns whether the page changed at all while being watched (on a first
 * look, nothing changing means the capture already stands).
 */
function waitForQuiet<R extends CaptureRun>(deps: SettleDeps<R>, firstLook: boolean): boolean {
  const start = deps.now();
  let moved = !firstLook;
  let wait = firstLook ? FIRST_LOOK_MS : QUIET_MS;
  while (deps.now() - start < SETTLE_CAP_MS) {
    deps.sleep(Math.min(wait, SETTLE_CAP_MS - (deps.now() - start)));
    const p = deps.probe();
    if (!p) return moved;
    const since = p.sinceMutation ?? Infinity;
    const watched = deps.now() - start;
    if (since < watched) moved = true;
    if (since >= QUIET_MS) return moved;
    wait = QUIET_MS - since;
  }
  return moved;
}

/** A synchronous sleep, for the waits above. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
