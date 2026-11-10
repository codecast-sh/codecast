/**
 * Bot challenges and block pages, noticed after a verb lands on one.
 *
 * Sites behind Cloudflare, Akamai, DataDome, PerimeterX (HUMAN), Imperva or AWS
 * WAF sometimes answer a visit with an interstitial instead of the page. An
 * agent that does not recognise one reads "Just a moment..." as the page,
 * retries, reloads, and turns a soft check into a hard block on the human's IP
 * and account. So after a verb that navigated, one probe reads a few signals
 * from the page and classifies it:
 *
 *   - `clears-itself`: an interstitial the browser clears on its own
 *     (Cloudflare's "Just a moment...", Akamai's and AWS WAF's silent
 *     challenges, a DataDome device check). We wait for it, up to 15 s.
 *   - `needs-person`: a challenge only a person should answer (a Turnstile or
 *     reCAPTCHA/hCaptcha checkbox, "Press & Hold", a DataDome or AWS WAF
 *     captcha). Never touched: the agent is told to hand it to the human.
 *   - `blocked`: the site refused the visit outright. The agent is told to
 *     stop; retrying makes it worse.
 *
 * The signatures are OpenCode browse's (execute/challenge-detection.ts): vendor
 * markers (challenge frames and scripts, element ids the vendors' pages use)
 * and title/text phrases, the generic phrases counting only on short pages so
 * an article that mentions "access denied" is not a challenge. Deliberately
 * conservative: a miss costs an agent turn, a false positive a 15 s wait or a
 * needless handoff.
 *
 * Pure apart from the page-side probe source, which the engine evaluates.
 */

export type ChallengeVendor =
  | "cloudflare" | "akamai" | "datadome" | "perimeterx" | "imperva" | "aws-waf" | "recaptcha" | "hcaptcha" | "generic";

export type ChallengeKind = "clears-itself" | "needs-person" | "blocked";

export interface ChallengeDetection {
  vendor: ChallengeVendor;
  kind: ChallengeKind;
  /** The marker that matched ("title: Just a moment...", "iframe challenges.cloudflare.com/..."). */
  signal: string;
}

/** What the probe reads from the page. Every field is bounded by the probe. */
export interface ChallengeProbe {
  url: string;
  title: string;
  /** body.innerText, first 3000 characters. */
  text: string;
  /** Full innerText length, to tell short interstitials from long pages. */
  textLength: number;
  /** iframe src values, first 50. */
  frameUrls: string[];
  /** script src values, first 50. */
  scriptSrcs: string[];
  /** Which of PROBE_SELECTORS matched an element. */
  selectors: string[];
  /** Which matched elements have a non-zero size. */
  visibleSelectors: string[];
  /** ms since this document started: tells whether a click navigated. */
  sinceLoad: number;
}

/** Element markers the probe checks. Keep in step with `classifyChallenge`. */
export const PROBE_SELECTORS = [
  // Cloudflare
  "#challenge-form", "#challenge-running", "#challenge-stage", "#cf-challenge-running", ".cf-turnstile", "#cf-error-details",
  // Akamai Bot Manager
  "#sec-if-cpt-container", "#sec-cpt-if", "#sec-text-if",
  // DataDome
  "#ddv1-captcha-container",
  // PerimeterX / HUMAN
  "#px-captcha", "#px-captcha-wrapper", "[id^='px-captcha']",
  // Imperva / Incapsula
  "#main-iframe[src*='_Incapsula_Resource']",
  // AWS WAF
  "#captcha-container awswaf-captcha", "awswaf-captcha", "#challenge-container",
] as const;

/** One synchronous expression for the engine's `eval`, returning the probe as
 *  a JSON string. Reads only; touches nothing on the page. */
