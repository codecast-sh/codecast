import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SecretMeta, SigninCookie } from "@codecast/shared/contracts/secrets";
import {
  SIGNIN_REFRESH_EVERY_MS,
  accountHint,
  aliveCookies,
  boundedStorage,
  captureSigninArgv,
  coversHost,
  defaultSigninName,
  inSiteScope,
  jarDigest,
  jarIsNewer,
  needsSignin,
  parseCaptureSigninArgs,
  pickSignin,
  readSigninState,
  rememberJar,
  scopedJar,
  signinSite,
  stillSignedIn,
  writeBackJar,
  writeSigninMemory,
} from "./signin";
import { handleCaptureSigninCommand, saveTarget, SigninRefused } from "./signinCommand";

const NOW = 1_800_000_000_000;
const cookie = (name: string, value: string, domain = ".github.com", expires?: number): SigninCookie => ({
  name, value, domain, path: "/", secure: true, httpOnly: true, ...(expires !== undefined ? { expires } : {}),
});
const meta = (over: Partial<SecretMeta>): SecretMeta => ({
  _id: "id1", short_id: "sec-1", name: "github-signin", kind: "signin", status: "ready", workspace: "team:t1",
  sites: ["github.com"], created_by: "u1", created_at: 0, updated_at: 0, ...over,
});

describe("which sign-in covers a host", () => {
  test("a site argument becomes its host, whatever was pasted", () => {
    expect(signinSite("github.com")).toBe("github.com");
    expect(signinSite("https://Vercel.com/dashboard?x=1")).toBe("vercel.com");
    expect(signinSite("localhost:3200")).toBe("localhost");
    expect(signinSite("file:///etc/passwd")).toBeNull();
    expect(signinSite("  ")).toBeNull();
  });

  test("the default name matches the web's suggestion", () => {
    expect(defaultSigninName("github.com")).toBe("github-signin");
    expect(defaultSigninName("www.dashboard.stripe.com")).toBe("stripe-signin");
    // The label before a shared suffix, so two .co.uk sites never share a name.
    expect(defaultSigninName("bbc.co.uk")).toBe("bbc-signin");
    expect(defaultSigninName("example.co.uk")).toBe("example-signin");
  });

  test("covers the site, www either way and subdomains; never a lookalike", () => {
    expect(coversHost(["github.com"], "github.com")).toBe(true);
    expect(coversHost(["github.com"], "gist.github.com")).toBe(true);
    expect(coversHost(["www.github.com"], "github.com")).toBe(true);
    expect(coversHost(["github.com"], "notgithub.com")).toBe(false);
    expect(coversHost(["app.vercel.com"], "vercel.com")).toBe(false);
  });

  test("picks the most specific site, then the person's own, then the newest; never a request", () => {
    const rows = [
      meta({ _id: "team", workspace: "team:t1", updated_at: 5 }),
      meta({ _id: "mine", workspace: "user:u1", updated_at: 1 }),
      meta({ _id: "gist", sites: ["gist.github.com"] }),
      meta({ _id: "asked", status: "requested", workspace: "user:u1", sites: ["gist.github.com"] }),
      meta({ _id: "key", kind: "key" }),
    ];
    expect(pickSignin(rows, "github.com")?._id).toBe("mine");
    expect(pickSignin(rows, "gist.github.com")?._id).toBe("gist");
    expect(pickSignin(rows, "gitlab.com")).toBeNull();
  });

  test("a sign-in whose cookies all expired loses to a live one, and is still picked when it is the only one", () => {
    const expired = meta({ _id: "expired", workspace: "user:u1", sites: ["gist.github.com"], signin_expires_at: NOW - 1 });
    const live = meta({ _id: "live", signin_expires_at: NOW + 1 });
    expect(pickSignin([expired, live], "gist.github.com", NOW)?._id).toBe("live");
    expect(pickSignin([expired], "gist.github.com", NOW)?._id).toBe("expired");
  });

  test("a cookie belongs to a site through its host keys and subdomains, Google never", () => {
    expect(inSiteScope(".github.com", ["github.com"])).toBe(true);
    expect(inSiteScope("api.github.com", ["github.com"])).toBe(true);
    expect(inSiteScope(".com", ["github.com"])).toBe(false);
    expect(inSiteScope(".google.com", ["google.com"])).toBe(false);
  });

  test("a public suffix or single label scopes nothing, on a row saved before the backend refused them", () => {
    expect(coversHost(["com"], "bank.com")).toBe(false);
    expect(coversHost(["co.uk"], "bank.co.uk")).toBe(false);
    expect(coversHost(["com", "github.com"], "github.com")).toBe(true);
    expect(inSiteScope(".bank.com", ["com"])).toBe(false);
    expect(inSiteScope("intranet", ["intranet"])).toBe(false);
  });
});

