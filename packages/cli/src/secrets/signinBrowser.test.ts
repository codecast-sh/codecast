// The open hook end to end against a stand-in Chrome (Storage, Target, Fetch,
// Page and Runtime as useVaultSignin drives them) and a stand-in backend.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CdpEvent } from "../browser/cdp";
import type { SecretMeta, SigninCookie, SigninPayload } from "@codecast/shared/contracts/secrets";
import { bridgeBrowserConn, useVaultSignin, type BrowserConn } from "./signinBrowser";
import { readSigninState, SIGNIN_REFRESH_EVERY_MS, unapprovedSignins } from "./signin";

const NOW = 1_800_000_000_000;
const c = (name: string, value: string, domain = ".github.com", expires?: number): SigninCookie => ({
  name, value, domain, path: "/", secure: true, httpOnly: true, ...(expires ? { expires } : {}),
});

function fakeBrowser(cookies: SigninCookie[]) {
  const jar = new Map(cookies.map((x) => [`${x.name}|${x.domain}`, x]));
  const storage: Record<string, Record<string, string>> = {};
  const handlers = new Set<(ev: CdpEvent) => void>();
  let origin = "";
  const sets: SigninCookie[][] = [];
  /** Origins whose localStorage read fails, the way a CDP timeout does. */
  const failing = new Set<string>();
  const conn = {
    async send(method: string, params: any = {}): Promise<any> {
      switch (method) {
        case "Storage.getCookies":
          return { cookies: [...jar.values()].map((x) => ({ ...x, session: !x.expires, expires: x.expires ?? -1, size: 1 })) };
        case "Storage.setCookies":
          sets.push(params.cookies);
          for (const x of params.cookies) jar.set(`${x.name}|${x.domain}`, x);
          return {};
        case "Target.getTargets":
          return { targetInfos: [] };
        case "Target.createTarget":
          return { targetId: "scratch" };
        case "Target.attachToTarget":
          return { sessionId: "s1" };
        case "Page.navigate":
          origin = new URL(params.url).origin;
          for (const h of handlers) h({ method: "Fetch.requestPaused", params: { requestId: "r1" }, sessionId: "s1" });
          return {};
        case "Runtime.evaluate": {
          const e: string = params.expression;
          if (e.startsWith("location.origin")) return { result: { value: `${origin} complete` } };
          if (e.includes("localStorage.getItem")) {
            if (failing.has(origin)) throw new Error("timed out");
            return { result: { value: JSON.stringify(storage[origin] ?? {}) } };
          }
          const items = JSON.parse(/const items = (.*?); for/.exec(e)![1]!);
          storage[origin] = { ...storage[origin], ...items };
          return { result: { value: true } };
        }
        default:
          return {};
      }
    },
    on(h: (ev: CdpEvent) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    waitFor: () => Promise.reject(new Error("unused")),
    close() {},
  } as BrowserConn;
  return { conn, jar, storage, sets, failing };
}

const META: SecretMeta = {
  _id: "sid", short_id: "sec-7", name: "github-signin", kind: "signin", status: "ready",
  workspace: "team:t1", sites: ["github.com"], created_by: "u", created_at: 0, updated_at: 0,
};
const SAVED: SigninPayload = {
  cookies: [c("user_session", "saved-session"), c("logged_in", "yes"), c("dotcom_user", "octo")],
  local_storage: { "https://github.com": { "repo-cache": "1" } },
  captured_from: "chrome",
  account_hint: "octo",
};

let calls: { route: string; body: any }[];
let stateFile: string;
/** A test's own backend answer for a route, or undefined for the default. */
let answerFor: (route: string, body: any) => any;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  answerFor = () => undefined;
  stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signin-use-")), "state.json");
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ route, body });
    const answer = answerFor(route, body) ?? (route === "/cli/vault/list" ? [META] : route === "/cli/vault/read" ? { secrets: [{ ...META, payload: SAVED }] } : { short_id: "sec-7" });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function run(browser: ReturnType<typeof fakeBrowser>, url: string, at: number, lines: string[] = [], conversation = "jx7abc") {
  return useVaultSignin(url, {
    port: 9222,
    endpoint: () => ({ siteUrl: "https://backend.test", apiToken: "tok" }),
    conversation: () => conversation,
    log: (l) => lines.push(l),
    now: () => at,
    connect: async () => browser.conn,
    stateFile,
  });
}

