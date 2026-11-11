// Hosts and addresses inside a network rather than on the public internet:
// loopback, private, link-local (cloud metadata), CGNAT, unique-local,
// multicast and reserved ranges, and names only an internal resolver answers
// (single-label docker service names, .internal, .local, ...). Every fetch our
// servers make to a URL someone else chose asks these questions, so a URL can
// never turn the backend into a proxy into its own network. A leaf module.

export function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function internalIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast and reserved, broadcast included
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (and Alibaba's metadata at 100.100.100.200)
    (a === 169 && b === 254) || // link-local, cloud metadata at 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments (Oracle metadata at 192.0.0.192), documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** The eight 16-bit groups of an IPv6 address (brackets and a zone allowed), or null. */
export function ipv6Groups(raw: string): number[] | null {
  let h = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!h.includes(":") || !/^[0-9a-f:.]+$/.test(h)) return null;
  // A dotted IPv4 tail becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (tail) {
    const p = ipv4Parts(tail[1]);
    if (!p) return null;
    h = h.slice(0, -tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function internalIpv6(g: number[]): boolean {
  const v4At = (i: number) => [g[i] >> 8, g[i] & 0xff, g[i + 1] >> 8, g[i + 1] & 0xff];
  // IPv4 carried inside IPv6: mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) are judged by the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return internalIpv4(v4At(6));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return internalIpv4(v4At(6));
  if (g[0] === 0x2002) return internalIpv4(v4At(1));
  // Only global unicast (2000::/3) is public. That leaves out ::, ::1, IPv4-compatible forms,
  // unique-local fc00::/7 (AWS metadata at fd00:ec2::254), link-local and site-local fe80::/9 and multicast ff00::/8.
  if (g[0] < 0x2000 || g[0] > 0x3fff) return true;
  // Documentation (2001:db8::/32) and Teredo (2001::/32), whose far end is not the address named.
  return g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0);
}

/** Why an IP address (v4 or v6, as a URL host or a DNS answer) is inside a network, or null when it is public. Anything unparseable is refused. */
export function internalAddressRefusal(ip: string): string | null {
  const v4 = ipv4Parts(ip);
  if (v4) return internalIpv4(v4) ? `${ip} is a private address` : null;
  const v6 = ipv6Groups(ip);
  if (v6) return internalIpv6(v6) ? `${ip} is a private address` : null;
  return `${ip} is not an address`;
}

/** True when `host` (a URL hostname, brackets allowed) is an IP literal. */
export function isIpLiteral(host: string): boolean {
  return !!ipv4Parts(host) || !!ipv6Groups(host);
}

const INTERNAL_SUFFIX_RE = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet|home\.arpa)$/;

/**
 * Why a URL's literal host is inside a network, or null when it may be called.
 * `ownHosts` are names of our own deployment, refused with their subdomains.
 * A public name can still resolve to a private address: a server fetch also
 * checks the resolved addresses (convex lib/guardedFetch).
 */
export function internalHostRefusal(raw: string, ownHosts: readonly string[] = []): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `${url.protocol} is not http or https`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "no host";
  if (isIpLiteral(host)) return internalAddressRefusal(host);
  // Bare numeric forms (2130706433, 0x7f.1) that URL parsing did not fold into a dotted quad.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return `${host} is a numeric address`;
  if (INTERNAL_SUFFIX_RE.test(host)) return `${host} is a local host`;
  // A single-label name (postgres, convex-backend) only an internal resolver answers.
  if (!host.includes(".")) return `${host} is not a public host name`;
  if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) return `${host} is codecast's own host`;
  return null;
}