export const CHALLENGE_PROBE_SOURCE = `(() => {
  const selectors = ${JSON.stringify(PROBE_SELECTORS)};
  const body = document.body;
  const text = body ? body.innerText || "" : "";
  const matched = [], visible = [];
  for (const s of selectors) {
    let el = null;
    try { el = document.querySelector(s); } catch {}
    if (!el) continue;
    matched.push(s);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) visible.push(s);
  }
  return JSON.stringify({
    url: location.href,
    title: (document.title || "").slice(0, 300),
    text: text.slice(0, 3000),
    textLength: text.length,
    frameUrls: Array.from(document.querySelectorAll("iframe"), (f) => f.src).filter(Boolean).slice(0, 50),
    scriptSrcs: Array.from(document.scripts, (s) => s.src).filter(Boolean).slice(0, 50),
    selectors: matched,
    visibleSelectors: visible,
    sinceLoad: performance.now(),
  });
})()`;

/** Parse the probe's answer from the engine (`eval --json` envelope or bare). */
export function parseChallengeProbe(stdout: string): ChallengeProbe | null {
  try {
    let v: unknown = JSON.parse(stdout.trim());
    if (v && typeof v === "object" && "data" in (v as object)) v = (v as { data: { result?: unknown } }).data?.result;
    if (typeof v === "string") v = JSON.parse(v);
    const p = v as Partial<ChallengeProbe>;
    if (!p || typeof p.url !== "string" || typeof p.title !== "string") return null;
    return {
      url: p.url,
      title: p.title,
      text: typeof p.text === "string" ? p.text : "",
      textLength: typeof p.textLength === "number" ? p.textLength : 0,
      frameUrls: Array.isArray(p.frameUrls) ? p.frameUrls : [],
      scriptSrcs: Array.isArray(p.scriptSrcs) ? p.scriptSrcs : [],
      selectors: Array.isArray(p.selectors) ? p.selectors : [],
      visibleSelectors: Array.isArray(p.visibleSelectors) ? p.visibleSelectors : [],
      sinceLoad: typeof p.sinceLoad === "number" ? p.sinceLoad : Infinity,
    };
  } catch {
    return null;
  }
}

const shortPage = (p: ChallengeProbe): boolean => p.textLength < 1_500;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const hasFrame = (p: ChallengeProbe, re: RegExp) => p.frameUrls.find((u) => re.test(u));
const hasScript = (p: ChallengeProbe, re: RegExp) => p.scriptSrcs.find((s) => re.test(s));
const has = (p: ChallengeProbe, sel: string) => p.selectors.includes(sel);
const visible = (p: ChallengeProbe, sel: string) => p.visibleSelectors.includes(sel);
const clip = (s: string) => s.slice(0, 160);