describe("what a saved jar puts into the browser", () => {
  test("only the sign-in's own sites' cookies and storage, alive, with a cookie's own fields", () => {
    const planted = { ...cookie("sid", "x", ".bank.example"), url: "https://bank.example", partitionKey: "p" } as SigninCookie;
    const jar = scopedJar({
      cookies: [cookie("user_session", "s"), cookie("SID", "g", ".google.com"), planted, cookie("old", "o", ".github.com", NOW / 1000 - 1), { ...cookie("k", "v"), url: "https://github.com" } as SigninCookie],
      local_storage: { "https://github.com": { a: "1" }, "https://bank.example": { b: "2" }, "javascript:alert(1)": { c: "3" } },
    }, ["github.com"], NOW);
    expect(jar.cookies.map((c) => c.name)).toEqual(["user_session", "k"]);
    expect(jar.cookies[1]).not.toHaveProperty("url");
    expect(Object.keys(jar.local_storage)).toEqual(["https://github.com"]);
  });
});

describe("injecting", () => {
  const saved = [cookie("user_session", "s"), cookie("logged_in", "yes"), cookie("old", "x", ".github.com", NOW / 1000 - 10)];

  test("a browser with only the tracking cookies a site hands everyone needs the sign-in", () => {
    expect(needsSignin(saved, [cookie("_octo", "t"), cookie("logged_in", "no")], NOW)).toBe(true);
  });

  test("a browser holding every saved cookie (any value) is left alone", () => {
    expect(needsSignin(saved, [cookie("user_session", "newer"), cookie("logged_in", "yes")], NOW)).toBe(false);
  });

  test("expired saved cookies neither count nor get set", () => {
    expect(aliveCookies(saved, NOW).map((c) => c.name)).toEqual(["user_session", "logged_in"]);
  });
});

