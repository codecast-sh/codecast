// AWS Signature Version 4, shared by the EC2 waker (header signing) and the
// R2 media store (presigned URLs; R2 speaks the S3 protocol with region "auto").

import { hex, hmacSha256 as hmac } from "./hmac";

const encoder = new TextEncoder();
export const sha256Hex = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/** 20260924T010203Z */
export const amzTimestamp = (now: Date) => now.toISOString().replace(/[:-]|\.\d{3}/g, "");

/** The hex signature of a SigV4 string to sign. */
export async function sigV4Signature(secretAccessKey: string, date: string, region: string, service: string, stringToSign: string): Promise<string> {
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  return hex(await hmac(signingKey, stringToSign));
}

/** RFC 3986 encoding as SigV4 wants it; slashes kept for paths. */
export function uriEncode(value: string, keepSlash = false): string {
  return Array.from(encoder.encode(value), (b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
    return "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
}

/**
 * A presigned URL for one request. The payload is unsigned; the host header is
 * always signed, and `headers` adds more the request must then carry with
 * exactly these values (a PUT's content-length, so the store refuses any
 * other size).
 */
export async function presignUrl(opts: {
  method: string;
  endpoint: string; // https://<host>
  path: string; // /bucket/key
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now?: Date;
  /** Request parameters signed with the URL (an S3 list's `list-type`,
   *  `prefix`, `continuation-token`). */
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): Promise<string> {
  const host = new URL(opts.endpoint).host;
  const signed: Record<string, string> = { host };
  for (const [k, value] of Object.entries(opts.headers ?? {})) signed[k.toLowerCase()] = value.trim();
  const names = Object.keys(signed).sort();
  const timestamp = amzTimestamp(opts.now ?? new Date());
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const query: Record<string, string> = {
    ...opts.params,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${opts.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(opts.expiresSeconds),
    "X-Amz-SignedHeaders": names.join(";"),
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
  const canonicalPath = uriEncode(opts.path, true);
  const canonicalHeaders = names.map((k) => `${k}:${signed[k]}\n`).join("");
  const canonical = [opts.method, canonicalPath, canonicalQuery, canonicalHeaders, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256Hex(canonical)].join("\n");
  const signature = await sigV4Signature(opts.secretAccessKey, date, opts.region, opts.service, toSign);
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
