import { describe, expect, test } from "bun:test";
import { dohResolver, guardedFetch, RefusedHostError, type Resolver } from "./guardedFetch";

const dns = (table: Record<string, string[]>): Resolver => async (host) => table[host] ?? [];

function recorder(answers: Record<string, () => Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const make = answers[url];
    if (!make) throw new Error(`unexpected fetch ${url}`);
    return make();
  };
  return { seen, fetch };
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("guardedFetch", () => {
  test("a public name is fetched, over plain http too", async () => {
    const r = recorder({ "http://api.example.com/x": () => new Response("ok") });
    const res = await guardedFetch("http://api.example.com/x", { method: "POST", body: "b" }, { fetch: r.fetch, resolve: dns({ "api.example.com": ["93.184.216.34"] }) });
    expect(await res.text()).toBe("ok");
    expect(r.seen[0].init).toMatchObject({ method: "POST", body: "b", redirect: "manual" });
  });

  test("a public name that resolves to a private or metadata address is refused before any request", async () => {
    for (const addrs of [["10.0.0.5"], ["93.184.216.34", "169.254.169.254"], ["fd00:ec2::254"], ["::ffff:127.0.0.1"]]) {
      const r = recorder({});
      await expect(guardedFetch("https://evil.example.com/", {}, { fetch: r.fetch, resolve: dns({ "evil.example.com": addrs }) })).rejects.toBeInstanceOf(RefusedHostError);
      expect(r.seen).toEqual([]);
    }
  });

  test("literal internal hosts, docker names and names that do not resolve are refused", async () => {
    const r = recorder({});
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://postgres:5432", "http://localhost:3210", "https://nowhere.example.com"]) {
      await expect(guardedFetch(url, {}, { fetch: r.fetch, resolve: dns({}) })).rejects.toBeInstanceOf(RefusedHostError);
    }
    // No resolver answered: refused rather than fetched blind.
    await expect(guardedFetch("https://api.example.com", {}, { fetch: r.fetch, resolve: async () => null })).rejects.toThrow("could not be resolved");
    expect(r.seen).toEqual([]);
  });

  test("with redirects off, a redirect comes back as it is", async () => {
    const r = recorder({ "https://api.example.com/a": redirect("http://10.0.0.1/") });
    const res = await guardedFetch("https://api.example.com/a", {}, { fetch: r.fetch, resolve: dns({ "api.example.com": ["93.184.216.34"] }) });
    expect(res.status).toBe(302);
    expect(r.seen.map((s) => s.url)).toEqual(["https://api.example.com/a"]);
  });

  test("every redirect hop is checked before it is requested", async () => {
    const resolve = dns({ "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.35"], "inside.example.com": ["192.168.0.2"] });
    const ok = recorder({ "https://a.example.com/": redirect("https://b.example.com/doc"), "https://b.example.com/doc": () => new Response("{}") });
    expect((await guardedFetch("https://a.example.com/", {}, { fetch: ok.fetch, resolve, maxRedirects: 5 })).status).toBe(200);

    for (const to of ["http://169.254.169.254/latest/meta-data/", "https://inside.example.com/", "http://convex-backend:3210/"]) {
      const r = recorder({ "https://a.example.com/": redirect(to) });
      await expect(guardedFetch("https://a.example.com/", {}, { fetch: r.fetch, resolve, maxRedirects: 5 })).rejects.toBeInstanceOf(RefusedHostError);
      expect(r.seen.map((s) => s.url)).toEqual(["https://a.example.com/"]);
    }
  });

  test("a 303 continues as a GET without the body", async () => {
    const resolve = dns({ "a.example.com": ["93.184.216.34"] });
    const r = recorder({ "https://a.example.com/post": redirect("/done", 303), "https://a.example.com/done": () => new Response("ok") });
    await guardedFetch("https://a.example.com/post", { method: "POST", body: "x" }, { fetch: r.fetch, resolve, maxRedirects: 1 });
    expect(r.seen[1].init.method).toBe("GET");
    expect(r.seen[1].init.body).toBeUndefined();
  });
});

describe("dohResolver", () => {
  test("reads A and AAAA answers through a CNAME chain, and falls back to the second resolver", async () => {
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      if (url.startsWith("https://cloudflare-dns.com")) return new Response("down", { status: 502 });
      const type = new URL(url).searchParams.get("type");
      const Answer = type === "A"
        ? [{ type: 5, data: "target.example.net." }, { type: 1, data: "10.1.2.3", TTL: 30 }]
        : [];
      return new Response(JSON.stringify({ Status: 0, Answer }));
    };
    expect(await dohResolver(fetch)("doh-test-1.example.com")).toEqual(["10.1.2.3"]);
    expect(asked.some((u) => u.startsWith("https://dns.google/resolve?name=doh-test-1.example.com&type=AAAA"))).toBe(true);
  });

  test("NXDOMAIN is no addresses; resolvers that both fail are null", async () => {
    expect(await dohResolver(async () => new Response(JSON.stringify({ Status: 3 })))("doh-test-2.example.com")).toEqual([]);
    expect(await dohResolver(async () => new Response(JSON.stringify({ Status: 2 })))("doh-test-3.example.com")).toBeNull();
  });
});