describe("writing back", () => {
  const jar = [cookie("user_session", "s"), cookie("logged_in", "yes")];
  const memory = rememberJar("github-signin", jar, { captured_from: "chrome" }, NOW);

  test("nothing before the interval, even when the cookies moved", () => {
    const newer = [cookie("user_session", "s2"), cookie("logged_in", "yes")];
    expect(writeBackJar(memory, newer, NOW + SIGNIN_REFRESH_EVERY_MS - 1)).toBeNull();
    expect(writeBackJar(memory, newer, NOW + SIGNIN_REFRESH_EVERY_MS)).toEqual(newer);
  });

  test("nothing when the jar is the same, in any order", () => {
    expect(writeBackJar(memory, [...jar].reverse(), NOW + SIGNIN_REFRESH_EVERY_MS)).toBeNull();
  });

  test("a later expiry alone is a change", () => {
    expect(writeBackJar(memory, [cookie("user_session", "s", ".github.com", 2e9), cookie("logged_in", "yes")], NOW + SIGNIN_REFRESH_EVERY_MS)).not.toBeNull();
  });

  test("a memory of no cookies is never signed in, so no browser writes back over it", () => {
    const empty = rememberJar("github-signin", [], { captured_from: "chrome" }, NOW);
    expect(stillSignedIn(empty, [cookie("_ga", "x")])).toBe(false);
    expect(writeBackJar(empty, [cookie("_ga", "x")], NOW + SIGNIN_REFRESH_EVERY_MS)).toBeNull();
  });

  test("a signed-out browser never overwrites the saved sign-in", () => {
    const out = [cookie("logged_in", "no"), cookie("_octo", "t")];
    expect(stillSignedIn(memory, out)).toBe(false);
    expect(writeBackJar(memory, out, NOW + SIGNIN_REFRESH_EVERY_MS)).toBeNull();
  });

  test("memory on disk holds names and a digest, never a value", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signin-")), "state.json");
    writeSigninMemory("id1", rememberJar("github-signin", [cookie("user_session", "VALUE-NEVER-STORED")], { captured_from: "agent-browser", account_hint: "octo" }, NOW), file);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("VALUE-NEVER-STORED");
    expect(readSigninState(file).id1).toMatchObject({ name: "github-signin", at: NOW, account_hint: "octo" });
    expect(jarDigest([cookie("a", "1")])).not.toBe(jarDigest([cookie("a", "2")]));
  });
});

describe("what a capture keeps", () => {
  test("the account hint is the name the site puts in its own cookie", () => {
    expect(accountHint([cookie("dotcom_user", "octo%2Dcat")])).toBe("octo-cat");
    expect(accountHint([cookie("user_session", "s")])).toBeUndefined();
  });

  test("localStorage drops empty origins and stays bounded", () => {
    expect(boundedStorage({ "https://a.com": {} })).toBeNull();
    const out = boundedStorage({ "https://a.com": { t: "1" }, "https://b.com": { big: "x".repeat(300_000) } });
    expect(Object.keys(out!)).toEqual(["https://a.com"]);
  });
});

describe("the vault_capture_signin command", () => {
  test("parses a site, a name and exactly one place", () => {
    expect(parseCaptureSigninArgs(JSON.stringify({ site: "https://github.com/x", team_id: "t1" }))).toEqual({ site: "github.com", where: { team_id: "t1" } });
    expect(parseCaptureSigninArgs(JSON.stringify({ site: "github.com", name: "gh", personal: true }))).toEqual({ site: "github.com", name: "gh", where: { personal: true } });
    expect(() => parseCaptureSigninArgs(JSON.stringify({ site: "github.com" }))).toThrow(/exactly one/);
    expect(() => parseCaptureSigninArgs(JSON.stringify({ site: "github.com", team_id: "t1", personal: true }))).toThrow(/exactly one/);
    expect(() => parseCaptureSigninArgs(JSON.stringify({ team_id: "t1" }))).toThrow(/site/);
    expect(() => parseCaptureSigninArgs(JSON.stringify({ site: "github.com", name: "Bad Name", personal: true }))).toThrow();
    expect(() => parseCaptureSigninArgs("{")).toThrow(/JSON/);
  });

  test("runs save-signin --from-chrome with the same place", () => {
    expect(captureSigninArgv({ site: "github.com", name: "gh", where: { team_id: "t1" } })).toEqual(["vault", "save-signin", "github.com", "--from-chrome", "--json", "--name", "gh", "--team", "t1"]);
    expect(captureSigninArgv({ site: "github.com", where: { personal: true } })).toEqual(["vault", "save-signin", "github.com", "--from-chrome", "--json", "--personal"]);
    expect(captureSigninArgv({ site: "github.com", where: { personal: true } }, true)).toEqual(["vault", "save-signin", "github.com", "--from-chrome", "--json", "--check", "--personal"]);
  });

  const handler = (stdout: string, code = 0, remote = false, check = false) => {
    const ran: string[][] = [];
    const out = handleCaptureSigninCommand(JSON.stringify({ site: "github.com", personal: true }), {
      isRemoteDevice: () => remote,
      runCastCommand: async (args) => (ran.push(args), { code, stdout, stderr: "" }),
      log: () => {},
      childErrorDetail: (stderr) => stderr,
    }, check);
    return { out, ran };
  };

  test("a check runs the child with --check and answers its count", async () => {
    const line = JSON.stringify({ ok: true, check: true, host: "github.com", cookies: 0 });
    const { out, ran } = handler(`${line}\n`, 0, false, true);
    expect(await out).toEqual({ result: line });
    expect(ran[0]).toContain("--check");
  });

  test("the child's outcome line is the result", async () => {
    const line = JSON.stringify({ ok: true, action: "created", short_id: "sec-9", name: "github-signin", host: "github.com", cookies: 12 });
    const { out, ran } = handler(`noise\n${line}\n`);
    expect(await out).toEqual({ result: line });
    expect(ran[0]).toContain("--from-chrome");
  });

  test("the child's refusal is the error the dialog shows", async () => {
    const { out } = handler(`${JSON.stringify({ ok: false, reason: "Chrome on this machine is not signed in to github.com" })}\n`, 1);
    expect(await out).toEqual({ error: "Chrome on this machine is not signed in to github.com" });
  });

  test("a cloud host refuses before running anything", async () => {
    const { out, ran } = handler("", 0, true);
    expect((await out).error).toMatch(/cloud host/);
    expect(ran).toEqual([]);
  });
});

