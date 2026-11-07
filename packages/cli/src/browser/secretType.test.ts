import { describe, expect, test } from "bun:test";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import type { ReadSecret } from "../secrets/inject.js";
import { fieldFor, originVerdict, typeSecret, valueFor, SecretTypeRefusal, type FocusProbe, type SecretTypeDeps } from "./secretType.js";

const meta = (over: Partial<SecretMeta> = {}): SecretMeta =>
  ({ _id: "s1", short_id: "sc-1", name: "acme", kind: "login", status: "ready", workspace: "user:u", sites: ["login.acme.test"], created_by: "u", created_at: 0, updated_at: 0, ...over }) as SecretMeta;
const login = (payload: Record<string, string>, sites = ["login.acme.test"]): ReadSecret => ({ id: "s1", short_id: "sc-1", name: "acme", kind: "login", sites, payload });

const refused = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SecretTypeRefusal);
    expect((err as Error).message).toMatch(re);
    return;
  }
  throw new Error("expected a refusal");
};

describe("originVerdict", () => {
  test("a secret with no site is typed nowhere", () => {
    refused(() => originVerdict(meta({ sites: [] }), "https://login.acme.test/", null), /names no site/);
    refused(() => originVerdict(meta({ sites: ["*"] }), "https://login.acme.test/", null), /names no site/);
  });
  test("exact host, any port on https; subdomains only with *.", () => {
    expect(originVerdict(meta(), "https://login.acme.test/signin?x=1", null).origin).toBe("https://login.acme.test");
    refused(() => originVerdict(meta(), "https://evil.login.acme.test/", null), /not a site of acme/);
    refused(() => originVerdict(meta(), "https://login.acme.test.evil.com/", null), /not a site of acme/);
    expect(originVerdict(meta({ sites: ["*.acme.test"] }), "https://sso.acme.test/", null).origin).toBe("https://sso.acme.test");
  });
  test("plain http only on loopback, and a port in the site is exact", () => {
    refused(() => originVerdict(meta(), "http://login.acme.test/", null), /not https/);
    const local = meta({ sites: ["127.0.0.1:4001"] });
    expect(originVerdict(local, "http://127.0.0.1:4001/login", null).origin).toBe("http://127.0.0.1:4001");
    refused(() => originVerdict(local, "http://127.0.0.1:4002/login", null), /not a site/);
  });
  test("a page with no web origin is no site", () => {
    refused(() => originVerdict(meta(), "about:blank", null), /no site/);
    refused(() => originVerdict(meta(), "data:text/html,<input>", null), /no site/);
  });
  test("the session allowlist applies on top", () => {
    const policy = { sources: [{ file: "w.toml", key: "[browser] allow", patterns: ["docs.acme.test"] }], errors: [] };
    refused(() => originVerdict(meta(), "https://login.acme.test/", policy), /allowlist/);
    expect(originVerdict(meta(), "https://login.acme.test/", { ...policy, sources: [{ ...policy.sources[0], patterns: ["login.acme.test"] }] }).origin).toBe("https://login.acme.test");
  });
});

describe("fieldFor and valueFor", () => {
  test("defaults and refusals by kind", () => {
    expect(fieldFor("key", undefined, "k")).toBe("value");
    expect(fieldFor("login", undefined, "l")).toBe("password");
    refused(() => fieldFor("key", "password", "k"), /use --field value/);
    refused(() => fieldFor("signin", undefined, "s"), /saved sign-in/);
    refused(() => fieldFor("file", undefined, "f"), /file secret/);
  });
  test("a password must be one the redaction holds", async () => {
    expect(await valueFor(login({ password: "hunter2-long" }), "password")).toBe("hunter2-long");
    await expect(valueFor(login({ password: "abc" }), "password")).rejects.toThrow(/too short to redact/);
    expect(await valueFor({ ...login({}), kind: "key", payload: { value: "sk-test-1234567" } }, "value")).toBe("sk-test-1234567");
  });
  test("a username is typed as is; otp comes from the seed", async () => {
    expect(await valueFor(login({ username: "ada" }), "username")).toBe("ada");
    expect(await valueFor(login({ totp_seed: "JBSWY3DPEHPK3PXP" }), "otp", async () => ({ code: "123456", remaining: 20 }))).toBe("123456");
    await expect(valueFor(login({ password: "hunter2-long" }), "otp")).rejects.toThrow(/no 2FA seed/);
  });
});

