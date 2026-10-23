// The open hook end to end against a stand-in Chrome (Storage, Target, Fetch,
// Page and Runtime as useVaultSignin drives them) and a stand-in backend.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CdpEvent } from "../browser/cdp";
import type { SecretMeta, SigninCookie, SigninPayload } from "@codecast/shared/contracts/secrets";
import { useVaultSignin, type BrowserConn } from "./signinBrowser";
import { SIGNIN_REFRESH_EVERY_MS } from "./signin";

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
          if (e.includes("localStorage.getItem")) return { result: { value: JSON.stringify(storage[origin] ?? {}) } };
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
  return { conn, jar, storage, sets };
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

function run(browser: ReturnType<typeof fakeBrowser>, url: string, at: number, lines: string[] = []) {
  return useVaultSignin(url, {
    port: 9222,
    endpoint: () => ({ siteUrl: "https://backend.test", apiToken: "tok" }),
    conversation: () => "jx7abc",
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

  test("Ask first holds the read: nothing goes in, nothing is remembered, and the decision comes back", async () => {
    const held = { needs_approval: { decision: "sd-9", secret: "github-signin" }, approvals: [{ decision: "sd-9", secret: "github-signin" }], message: "m" };
    answerFor = (route) => (route === "/cli/vault/read" ? held : undefined);
    const b = fakeBrowser([c("logged_in", "no")]);
    expect(await run(b, "https://github.com", NOW)).toEqual(held);
    expect(b.sets).toEqual([]);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  describe("a write-back the saved jar moved past", () => {
    const LATER = NOW / 1000 + 30 * 86_400;
    const stale = { stale: true, updated_at: 500, message: "changed" };
    /** Sign in at NOW from a read stamped updated_at 100, then let the site rotate the session in the browser. */
    async function signedInThenRotated(browserExpires: number) {
      answerFor = (route) => (route === "/cli/vault/read" ? { secrets: [{ ...META, updated_at: 100, payload: SAVED }] } : undefined);
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
        route === "/cli/vault/refresh" ? (++refreshes === 1 ? stale : { short_id: "sec-7", updated_at: 900 })
        : route === "/cli/vault/read" ? { secrets: [{ ...META, updated_at: 500, payload: { ...SAVED, cookies: [c("user_session", "saved-elsewhere", ".github.com", LATER)] } }] }
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
        : route === "/cli/vault/read" ? { secrets: [{ ...META, updated_at: 500, payload: { ...SAVED, cookies: [c("user_session", "saved-elsewhere", ".github.com", LATER + 86_400)] } }] }
        : undefined;
      const lines: string[] = [];
      await run(b, "https://github.com", NOW + SIGNIN_REFRESH_EVERY_MS, lines);
      expect(calls.filter((x) => x.route === "/cli/vault/refresh")).toHaveLength(1);
      expect(b.jar.get("user_session|.github.com")?.value).toBe("saved-elsewhere");
      expect(lines).toEqual(["signed in with vault sign-in github-signin: it was saved again since this browser last used it"]);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).sid.updated_at).toBe(500);
    });
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
