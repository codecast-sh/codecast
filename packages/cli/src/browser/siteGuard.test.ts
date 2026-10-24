/**
 * The two hooks every driver path shares. What matters here is that a driver
 * only has to make these two calls to get identical policy behaviour — so the
 * refusal must already have written the audit row, and the verb table must
 * classify each passthrough verb the way the built-in driver labels it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { browserJarRead, NAVIGATING_VERBS, refuseNavigation, signInHost, signInLandingNote, urlsLoadedBy, vaultJarRefusal, viaFor, webAuthnRefusal, withScheme } from "./siteGuard.js";
import { SECRET_APPROVAL_TTL_MS } from "@codecast/shared/contracts/secrets";
import type { SigninMemory } from "../secrets/signin.js";
import { readAudit } from "./audit.js";
import type { SitePolicy } from "./policy.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-guard-"));
  process.env.CODECAST_DIR = dir;
});
afterEach(() => {
  delete process.env.CODECAST_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const lockdown: SitePolicy = {
  sources: [{ file: "/proj/workspace.toml", key: "[browser] allow", patterns: ["example.com"] }],
  errors: [],
};

describe("refuseNavigation", () => {
  test("allowed → null, nothing recorded yet (the landing records it)", () => {
    expect(refuseNavigation("https://example.com/x", "s", "open", lockdown)).toBeNull();
    expect(readAudit()).toHaveLength(0);
  });

  test("refused → message + hint, and the attempt is already on the trail", () => {
    const deny = refuseNavigation("evil.example", "s", "open", lockdown);
    expect(deny!.message).toContain("https://evil.example");
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "https://evil.example", blocked: true, via: "open", tab: "-" });
  });

  test("no policy → never refuses", () => {
    expect(refuseNavigation("https://anything.io", "s", "batch", null)).toBeNull();
  });
});

describe("passthrough verb table", () => {
  test("verbs that can move the page are audited; read-only ones are not", () => {
    for (const v of ["open", "click", "press", "back", "reload", "do"]) expect(NAVIGATING_VERBS.has(v)).toBe(true);
    for (const v of ["snapshot", "text", "console", "shot", "eval"]) expect(NAVIGATING_VERBS.has(v)).toBe(false);
  });
  test("via labels match the built-in driver's", () => {
    expect(viaFor("open")).toBe("open");
    expect(viaFor("back")).toBe("history");
    expect(viaFor("reload")).toBe("reload");
    expect(viaFor("do")).toBe("batch");
    expect(viaFor("click")).toBe("action");
  });
  test("withScheme mirrors open's bare-host default", () => {
    expect(withScheme("example.com")).toBe("https://example.com");
    expect(withScheme("http://x")).toBe("http://x");
  });
});

describe("signInHost", () => {
  test("names the identity host a signed-out browser is redirected to", () => {
    expect(signInHost("https://accounts.google.com/v3/signin/accountchooser?continue=https://ads.google.com")).toBe("accounts.google.com");
    expect(signInHost("https://login.microsoftonline.com/common/oauth2/authorize")).toBe("login.microsoftonline.com");
    expect(signInHost("https://github.com/login?return_to=%2Fsettings")).toBe("github.com");
    expect(signInHost("https://app.example.com/users/sign_in")).toBe("app.example.com");
    expect(signInHost("https://sso.corp.example.com/")).toBe("sso.corp.example.com");
  });
  test("leaves ordinary pages alone", () => {
    expect(signInHost("https://ads.google.com/aw/overview")).toBeNull();
    expect(signInHost("https://github.com/ashot/codecast")).toBeNull();
    expect(signInHost("https://example.com/blog/how-we-login-users")).toBeNull();
    expect(signInHost("id.example")).toBeNull(); // two labels: "id" is the site, not a front door
    expect(signInHost("not a url at all ::")).toBeNull();
  });
});

describe("signInLandingNote", () => {
  const google = (h: string) => h.endsWith("google.com");
  test("says the login was never copied for a site the agent browser keeps for itself", () => {
    const note = signInLandingNote("https://accounts.google.com/signin", google)!;
    expect(note).toContain("accounts.google.com");
    expect(note).toContain("keeps its own login");
    expect(note).toContain("cast browser login");
  });
  test("says the cookies were carried for any other site", () => {
    expect(signInLandingNote("https://github.com/login", google)).toContain("were carried");
  });
  test("is silent off a sign-in page", () => {
    expect(signInLandingNote("https://github.com/ashot", google)).toBeNull();
  });
  test("carries the real Chrome hint when the session is on the clone", () => {
    const note = signInLandingNote("https://github.com/login", google, "your real Chrome holds this login: pair the extension")!;
    expect(note).toContain("Or your real Chrome holds this login");
    expect(signInLandingNote("https://github.com/login", google, null)).not.toContain("Or ");
  });
});

describe("the Vault page is a person's", () => {
  test("an agent cannot open /vault on a codecast origin that serves the person's Vault, and the attempt is on the trail", () => {
    for (const url of ["https://codecast.sh/vault", "codecast.sh/vault?s=sec-4", "https://www.codecast.sh/VAULT", "https://local.codecast.sh/vault/"]) {
      const deny = refuseNavigation(url, "s", "open", null);
      expect(deny?.message).toContain("only a person uses the Vault page");
      expect(deny?.hint).toContain("localhost:3200/vault");
    }
    expect(readAudit().every((r) => r.blocked)).toBe(true);
  });

  test("the dev server's /vault opens: an agent's tab sees a sample Vault there", () => {
    for (const url of ["http://localhost:3200/vault", "http://127.0.0.1:3200/VAULT?s=sec-901", "localhost:3200/vault/"]) {
      expect(refuseNavigation(url, "s", "open", null)).toBeNull();
    }
  });

  test("a web_url this machine is configured with counts as codecast, unless it is the dev server", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ web_url: "https://cast.example.dev" }));
    expect(refuseNavigation("https://cast.example.dev/vault", "s", "open", null)).not.toBeNull();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ web_url: "http://localhost:3200" }));
    expect(refuseNavigation("http://localhost:3200/vault", "s", "open", null)).toBeNull();
  });

  test("the rest of the app, and /vault on any other site, stay open", () => {
    for (const url of ["https://codecast.sh/inbox", "http://localhost:3200/files?f=notes.md", "http://localhost:3200/vaults", "https://example.com/vault", "http://localhost:3000/vault"]) {
      expect(refuseNavigation(url, "s", "open", null)).toBeNull();
    }
  });

  test("every command that loads a URL by itself is gated, pushstate against the tab's page", () => {
    expect(urlsLoadedBy("open", ["--new-tab", "x.com"])).toEqual(["x.com"]);
    expect(urlsLoadedBy("read", ["x.com"])).toEqual(["x.com"]);
    expect(urlsLoadedBy("tab", ["new", "x.com"])).toEqual(["x.com"]);
    expect(urlsLoadedBy("tab", ["close", "t2"])).toEqual([]);
    expect(urlsLoadedBy("diff", ["url", "a.com", "b.com"])).toEqual(["a.com", "b.com"]);
    expect(urlsLoadedBy("pushstate", ["/vault"], () => "http://localhost:3200/inbox")).toEqual(["http://localhost:3200/vault"]);
    expect(urlsLoadedBy("pushstate", ["/vault"])).toEqual(["https://codecast.sh/vault"]);
    expect(urlsLoadedBy("click", ["#e4"])).toEqual([]);
  });
});

describe("agents cannot mint passkeys", () => {
  test("a command naming any CDP WebAuthn method is refused, whatever its position", () => {
    for (const [verb, args] of [["WebAuthn.enable", []], ["cdp", ["WebAuthn.addVirtualAuthenticator", "{}"]], ["send", ["--json", "webauthn.addCredential"]]] as const) {
      expect(webAuthnRefusal(verb, args)?.message).toContain("agents cannot create or use passkeys");
    }
  });

  test("ordinary commands, and text that merely mentions WebAuthn, pass", () => {
    expect(webAuthnRefusal("open", ["https://webauthn.io"])).toBeNull();
    expect(webAuthnRefusal("fill", ["#q", "WebAuthn.enable is refused"])).toBeNull();
    expect(webAuthnRefusal("profiler", ["start"])).toBeNull();
  });
});

describe("Ask first sign-ins in the shared agent browser", () => {
  const NOW = 1_800_000_000_000;
  const memory = (approved: Record<string, number>): SigninMemory => ({
    name: "github-signin", keys: ["user_session\u0000.github.com"], digest: "d", at: NOW, captured_from: "chrome",
    ask_first: { sites: ["github.com"], approved },
  });

  test("reads and writes of cookies, storage and saved state are told apart", () => {
    expect(browserJarRead("cookies", [])).toBe("jar");
    expect(browserJarRead("cookies", ["get", "--json"])).toBe("jar");
    expect(browserJarRead("cookies", ["--session", "x"])).toBe("jar");
    expect(browserJarRead("cookies", ["set", "a", "b"])).toBeNull();
    expect(browserJarRead("cookies", ["clear"])).toBeNull();
    expect(browserJarRead("storage", ["local"])).toBe("page");
    expect(browserJarRead("storage", ["session", "get", "token"])).toBe("page");
    expect(browserJarRead("storage", ["local", "set", "theme", "dark"])).toBeNull();
    expect(browserJarRead("state", ["save", "./auth.json"])).toBe("jar");
    expect(browserJarRead("state", ["list"])).toBeNull();
    expect(browserJarRead("snapshot", ["-i"])).toBeNull();
  });

  test("a session never approved is refused the jar, and storage on a covered site", () => {
    const state = { sid: memory({ jx7a: NOW }) };
    const jar = vaultJarRefusal("jar", null, "jx7b", state, NOW + 1);
    expect(jar?.message).toContain("Ask first sign-in github-signin");
    expect(jar?.hint).toContain("cast browser open https://github.com");
    expect(vaultJarRefusal("page", "https://gist.github.com/x", "jx7b", state, NOW + 1)).not.toBeNull();
    expect(vaultJarRefusal("page", "http://localhost:3200/inbox", "jx7b", state, NOW + 1)).toBeNull();
    expect(vaultJarRefusal("page", null, "jx7b", state, NOW + 1)).not.toBeNull();
    expect(vaultJarRefusal("jar", null, null, state, NOW + 1)).not.toBeNull();
  });

  test("the approved session reads until its approval would have lapsed", () => {
    const state = { sid: memory({ jx7a: NOW }) };
    expect(vaultJarRefusal("jar", null, "jx7a", state, NOW + 1)).toBeNull();
    expect(vaultJarRefusal("page", "https://github.com", "jx7a", state, NOW + 1)).toBeNull();
    expect(vaultJarRefusal("jar", null, "jx7a", state, NOW + SECRET_APPROVAL_TTL_MS)).not.toBeNull();
  });

  test("a sign-in that is not Ask first never refuses", () => {
    const { ask_first: _, ...plain } = memory({});
    expect(vaultJarRefusal("jar", null, "jx7b", { sid: plain }, NOW)).toBeNull();
  });
});
