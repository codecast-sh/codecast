/**
 * Why the server will not fetch a live reader's url, or null when it may. A
 * member declares the url, and the fetch runs from the backend's own network
 * (a self-hosted one sits beside private services), so only http(s) to a public
 * host name or address is read: no loopback, link-local (cloud metadata),
 * private or unique-local range, and no single-label or internal-only name.
 */
export function liveReaderUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the live reader url is not a url";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "the live reader url must be http or https";
  if (url.username || url.password) return "the live reader url must not carry credentials";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const refused = "the live reader url must name a public host";
  if (!host) return refused;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    // Only global unicast (2000::/3) is public; that leaves out ::1, ::, fc00::/7, fe80::/10 and v4-mapped forms.
    const first = parseInt(v6.split(":")[0] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff ? null : refused;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
    return isPrivate ? refused : null;
  }
  if (!host.includes(".")) return refused;
  if (/(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet)$/.test(host)) return refused;
  return null;
}