/** Classify a probed page, or null when it is not a challenge or block page. */
export function classifyChallenge(p: ChallengeProbe): ChallengeDetection | null {
  if (!/^https?:/i.test(p.url)) return null;
  const title = p.title.trim().toLowerCase();
  const text = p.text.toLowerCase();
  const host = hostOf(p.url);

  // Cloudflare
  if (/sorry, you have been blocked/.test(text) && (has(p, "#cf-error-details") || /cloudflare/.test(text))) {
    return { vendor: "cloudflare", kind: "blocked", signal: "text: Sorry, you have been blocked" };
  }
  // Only the full-page interstitial counts. A Turnstile widget embedded in a
  // login or signup form is part of that page: its iframe stays after it is
  // solved, so waiting for it to go away would fail a page that works. The
  // challenge's element ids count on a short page or beside Cloudflare's own
  // challenge script, since an ordinary page may use an id like
  // "challenge-form" for something else.
  const cfTitle = /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(title);
  const cfElements = has(p, "#challenge-form") || has(p, "#challenge-running") || has(p, "#cf-challenge-running") || has(p, "#challenge-stage");
  const cfScript = hasScript(p, /\/cdn-cgi\/challenge-platform\//);
  if (cfTitle || (cfElements && (shortPage(p) || cfScript))) {
    // The managed challenge shows Turnstile's checkbox only when it wants a click; until then it clears itself.
    const widget = visible(p, ".cf-turnstile") || /verify you are human by completing|click to verify|confirm you are human/.test(text);
    return {
      vendor: "cloudflare",
      kind: widget ? "needs-person" : "clears-itself",
      signal: clip(cfTitle ? `title: ${p.title.trim()}` : `element ${["#challenge-form", "#challenge-running", "#cf-challenge-running", "#challenge-stage"].find((s) => has(p, s))}`),
    };
  }

  // PerimeterX / HUMAN: its captcha element, or "Press & Hold" on a short
  // page that loads PerimeterX. The phrase alone is ordinary help-page text
  // ("press and hold the side button").
  const pxElement = has(p, "#px-captcha") || has(p, "#px-captcha-wrapper") || has(p, "[id^='px-captcha']");
  const pxResource = hasScript(p, /px-cdn\.net|px-cloud\.net|perimeterx\.net|pxchk\.net/) ?? hasFrame(p, /px-cdn\.net|px-cloud\.net|perimeterx\.net/);
  if (pxElement || (pxResource && shortPage(p) && /press (?:&|and) hold/.test(text))) {
    return { vendor: "perimeterx", kind: "needs-person", signal: pxElement ? "element #px-captcha" : "text: Press & Hold" };
  }

  // DataDome
  const ddFrame = hasFrame(p, /captcha-delivery\.com/);
  if (ddFrame || has(p, "#ddv1-captcha-container")) {
    const interstitial = ddFrame !== undefined && /\/interstitial\//.test(ddFrame);
    return {
      vendor: "datadome",
      kind: interstitial ? "clears-itself" : "needs-person",
      signal: clip(ddFrame ? `iframe ${ddFrame}` : "element #ddv1-captcha-container"),
    };
  }

  // Akamai Bot Manager
  if (has(p, "#sec-if-cpt-container") || has(p, "#sec-cpt-if") || has(p, "#sec-text-if")) {
    const interactive = visible(p, "#sec-cpt-if") && /verify|press|slide|captcha/.test(text);
    return { vendor: "akamai", kind: interactive ? "needs-person" : "clears-itself", signal: "element #sec-if-cpt-container" };
  }
  if (title === "access denied" && /you don't have permission to access/.test(text) && /reference #?\d/.test(text)) {
    return { vendor: "akamai", kind: "blocked", signal: "title: Access Denied (Akamai reference)" };
  }

  // Imperva / Incapsula
  const incapsula = hasFrame(p, /_Incapsula_Resource/) ?? hasScript(p, /_Incapsula_Resource/);
  if (incapsula || has(p, "#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha = /captcha|verify you are human|i am human/.test(text) || hasFrame(p, /hcaptcha|recaptcha/) !== undefined;
    if (/request unsuccessful|incapsula incident id/.test(text) && !captcha) {
      return { vendor: "imperva", kind: "blocked", signal: "text: Request unsuccessful (Incapsula)" };
    }
    return { vendor: "imperva", kind: captcha ? "needs-person" : "clears-itself", signal: clip(`resource ${incapsula ?? "_Incapsula_Resource"}`) };
  }
  if (/incapsula incident id/.test(text) && shortPage(p)) {
    return { vendor: "imperva", kind: "blocked", signal: "text: Incapsula incident ID" };
  }

  // AWS WAF
  if (has(p, "awswaf-captcha") || has(p, "#captcha-container awswaf-captcha")) {
    return { vendor: "aws-waf", kind: "needs-person", signal: "element awswaf-captcha" };
  }
  const awsScript = hasScript(p, /\.awswaf\.com\//);
  if (awsScript && shortPage(p) && (has(p, "#challenge-container") || p.textLength < 300)) {
    return { vendor: "aws-waf", kind: "clears-itself", signal: clip(`script ${awsScript}`) };
  }

  if (shortPage(p)) {
    // Captcha walls: a page that is mostly a reCAPTCHA or hCaptcha widget.
    const recaptcha = hasFrame(p, /^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor/);
    const hcaptcha = hasFrame(p, /^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\//);
    const wallText =
      /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha|captcha/.test(text) ||
      /captcha|security check|verify/.test(title);
    if (hcaptcha && wallText) return { vendor: "hcaptcha", kind: "needs-person", signal: clip(`iframe ${hcaptcha}`) };
    if (recaptcha && wallText) return { vendor: "recaptcha", kind: "needs-person", signal: clip(`iframe ${recaptcha}`) };
    // Google's own "unusual traffic" interstitial.
    if (/^www\.google\./.test(host) && /\/sorry\//.test(p.url)) return { vendor: "recaptcha", kind: "needs-person", signal: "url: google.com/sorry" };

    // Generic block and verification pages.
    if (
      /^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(title) ||
      /^(?:access to this page has been denied|access denied)\b/.test(text.trim())
    ) {
      return { vendor: "generic", kind: "blocked", signal: clip(`title: ${p.title.trim() || text.trim().slice(0, 60)}`) };
    }
    const both = `${title}\n${text}`;
    if (/verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|bot (?:check|detection)/.test(both)) {
      const hit = /verify[^.\n]*human|confirm[^.\n]*human|are you a robot|pardon our interruption|bot (?:check|detection)/.exec(both)?.[0] ?? "verification";
      return { vendor: "generic", kind: "needs-person", signal: clip(`text: ${hit}`) };
    }
  }
  return null;
}

export interface ChallengeOutcome extends ChallengeDetection {
  /** cleared: the interstitial went away while we waited. */
  cleared: boolean;
  url: string;
  waitedMs: number;
}

export const CHALLENGE_WAIT_MS = 15_000;
export const CHALLENGE_POLL_MS = 1_000;

/** How long to wait for a challenge that clears itself
 *  (CAST_BROWSER_CHALLENGE_WAIT_MS, 0 to 60000). */
export function challengeWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAST_BROWSER_CHALLENGE_WAIT_MS;
  const v = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(v) && v >= 0 && v <= 60_000 ? v : CHALLENGE_WAIT_MS;
}

export interface ChallengeDeps {
  /** One probe of the page; null while it cannot answer (mid-navigation). */
  probe: () => Promise<ChallengeProbe | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Classify the page a verb left; wait out a challenge that clears itself for
 * up to `waitMs`. Null when there is none. `first` is the probe already taken.
 */
export async function awaitChallenge(first: ChallengeProbe, deps: ChallengeDeps, waitMs: number): Promise<ChallengeOutcome | null> {
  const detected = classifyChallenge(first);
  if (!detected) return null;
  const started = deps.now();
  let current = detected;
  let url = first.url;
  while (current.kind === "clears-itself" && deps.now() - started < waitMs) {
    await deps.sleep(Math.min(CHALLENGE_POLL_MS, Math.max(0, waitMs - (deps.now() - started))));
    // A probe that fails mid-navigation (the challenge often clears by navigating) counts as still waiting.
    const probe = await deps.probe().catch(() => null);
    if (!probe) continue;
    url = probe.url;
    const next = classifyChallenge(probe);
    if (!next) return { ...current, cleared: true, url, waitedMs: deps.now() - started };
    current = next;
  }
  const waited = current === detected && detected.kind !== "clears-itself" ? 0 : deps.now() - started;
  return { ...current, cleared: false, url, waitedMs: waited };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** What the verb prints about it: one line the agent acts on. */
export function challengeReport(o: ChallengeOutcome): string {
  const where = originOf(o.url);
  if (o.cleared) return `a ${o.vendor} check on ${where} cleared by itself after ${Math.round(o.waitedMs / 1000)} s`;
  const waited = o.waitedMs > 0 ? `, still there after ${Math.round(o.waitedMs / 1000)} s` : "";
  if (o.kind === "blocked") {
    return (
      `${where} refused the visit: a ${o.vendor} block page (${o.signal}). Stop here. Do not retry or reload: ` +
      `repeated attempts make the block worse for the human's IP and account. Tell the human.`
    );
  }
  return (
    `${where} is showing a ${o.vendor} security check that needs a person (${o.signal}${waited}). ` +
    `Do not try to solve it, retry or reload. Hand it to the human: ask them to complete the check in this tab ` +
    `(\`cast browser show\` brings it forward), then continue once they say it is done.`
  );
}