describe("cast browser open with a saved sign-in", () => {
  test("a signed-out browser gets the saved cookies and localStorage, and the read names the session", async () => {
    const b = fakeBrowser([c("_octo", "tracking"), c("logged_in", "no")]);
    const lines: string[] = [];
    await run(b, "https://github.com/settings", NOW, lines);
    expect(b.jar.get("user_session|.github.com")?.value).toBe("saved-session");
    expect(b.jar.get("logged_in|.github.com")?.value).toBe("yes");
    expect(b.storage["https://github.com"]).toEqual({ "repo-cache": "1" });
    expect(calls.find((x) => x.route === "/cli/vault/read")?.body).toMatchObject({ refs: ["sec-7"], purpose: "signin", conversation: "jx7abc" });
    expect(lines).toEqual(["signed in with vault sign-in github-signin (octo)"]);
    // The quiet line and the memory on disk carry no cookie value.
    expect(lines.join("")).not.toContain("saved-session");
    expect(fs.readFileSync(stateFile, "utf-8")).not.toContain("saved-session");
  });

  test("a browser already signed in is left alone, and the saved one is not read again", async () => {
    const b = fakeBrowser([c("_octo", "t"), c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    calls = [];
    b.sets.length = 0;
    await run(b, "https://gist.github.com", NOW + 60_000);
    expect(b.sets).toEqual([]);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list"]);
  });

  test("a browser that lost only its session cookie gets that one back and keeps the cookie the site rotated since", async () => {
    const b = fakeBrowser([]);
    await run(b, "https://github.com", NOW);
    b.jar.delete("user_session|.github.com");
    b.jar.set("dotcom_user|.github.com", c("dotcom_user", "rotated"));
    b.sets.length = 0;
    await run(b, "https://github.com", NOW + 60_000);
    expect(b.sets.map((set) => set.map((x) => x.name))).toEqual([["user_session"]]);
    expect(b.jar.get("dotcom_user|.github.com")?.value).toBe("rotated");
    expect(b.jar.get("user_session|.github.com")?.value).toBe("saved-session");
  });

  test("newer cookies go back once the interval passed, keeping where it was captured", async () => {
    const b = fakeBrowser([c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    b.jar.set("user_session|.github.com", c("user_session", "rotated-by-site"));
    calls = [];
    await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS / 2);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list"]);
    const lines: string[] = [];
    await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS, lines);
    const refresh = calls.find((x) => x.route === "/cli/vault/refresh")!;
    expect(refresh.body.ref).toBe("sec-7");
    expect(refresh.body.payload.captured_from).toBe("chrome");
    expect(refresh.body.payload.cookies.find((x: SigninCookie) => x.name === "user_session").value).toBe("rotated-by-site");
    expect(lines).toEqual(["refreshed vault sign-in github-signin with this browser's newer cookies"]);
    // Written: the next look within the interval is quiet again.
    calls = [];
    await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS + 60_000);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list"]);
  });

  test("a write-back keeps saved localStorage no tab shows, re-read where it can be and as saved where the read fails", async () => {
    const storage = { "https://github.com": { "repo-cache": "1" }, "https://app.github.com": { token: "app-saved" }, "https://docs.github.com": { theme: "dark" } };
    answerFor = (route) => (route === "/cli/vault/read" ? { secrets: [{ ...META, payload: { ...SAVED, local_storage: storage } }] } : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    expect(b.storage["https://app.github.com"]).toEqual({ token: "app-saved" });
    b.jar.set("user_session|.github.com", c("user_session", "rotated-by-site"));
    b.storage["https://app.github.com"] = { token: "app-rotated" };
    b.failing.add("https://docs.github.com");
    await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS);
    expect(calls.find((x) => x.route === "/cli/vault/refresh")!.body.payload.local_storage).toEqual({
      "https://github.com": { "repo-cache": "1" },
      "https://app.github.com": { token: "app-rotated" },
      "https://docs.github.com": { theme: "dark" },
    });
  });

  test("an expired sign-in is never overwritten by a signed-out browser's cookies", async () => {
    const past = NOW / 1000 - 60;
    answerFor = (route) => (route === "/cli/vault/read" ? { secrets: [{ ...META, payload: { ...SAVED, cookies: SAVED.cookies.map((x) => ({ ...x, expires: past })) } }] } : undefined);
    const b = fakeBrowser([c("_ga", "tracking")]);
    const lines: string[] = [];
    await run(b, "https://github.com", NOW, lines);
    expect(lines).toEqual(["vault sign-in github-signin has expired: save it again with cast vault save-signin github.com"]);
    expect(b.sets).toEqual([]);
    expect(fs.existsSync(stateFile)).toBe(false);
    calls = [];
    await run(b, "https://github.com", NOW + 2 * SIGNIN_REFRESH_EVERY_MS);
    expect(calls.map((x) => x.route)).not.toContain("/cli/vault/refresh");
  });

  test("Ask first holds the read: nothing goes in, nothing is remembered, and the decision comes back", async () => {
    const held = { needs_approval: { decision: "sd-9", secret: "github-signin" }, approvals: [{ decision: "sd-9", secret: "github-signin" }], message: "m" };
    answerFor = (route) => (route === "/cli/vault/read" ? held : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    expect(await run(b, "https://github.com", NOW)).toEqual(held);
    expect(b.sets).toEqual([]);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test("Ask first is asked for every session, even when the shared browser is already signed in", async () => {
    answerFor = (route) => (route === "/cli/vault/list" ? [{ ...META, ask_first: true }] : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    expect(b.jar.get("user_session|.github.com")?.value).toBe("saved-session");

    // Another session opens the site: the browser holds the session, but the read still runs and holds.
    const held = { needs_approval: { decision: "sd-10", secret: "github-signin" }, approvals: [{ decision: "sd-10", secret: "github-signin" }], message: "m" };
    answerFor = (route) => (route === "/cli/vault/list" ? [{ ...META, ask_first: true }] : route === "/cli/vault/read" ? held : undefined);
    calls = [];
    b.sets.length = 0;
    expect(await run(b, "https://github.com", NOW + 60_000)).toEqual(held);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list", "/cli/vault/read"]);
    expect(b.sets).toEqual([]);
  });

  test("Ask first remembers each approved session, so only they read the sign-in back out of the shared browser", async () => {
    answerFor = (route) => (route === "/cli/vault/list" ? [{ ...META, ask_first: true }] : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    const approved = () => readSigninState(stateFile).sid.ask_first;
    expect(approved()).toEqual({ sites: ["github.com"], approved: { jx7abc: NOW } });
    expect(unapprovedSignins(readSigninState(stateFile), "github.com", "jx7other", NOW)).toHaveLength(1);

    // A second approved session opens a browser already signed in: nothing is written but its approval.
    b.sets.length = 0;
    await run(b, "https://github.com", NOW + 60_000, [], "jx7other");
    expect(b.sets).toEqual([]);
    expect(approved()?.approved).toEqual({ jx7abc: NOW, jx7other: NOW + 60_000 });
    expect(unapprovedSignins(readSigninState(stateFile), "github.com", "jx7other", NOW + 60_000)).toEqual([]);

    // A held session is never added.
    const held = { needs_approval: { decision: "sd-11", secret: "github-signin" }, approvals: [{ decision: "sd-11", secret: "github-signin" }], message: "m" };
    answerFor = (route) => (route === "/cli/vault/list" ? [{ ...META, ask_first: true }] : route === "/cli/vault/read" ? held : undefined);
    await run(b, "https://github.com", NOW + 120_000, [], "jx7third");
    expect(Object.keys(approved()!.approved)).toEqual(["jx7abc", "jx7other"]);
  });

  test("a sign-in that is not Ask first keeps no approvals", async () => {
    await run(fakeBrowser([c("logged_in", "no")]), "https://github.com", NOW);
    expect(readSigninState(stateFile).sid.ask_first).toBeUndefined();
  });

  describe("a write-back the saved jar moved past", () => {
    const LATER = NOW / 1000 + 30 * 86_400;
    const stale = { stale: true, value_updated_at: 500, message: "changed" };
    /** Sign in at NOW from a read stamped value_updated_at 100, then let the site rotate the session in the browser. */
    async function signedInThenRotated(browserExpires: number) {
      answerFor = (route) => (route === "/cli/vault/read" ? { secrets: [{ ...META, value_updated_at: 100, payload: SAVED }] } : undefined);
      const b = fakeBrowser([c("logged_in", "no")]);
      await run(b, "https://github.com", NOW);
      b.jar.set("user_session|.github.com", c("user_session", "rotated-by-site", ".github.com", browserExpires));
      calls = [];
      return b;
    }

    test("the refusal is read again, and the browser's jar goes back when it is the newer session", async () => {
      const b = await signedInThenRotated(LATER + 86_400);
      let refreshes = 0;
      answerFor = (route) =>
        route === "/cli/vault/refresh" ? (++refreshes === 1 ? stale : { short_id: "sec-7", value_updated_at: 900 })
        : route === "/cli/vault/read" ? { secrets: [{ ...META, value_updated_at: 500, payload: { ...SAVED, cookies: [c("user_session", "saved-elsewhere", ".github.com", LATER)] } }] }
        : undefined;
      const lines: string[] = [];
      await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS, lines);
      const writes = calls.filter((x) => x.route === "/cli/vault/refresh");
      expect(writes.map((x) => x.body.expected_updated_at)).toEqual([100, 500]);
      expect(b.jar.get("user_session|.github.com")?.value).toBe("rotated-by-site");
      expect(lines).toEqual(["refreshed vault sign-in github-signin with this browser's newer cookies"]);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).sid.updated_at).toBe(900);
    });

    test("when the saved jar is the newer session the browser takes it and nothing is written", async () => {
      const b = await signedInThenRotated(LATER);
      answerFor = (route) =>
        route === "/cli/vault/refresh" ? stale
        : route === "/cli/vault/read" ? { secrets: [{ ...META, value_updated_at: 500, payload: { ...SAVED, cookies: [c("user_session", "saved-elsewhere", ".github.com", LATER + 86_400)] } }] }
        : undefined;
      const lines: string[] = [];
      await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS, lines);
      expect(calls.filter((x) => x.route === "/cli/vault/refresh")).toHaveLength(1);
      expect(b.jar.get("user_session|.github.com")?.value).toBe("saved-elsewhere");
      expect(lines).toEqual(["signed in with vault sign-in github-signin: it was saved again since this browser last used it"]);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).sid.updated_at).toBe(500);
    });
  });

  test("a teammate's row holding other sites' cookies and storage puts in only its own site's", async () => {
    const planted: SigninPayload = {
      ...SAVED,
      cookies: [...SAVED.cookies, c("SID", "theirs", ".google.com"), c("session", "theirs", ".bank.example"), { ...c("u", "x"), partitionKey: "p" } as SigninCookie],
      local_storage: { ...SAVED.local_storage, "https://bank.example": { token: "theirs" } },
    };
    answerFor = (route) => (route === "/cli/vault/read" ? { secrets: [{ ...META, payload: planted }] } : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    await run(b, "https://github.com", NOW);
    expect(b.sets.flat().map((x) => x.domain)).toEqual([".github.com", ".github.com", ".github.com", ".github.com"]);
    expect(b.sets.flat().some((x) => "partitionKey" in x)).toBe(false);
    expect(Object.keys(b.storage)).toEqual(["https://github.com"]);
  });

  test("a row saved for a public suffix matches no host", async () => {
    answerFor = (route) => (route === "/cli/vault/list" ? [{ ...META, sites: ["com"] }] : undefined);
    const b = fakeBrowser([]);
    await run(b, "https://bank.com", NOW);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list"]);
    expect(b.sets).toEqual([]);
  });

  test("a site no sign-in covers, Google, and a backend that is down all leave the open alone", async () => {
    const b = fakeBrowser([]);
    await run(b, "https://gitlab.com", NOW);
    expect(calls.map((x) => x.route)).toEqual(["/cli/vault/list"]);
    calls = [];
    await run(b, "https://accounts.google.com", NOW);
    expect(calls).toEqual([]);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const lines: string[] = [];
    await run(b, "https://github.com", NOW, lines);
    expect(lines).toEqual([]);
    expect(b.sets).toEqual([]);
  });
});

describe("bridgeBrowserConn", () => {
  // The extension bridge answers only a few browser-wide methods, so the jar
  // calls a sign-in makes must run in a tab's session (2026-11-04: saved
  // sign-ins never loaded into the human's Chrome).
  test("runs browser-wide Storage calls in one scratch tab, passes the rest through, and closes the tab", async () => {
    const sent: Array<[string, string | undefined]> = [];
    let closed = false;
    const inner = {
      async send(method: string, _params?: any, sessionId?: string): Promise<any> {
        sent.push([method, sessionId]);
        if (method === "Target.createTarget") return { targetId: "T1" };
        if (method === "Target.attachToTarget") return { sessionId: "S1" };
        if (method === "Storage.getCookies") return { cookies: [] };
        return {};
      },
      on: () => () => {},
      waitFor: async () => ({ method: "", params: {} }) as CdpEvent,
      close: () => { closed = true; },
    };
    const conn = await bridgeBrowserConn({ port: 1, token: "t" }, async () => inner);
    await conn.send("Target.getTargets");
    await conn.send("Storage.getCookies");
    await conn.send("Storage.setCookies", { cookies: [] });
    await conn.send("Runtime.evaluate", {}, "OTHER");
    await conn.dispose!();
    expect(sent).toEqual([
      ["Target.getTargets", undefined],
      ["Target.createTarget", undefined],
      ["Target.attachToTarget", undefined],
      ["Storage.getCookies", "S1"],
      ["Storage.setCookies", "S1"],
      ["Runtime.evaluate", "OTHER"],
      ["Target.closeTarget", undefined],
    ]);
    expect(closed).toBe(true);
  });

  // The bridge answers a socket's cookie calls only for the sites its tabs
  // show (bridge/guardrails.ts), so the scratch tab parks at the site first.
  test("with sites, the jar calls run in a scratch tab parked at each site's origin", async () => {
    const sent: Array<[string, any, string | undefined]> = [];
    let n = 0;
    const inner = {
      async send(method: string, params?: any, sessionId?: string): Promise<any> {
        sent.push([method, params, sessionId]);
        if (method === "Target.createTarget") return { targetId: `T${++n}` };
        if (method === "Target.attachToTarget") return { sessionId: `S${params.targetId.slice(1)}` };
        if (method === "Runtime.evaluate") return { result: { value: `https://${n === 1 ? "example.com" : "other.org"} complete` } };
        return {};
      },
      on: () => () => {},
      waitFor: async () => ({ method: "", params: {} }) as CdpEvent,
      close: () => {},
    };
    const conn = await bridgeBrowserConn({ port: 1, token: "t" }, async () => inner, ["example.com", "other.org"]);
    await conn.send("Storage.getCookies");
    await conn.dispose!();
    const navigated = sent.filter(([m]) => m === "Page.navigate").map(([, p, sid]) => [p.url, sid]);
    expect(navigated).toEqual([["https://example.com/__cast_vault__", "S1"], ["https://other.org/__cast_vault__", "S2"]]);
    expect(sent.find(([m]) => m === "Storage.getCookies")?.[2]).toBe("S1");
    expect(sent.filter(([m]) => m === "Target.closeTarget").map(([, p]) => p.targetId).sort()).toEqual(["T1", "T2"]);
  });

  test("opens no tab when nothing reads the jar", async () => {
    const sent: string[] = [];
    const inner = { send: async (m: string) => (sent.push(m), {}), on: () => () => {}, waitFor: async () => ({}) as CdpEvent, close: () => {} };
    const conn = await bridgeBrowserConn(1, async () => inner as any);
    await conn.dispose!();
    expect(sent).toEqual([]);
  });
});
