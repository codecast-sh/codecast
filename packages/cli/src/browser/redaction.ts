/**
 * Secrets out of what `cast browser` writes to disk and prints.
 *
 * A HAR from `cast browser network har stop` is a complete record of the
 * session's traffic: bearer tokens, session cookies, CSRF tokens, the password
 * a login form posted, the one-time code from an SMS. Agents attach HARs to
 * bug reports, paste them into conversations and publish them, so the file the
 * engine writes is rewritten here before anyone reads it, with every secret
 * replaced by a placeholder.
 *
 * Placeholders are numbered per value (`[REDACTED_3]`), so the same token in a
 * login response and in the next request's header reads as the same
 * placeholder: the flow stays debuggable without the secret.
 *
 * What counts as secret is OpenCode browse's model (network-capture/
 * redaction.ts): headers by name (authorization, cookies, CSRF and API key
 * headers, anything named like a token or session), query, fragment, form,
 * multipart and JSON fields by name (token, secret, password, otp, code, pin,
 * api key, signature...), path segments that look like a credential (JWTs,
 * long hex, long high-entropy base64), and then every value found that way
 * again wherever else it appears in the file.
 */

/** Field and header names whose values are credentials. */
export const SECRET_NAME =
  /auth(?:orization)?|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|passphrase|otp|(?:^|[-_.])code(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])/i;

const SECRET_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-api-key", "api-key", "x-csrf-token", "csrf-token", "x-xsrf-token",
]);

const COOKIE_ATTRS = /^(domain|path|expires|max-age|samesite|secure|httponly|partitioned|priority)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /\[REDACTED_\d+\]/;

/** Path segments that look like credentials: JWTs, long hex, and long
 *  high-entropy base64/base64url. Slugs and UUIDs are not. */
export function looksLikeToken(segment: string): boolean {
  if (segment.length < 24 || UUID.test(segment) || PLACEHOLDER.test(segment)) return false;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (!/^[A-Za-z0-9_~+/-]+={0,2}$/.test(segment)) return false;
  if (/^[a-z]+(?:[-_][a-z]+)+$/i.test(segment)) return false;
  const digit = /\d/.test(segment);
  const lower = /[a-z]/.test(segment);
  const upper = /[A-Z]/.test(segment);
  return new Set(segment).size >= 12 && digit && (lower || upper) && ((lower && upper) || segment.length >= 32);
}

/** Values this short are left to the by-name pass only; replacing them
 *  everywhere would shred unrelated text. */
const MIN_EVERYWHERE = 6;

export class Redactor {
  private readonly byValue = new Map<string, string>();

  /** How many distinct values were replaced. */
  get count(): number {
    return this.byValue.size;
  }

  placeholder(value: string): string {
    let p = this.byValue.get(value);
    if (!p) {
      p = `[REDACTED_${this.byValue.size + 1}]`;
      this.byValue.set(value, p);
    }
    return p;
  }

