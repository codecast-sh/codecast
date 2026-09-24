import type { MiddlewareHandler } from "hono";
import { CONVEX_URL } from "./convexUrl";

const CONVEX = new URL(CONVEX_URL);
const CONVEX_HTTP = CONVEX.origin;
const CONVEX_WS = `wss://${CONVEX.host}`;
const LOOPBACK = "http://127.0.0.1:* http://localhost:*";
const LOOPBACK_WS = "ws://127.0.0.1:* ws://localhost:*";
const POSTHOG = "https://us.i.posthog.com https://us-assets.i.posthog.com";
const GOOGLE_ADS = "https://www.googletagmanager.com https://www.google.com https://googleads.g.doubleclick.net https://www.googleadservices.com";
const AVATARS = "https://avatars.githubusercontent.com https://*.googleusercontent.com https://avatars.slack-edge.com https://a.slack-edge.com https://*.gravatar.com";

// The document policy, sent REPORT-ONLY (PARENT-10). It is the draft of the
// policy we would enforce, so the reports it collects say exactly what
// enforcing it would break. Nothing here blocks anything in a browser; moving
// to the enforcing header is a separate decision made from those reports.
// Every source and why it is needed: plans/security-csp-draft.md.
export const DOCUMENT_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${POSTHOG} ${GOOGLE_ADS}`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  `media-src 'self' blob: ${CONVEX_HTTP} ${LOOPBACK}`,
  `connect-src 'self' ${CONVEX_HTTP} ${CONVEX_WS} ${POSTHOG} https://*.ingest.us.sentry.io ${LOOPBACK} ${LOOPBACK_WS} wss://api.openai.com https://*.livekit.cloud wss://*.livekit.cloud ${AVATARS} ${GOOGLE_ADS}`,
  `frame-src 'self' https: ${LOOPBACK}`,
  "worker-src 'self'",
  `object-src ${CONVEX_HTTP}`,
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://local.codecast.sh",
].join("; ");

// max-age only: no includeSubDomains (other hosts under codecast.sh are not
// ours to pin) and no preload. One day while the first reports come in; the
// review in plans/security-closure-ledger.json raises it.
export const HSTS = "max-age=86400";

// Sentry's CSP security endpoint for a DSN, or null when the DSN is missing or
// not a Sentry DSN. The key in a DSN is public (it ships in the client bundle).
export function cspReportEndpoint(
  dsn: string | undefined,
  tags: { environment?: string; release?: string },
): string | null {
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const project = url.pathname.replace(/^\/+|\/+$/g, "");
  if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(project)) return null;
  const endpoint = new URL(`https://${url.host}/api/${project}/security/`);
  endpoint.searchParams.set("sentry_key", url.username);
  if (tags.environment) endpoint.searchParams.set("sentry_environment", tags.environment);
  if (tags.release) endpoint.searchParams.set("sentry_release", tags.release);
  return endpoint.toString();
}

export interface ResponsePolicyOptions {
  sentryDsn?: string;
  environment?: string;
  release?: string;
  // Fraction of HTML documents that carry the report directives. The policy
  // itself is on every document; only the reporting is sampled. One document
  // covers a whole app session, because the SPA never reloads it.
  sampleRate?: number;
  // Hard ceiling on reporting documents per hour for this process, so a burst
  // of traffic cannot turn into a burst of Sentry events.
  maxReportingPerHour?: number;
  random?: () => number;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

export function createResponsePolicy(options: ResponsePolicyOptions = {}): MiddlewareHandler {
  const { sampleRate = 0.1, maxReportingPerHour = 120, random = Math.random, now = Date.now } = options;
  const endpoint = cspReportEndpoint(options.sentryDsn, options);
  let windowStart = -Infinity;
  let reportedInWindow = 0;

  const shouldReport = () => {
    if (!endpoint || random() >= sampleRate) return false;
    const t = now();
    if (t - windowStart >= HOUR_MS) {
      windowStart = t;
      reportedInWindow = 0;
    }
    if (reportedInWindow >= maxReportingPerHour) return false;
    reportedInWindow++;
    return true;
  };

  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), clipboard-read=(self), clipboard-write=(self)");
    c.header("Strict-Transport-Security", HSTS);
    if (!c.res.headers.get("Content-Type")?.includes("text/html")) return;
    if (shouldReport()) {
      // report-uri for Firefox and Safari; Chrome prefers report-to when the
      // named endpoint exists. Reporting-Endpoints, not Report-To: Cloudflare
      // sets its own Report-To for network error logging.
      c.header("Reporting-Endpoints", `csp="${endpoint}"`);
      c.header("Content-Security-Policy-Report-Only", `${DOCUMENT_POLICY}; report-uri ${endpoint}; report-to csp`);
    } else {
      c.header("Content-Security-Policy-Report-Only", DOCUMENT_POLICY);
    }
  };
}

// Tests and servers without Sentry: headers on, no reports sent.
export const responsePolicy = createResponsePolicy();