/** A fake page: a list of top URLs it reports in turn, a probe, and what got inserted. */
function fakePage(urls: string[], probe: FocusProbe | FocusProbe[]) {
  const inserted: string[] = [];
  const probes = Array.isArray(probe) ? [...probe] : null;
  let i = 0;
  return {
    inserted,
    page: {
      topUrl: async () => urls[Math.min(i++, urls.length - 1)],
      focus: async () => {},
      probe: async () => (probes ? probes.shift() ?? probes.at(-1)! : (probe as FocusProbe)),
      selectAll: async () => {},
      insertText: async (t: string) => void inserted.push(t),
    },
  };
}

const field: FocusProbe = { frame: "top", editable: true, docOrigin: "https://login.acme.test", key: "top|input|password|pw||" };

function deps(page: ReturnType<typeof fakePage>["page"], reads: string[] = []): SecretTypeDeps {
  return {
    meta: async (n) => (n === "acme" ? meta() : null),
    read: async (n) => {
      reads.push(n);
      return login({ password: "hunter2-long", username: "ada" });
    },
    policy: null,
    page,
  };
}

describe("typeSecret", () => {
  test("types the value and reports only where", async () => {
    const f = fakePage(["https://login.acme.test/"], field);
    const res = await typeSecret("acme", {}, deps(f.page));
    expect(res).toEqual({ typed: true, name: "acme", origin: "https://login.acme.test", field: "password" });
    expect(f.inserted).toEqual(["hunter2-long"]);
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });
  test("a wrong origin refuses before the value is read", async () => {
    const reads: string[] = [];
    const f = fakePage(["https://phish.test/"], field);
    await expect(typeSecret("acme", {}, deps(f.page, reads))).rejects.toThrow(/not a site of acme/);
    expect(reads).toEqual([]);
    expect(f.inserted).toEqual([]);
  });
  test("a cross-origin iframe is refused", async () => {
    const f = fakePage(["https://login.acme.test/"], { frame: "cross", editable: false });
    await expect(typeSecret("acme", {}, deps(f.page))).rejects.toThrow(/cross-origin iframe/);
    expect(f.inserted).toEqual([]);
  });
  test("a same-origin frame of another origin (document.domain games) is refused", async () => {
    const f = fakePage(["https://login.acme.test/"], { ...field, frame: "same", docOrigin: "https://other.acme.test" });
    await expect(typeSecret("acme", {}, deps(f.page))).rejects.toThrow(/frame is https:\/\/other/);
  });
  test("a redirect on focus, or before the insert, is refused", async () => {
    const onFocus = fakePage(["https://login.acme.test/", "https://phish.test/"], field);
    await expect(typeSecret("acme", {}, deps(onFocus.page))).rejects.toThrow(/moved from https:\/\/login.acme.test to https:\/\/phish.test when/);
    const beforeInsert = fakePage(["https://login.acme.test/", "https://login.acme.test/", "https://phish.test/"], field);
    await expect(typeSecret("acme", {}, deps(beforeInsert.page))).rejects.toThrow(/before the value went in/);
    expect(beforeInsert.inserted).toEqual([]);
  });
  test("focus that moves off the field before the insert is refused", async () => {
    const f = fakePage(["https://login.acme.test/"], [field, { frame: "top", editable: false, docOrigin: "https://login.acme.test" }]);
    await expect(typeSecret("acme", {}, deps(f.page))).rejects.toThrow(/not an editable text field/);
    expect(f.inserted).toEqual([]);
  });
  test("an unknown or requested secret", async () => {
    const f = fakePage(["https://login.acme.test/"], field);
    await expect(typeSecret("nope", {}, deps(f.page))).rejects.toThrow(/no secret named nope/);
    await expect(typeSecret("acme", {}, { ...deps(f.page), meta: async () => meta({ status: "requested" }) })).rejects.toThrow(/no value yet/);
  });
});