  header(name: string, value: string): string {
    if (!value || PLACEHOLDER.test(value)) return value;
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "set-cookie") {
      return value
        .split(/;\s*/)
        .map((part, i) => {
          const eq = part.indexOf("=");
          if (eq < 1) return part;
          const key = part.slice(0, eq).trim();
          const v = part.slice(eq + 1);
          if (!v || (lower === "set-cookie" && i > 0 && COOKIE_ATTRS.test(key))) return part;
          return `${key}=${this.placeholder(v)}`;
        })
        .join("; ");
    }
    if (lower === "location" || lower === "referer" || lower === "referrer" || lower === "origin") return this.url(value);
    if (lower === "authorization" || lower === "proxy-authorization") {
      const m = /^(\S+)\s+(.+)$/.exec(value);
      if (m) return `${m[1]} ${this.placeholder(m[2])}`;
    }
    if (SECRET_HEADERS.has(lower) || SECRET_NAME.test(lower)) return this.placeholder(value);
    return value;
  }

  /** A query or form field list: secret names get placeholders. */
  params<T extends { name: string; value?: string }>(list: T[]): T[] {
    return list.map((p) => (p.value && SECRET_NAME.test(p.name) ? { ...p, value: this.placeholder(p.value) } : p));
  }

  url(raw: string): string {
    if (!raw) return raw;
    const hashAt = raw.indexOf("#");
    const base = hashAt < 0 ? raw : raw.slice(0, hashAt);
    const qAt = base.indexOf("?");
    const pathPart = qAt < 0 ? base : base.slice(0, qAt);
    const query = qAt < 0 ? null : base.slice(qAt + 1);
    const pathOut = this.path(pathPart);
    const queryOut = query === null ? "" : `?${this.encodedPairs(query)}`;
    const hashOut = hashAt < 0 ? "" : `#${this.encodedPairs(raw.slice(hashAt + 1))}`;
    return pathOut + queryOut + hashOut;
  }

  private path(p: string): string {
    // Keep scheme://host intact; only segments after it are candidates.
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(p);
    const [prefix, rest] = m ? [m[1], m[2]] : ["", p];
    return (
      prefix +
      rest
        .split("/")
        .map((seg) => {
          let decoded = seg;
          try {
            decoded = decodeURIComponent(seg);
          } catch {}
          return looksLikeToken(decoded) ? this.placeholder(decoded) : seg;
        })
        .join("/")
    );
  }

  /** `a=1&token=x` with the encoding of untouched pairs left exactly as it was. */
  private encodedPairs(s: string): string {
    return s
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 1) return pair;
        let name = pair.slice(0, eq);
        let value = pair.slice(eq + 1);
        try {
          name = decodeURIComponent(name.replace(/\+/g, " "));
          value = decodeURIComponent(value.replace(/\+/g, " "));
        } catch {}
        if (!value || !/^[\w.\-[\]]+$/.test(name) || !SECRET_NAME.test(name)) return pair;
        return `${pair.slice(0, eq)}=${this.placeholder(value)}`;
      })
      .join("&");
  }

  /** A request or response body by its content type; unknown types are
   *  left to the everywhere pass. */
  body(text: string, mimeType: string | undefined): string {
    if (!text) return text;
    const type = (mimeType ?? "").toLowerCase();
    if (type.includes("json")) {
      try {
        return JSON.stringify(this.json(JSON.parse(text)));
      } catch {
        return text;
      }
    }
    if (type.includes("application/x-www-form-urlencoded")) return this.encodedPairs(text);
    if (type.includes("multipart/form-data")) return this.multipart(text, mimeType ?? "");
    return text;
  }

  json(value: unknown, inSecret = false): unknown {
    if (Array.isArray(value)) return value.map((v) => this.json(v, inSecret));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.json(v, inSecret || SECRET_NAME.test(k))]));
    }
    if (!inSecret || value === null || value === "" || typeof value === "boolean") return value;
    return this.placeholder(String(value));
  }

  private multipart(body: string, contentType: string): string {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
    if (!boundary) return body;
    const delim = `--${boundary}`;
    return body
      .split(delim)
      .map((part) => {
        const headEnd = part.indexOf("\r\n\r\n");
        if (headEnd < 0) return part;
        const head = part.slice(0, headEnd);
        const name = /content-disposition:[^\r\n]*;\s*name="([^"]+)"/i.exec(head)?.[1];
        if (!name || /filename\*?=/i.test(head) || !SECRET_NAME.test(name)) return part;
        const end = part.endsWith("\r\n") ? part.length - 2 : part.length;
        const value = part.slice(headEnd + 4, end);
        return value ? `${part.slice(0, headEnd + 4)}${this.placeholder(value)}${part.slice(end)}` : part;
      })
      .join(delim);
  }

  /** Every value redacted so far, wherever else it appears in `text`, raw or
   *  percent-encoded. */
  everywhere(text: string): string {
    if (!text || !this.byValue.size) return text;
    const pairs: Array<[string, string]> = [];
    for (const [v, p] of this.byValue) {
      if (v.length < MIN_EVERYWHERE) continue;
      pairs.push([v, p]);
      const enc = encodeURIComponent(v);
      if (enc !== v) pairs.push([enc, p]);
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [v, p] of pairs) if (out.includes(v)) out = out.split(v).join(p);
    return out;
  }
}