describe("which row a save writes", () => {
  const rows = [
    meta({ name: "github-signin", workspace: "team:t1", short_id: "sec-1" }),
    meta({ name: "vercel-signin", workspace: "user:u1", status: "requested", short_id: "sec-2", sites: ["vercel.com"] }),
    meta({ name: "stripe", kind: "key", workspace: "team:t1", short_id: "sec-3" }),
    meta({ name: "work-dash", workspace: "team:t1", status: "requested", short_id: "sec-4", sites: ["linear.app"] }),
  ];
  test("rotates a saved sign-in, fills a request, creates otherwise", () => {
    expect(saveTarget(rows, "github-signin", { team_id: "t1" }, "github.com").action).toBe("rotated");
    expect(saveTarget(rows, "github-signin", { personal: true }, "github.com").action).toBe("created");
    expect(saveTarget(rows, "vercel-signin", { personal: true }, "vercel.com").action).toBe("filled");
  });
  test("refuses a name another kind holds", () => {
    expect(() => saveTarget(rows, "stripe", { team_id: "t1" }, "stripe.com")).toThrow(SigninRefused);
  });
  test("refuses a name saved for another site instead of rotating its cookies under the old sites", () => {
    expect(() => saveTarget(rows, "github-signin", { team_id: "t1" }, "gitlab.com")).toThrow(/sign-in for github.com, not gitlab.com/);
    expect(saveTarget(rows, "github-signin", { team_id: "t1" }, "gist.github.com").action).toBe("rotated");
  });
  test("with no name given, an open request for the site is filled whatever it is called", () => {
    expect(saveTarget(rows, "linear-signin", { team_id: "t1" }, "linear.app", false)).toMatchObject({ action: "filled", row: { short_id: "sec-4" } });
    // A name given is the name meant.
    expect(saveTarget(rows, "linear-signin", { team_id: "t1" }, "linear.app", true).action).toBe("created");
  });
});

describe("jarIsNewer", () => {
  test("the jar whose latest cookie runs out later is the newer session; a tie or session cookies keep the saved one", () => {
    expect(jarIsNewer([{ expires: 200 }, {}], [{ expires: 100 }])).toBe(true);
    expect(jarIsNewer([{ expires: 100 }], [{ expires: 200 }])).toBe(false);
    expect(jarIsNewer([{ expires: 100 }], [{ expires: 100 }])).toBe(false);
    expect(jarIsNewer([{}], [{}])).toBe(false);
  });
});