type Header = { name: string; value: string };
type HarEntry = {
  request?: {
    url?: string;
    headers?: Header[];
    cookies?: Header[];
    queryString?: Header[];
    postData?: { mimeType?: string; text?: string; params?: Array<{ name: string; value?: string }> };
  };
  response?: {
    headers?: Header[];
    cookies?: Header[];
    redirectURL?: string;
    content?: { mimeType?: string; text?: string; encoding?: string };
  };
};

const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded/i;

/**
 * Redact a parsed HAR in place: by name first (so every secret value is
 * known), then every known value anywhere else in the file. Returns how many
 * distinct values were replaced.
 */
export function redactHar(har: { log?: { entries?: HarEntry[] } }, r = new Redactor()): number {
  const entries = har.log?.entries ?? [];
  const headers = (list: Header[] | undefined) => list?.map((h) => ({ ...h, value: r.header(h.name, h.value ?? "") }));
  const cookies = (list: Header[] | undefined) => list?.map((c) => (c.value ? { ...c, value: r.placeholder(c.value) } : c));
  for (const e of entries) {
    const q = e.request;
    if (q) {
      if (q.url) q.url = r.url(q.url);
      if (q.headers) q.headers = headers(q.headers);
      if (q.cookies) q.cookies = cookies(q.cookies);
      if (q.queryString) q.queryString = r.params(q.queryString);
      if (q.postData) {
        if (q.postData.text) q.postData.text = r.body(q.postData.text, q.postData.mimeType);
        if (q.postData.params) q.postData.params = r.params(q.postData.params);
      }
    }
    const s = e.response;
    if (s) {
      if (s.headers) s.headers = headers(s.headers);
      if (s.cookies) s.cookies = cookies(s.cookies);
      if (s.redirectURL) s.redirectURL = r.url(s.redirectURL);
      const c = s.content;
      if (c?.text && TEXTUAL.test(c.mimeType ?? "")) {
        if (c.encoding === "base64") {
          try {
            c.text = Buffer.from(c.text, "base64").toString("utf-8");
            delete c.encoding;
          } catch {}
        }
        if (!c.encoding) c.text = r.body(c.text, c.mimeType);
      }
    }
  }
  // Second pass: a token under a name that does not look secret (echoed into
  // a page, a later URL, a log line) is still the token.
  const sweep = (v: unknown): unknown => {
    if (typeof v === "string") return r.everywhere(v);
    if (Array.isArray(v)) return v.map(sweep);
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) (v as Record<string, unknown>)[k] = sweep(x);
    }
    return v;
  };
  sweep(har);
  return r.count;
}

/** Redact a HAR file in place. Returns the count, or null when the file is
 *  not a HAR this can read (left untouched, and the caller says so). */
export function redactHarFile(file: string, fs: { readFileSync: (p: string, e: "utf-8") => string; writeFileSync: (p: string, d: string) => void }): number | null {
  let har: { log?: { entries?: HarEntry[] } };
  try {
    har = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (!har?.log || !Array.isArray(har.log.entries)) return null;
  const n = redactHar(har);
  fs.writeFileSync(file, JSON.stringify(har, null, 2));
  return n;
}

export const HIDDEN_VALUE = "[hidden]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Snapshot text with the given field values taken out, and Chrome's own
 * bullet masking (which still tells the length) collapsed too. A value of
 * four characters or more is replaced wherever it appears; a shorter one only
 * where it stands as a value (quoted, after `=` or `:`), so a one-letter PIN
 * digit does not shred the rest of the page. Pure; the values come from the
 * snapshot's page probe (snapshotSettle.ts).
 */
export function redactSnapshotValues(text: string, values: readonly string[]): string {
  let out = text.replace(/[•●]{2,}/g, HIDDEN_VALUE);
  const unique = [...new Set(values.filter((v) => v.trim()))].sort((a, b) => b.length - a.length);
  for (const v of unique) {
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1)])) {
      if (form.length >= 4) out = out.split(form).join(HIDDEN_VALUE);
      else out = out.replace(new RegExp(`(["=:]\\s*"?)${escapeRe(form)}(?=["\\s,\\]]|$)`, "gm"), `$1${HIDDEN_VALUE}`);
    }
  }
  return out;
}
