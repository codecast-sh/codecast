// `cast git-credential`: the protocol git speaks, and the silence it expects.
//
// Two contracts meet here. git's: key=value lines in, username/password lines
// out, a blank line ends the request, and a helper with nothing to say prints
// NOTHING and exits non-zero so the next helper is tried. Ours: only
// github.com, only `get`, and the token is never written anywhere but stdout.

import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_BUDGET_MS, credentialRepository, formatCredential, parseCredentialInput, runGitCredential, withBudget,
  type CredentialAnswer, type GitCredentialDeps,
} from "./gitCredential";
import { isCredentialHelperFastPath } from "../fastPath.js";
import { CREDENTIAL_HELPER_VERB } from "./hostGit.js";

const REQUEST = "protocol=https\nhost=github.com\npath=ashot/codecast.git\n\n";
const TOKEN = { username: "x-access-token", password: "ghs_secret", expires_at: 1_700_000_000_000 };

function helper(input: string, answer: CredentialAnswer | Error, extra: Partial<GitCredentialDeps> = {}) {
  const out: string[] = [];
  const errors: string[] = [];
  const asked: Array<{ host: string; repository: string }> = [];
  const deps: GitCredentialDeps = {
    readInput: async () => input,
    fetchCredential: async (q) => {
      asked.push(q);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    write: (text) => out.push(text),
    explain: (text) => errors.push(text),
    ...extra,
  };
  return { deps, out, errors, asked, stdout: () => out.join("") };
}

describe("the request git writes", () => {
  test("key=value lines up to the blank line; later lines belong to no request", () => {
    expect(parseCredentialInput(REQUEST)).toEqual({ protocol: "https", host: "github.com", path: "ashot/codecast.git" });
    expect(parseCredentialInput("host=github.com\n\nhost=evil.example\n")).toEqual({ host: "github.com" });
  });

  test("a value keeps every character after the first =, and CRLF is trimmed", () => {
    expect(parseCredentialInput("password=a=b=c\n").password).toBe("a=b=c");
    expect(parseCredentialInput("host=github.com\r\npath=o/r\r\n")).toEqual({ host: "github.com", path: "o/r" });
  });

  test("a line with no =, an empty key, and a repeated key are all handled", () => {
    expect(parseCredentialInput("garbage\n=value\nhost=github.com\nhost=evil.example\n")).toEqual({ host: "github.com" });
  });
});

describe("which repository the request is about", () => {
  test("the path git sends, with or without .git and leading slashes", async () => {
    expect(await credentialRepository({ path: "ashot/codecast.git" })).toBe("ashot/codecast");
    expect(await credentialRepository({ path: "/ashot/codecast/" })).toBe("ashot/codecast");
  });

  test("a path that is not owner/name names no repository", async () => {
    expect(await credentialRepository({ path: "ashot" })).toBeUndefined();
    expect(await credentialRepository({ path: "ashot/codecast/pull/1" })).toBeUndefined();
    expect(await credentialRepository({ path: "../etc/passwd" })).toBeUndefined();
  });

  test("without a path the repository comes from the origin git is standing in", async () => {
    expect(await credentialRepository({}, () => "git@github.com:ashot/codecast.git")).toBe("ashot/codecast");
    expect(await credentialRepository({}, async () => "https://github.com/ashot/codecast")).toBe("ashot/codecast");
    expect(await credentialRepository({}, () => "git@gitlab.example:ashot/codecast.git")).toBeUndefined();
    expect(await credentialRepository({}, () => undefined)).toBeUndefined();
  });
});

describe("what git reads back", () => {
  test("username, password, and the expiry newer git honors", () => {
    expect(formatCredential(TOKEN)).toBe("username=x-access-token\npassword=ghs_secret\npassword_expiry_utc=1700000000\n");
  });

  test("a credential without an expiry prints two lines", () => {
    expect(formatCredential({ username: "x-access-token", password: "ghs_secret" }))
      .toBe("username=x-access-token\npassword=ghs_secret\n");
  });
});

describe("one run of the helper", () => {
  test("get answers with the token and asks the server for that repository", async () => {
    const h = helper(REQUEST, TOKEN);
    expect(await runGitCredential("get", h.deps)).toBe(0);
    expect(h.stdout()).toBe("username=x-access-token\npassword=ghs_secret\npassword_expiry_utc=1700000000\n");
    expect(h.asked).toEqual([{ host: "github.com", repository: "ashot/codecast" }]);
  });

  test("store and erase do nothing, quietly and successfully", async () => {
    for (const op of ["store", "erase", "capability", undefined]) {
      const h = helper(REQUEST, TOKEN);
      expect(await runGitCredential(op, h.deps)).toBe(0);
      expect(h.stdout()).toBe("");
      expect(h.asked).toEqual([]);
    }
  });

  test("a refusal prints nothing at all and exits non-zero", async () => {
    const h = helper(REQUEST, { reason: "the codecast GitHub App is not installed on ashot/codecast for you" });
    expect(await runGitCredential("get", h.deps)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.errors).toEqual([]);
  });

  test("--why says why, on stderr, and still refuses", async () => {
    const h = helper(REQUEST, { reason: "not installed" });
    expect(await runGitCredential("get", h.deps, { why: true })).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.errors).toEqual(["not installed\n"]);
  });

  test("another host, another protocol, and a request with no repository are refused without asking", async () => {
    for (const input of [
      "protocol=https\nhost=gitlab.example\npath=o/r\n\n",
      "protocol=http\nhost=github.com\npath=o/r\n\n",
      "protocol=https\npath=o/r\n\n",
    ]) {
      const h = helper(input, TOKEN);
      expect(await runGitCredential("get", h.deps)).toBe(1);
      expect(h.stdout()).toBe("");
      expect(h.asked).toEqual([]);
    }
    const noRepo = helper("protocol=https\nhost=github.com\n\n", TOKEN);
    expect(await runGitCredential("get", noRepo.deps)).toBe(1);
    expect(noRepo.asked).toEqual([]);
  });

  test("a request with no path falls back to the repository's own origin", async () => {
    const h = helper("protocol=https\nhost=github.com\n\n", TOKEN, { originRepository: () => "git@github.com:ashot/codecast.git" });
    expect(await runGitCredential("get", h.deps)).toBe(0);
    expect(h.asked).toEqual([{ host: "github.com", repository: "ashot/codecast" }]);
  });

  test("a fetch that throws is a refusal, not a stack trace in git's output", async () => {
    const h = helper(REQUEST, new Error("fetch failed"));
    expect(await runGitCredential("get", h.deps)).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.errors).toEqual([]);
    const why = helper(REQUEST, new Error("fetch failed"));
    expect(await runGitCredential("get", why.deps, { why: true })).toBe(1);
    expect(why.errors).toEqual(["fetch failed\n"]);
  });
});

// git reads the helper's stdout as the credential and refuses one whose first
// line it does not know, so the verb must not enter the CLI lifecycle that
// prints an auto-update notice on stdout. fastPath.ts is what keeps it out.
describe("git's invocation goes through the fast path", () => {
  test("the three operations git spells are claimed; a human's flags are not", () => {
    for (const op of ["get", "store", "erase"]) {
      expect(isCredentialHelperFastPath(["bun", "cast", "git-credential", op])).toBe(true);
    }
    expect(isCredentialHelperFastPath(["bun", "cast", "git-credential"])).toBe(false);
    expect(isCredentialHelperFastPath(["bun", "cast", "git-credential", "--why", "get"])).toBe(false);
    expect(isCredentialHelperFastPath(["bun", "cast", "git-credential", "get", "--why"])).toBe(false);
    expect(isCredentialHelperFastPath(["bun", "cast", "hosts", "get"])).toBe(false);
  });

  test("the verb the host configures is the verb the fast path claims", () => {
    // `!<cast> <verb>` — git appends the operation and runs it through a
    // shell, so the argv the binary sees is that verb plus one word.
    expect(isCredentialHelperFastPath(["bun", "cast", CREDENTIAL_HELPER_VERB, "get"])).toBe(true);
  });
});

// git cannot interrupt a credential helper, so a server that never answers
// would hold the git command open for as long as the fetch allows. The budget
// turns that into an ordinary authentication failure.
describe("the budget on the server call", () => {
  test("a call that never answers becomes an error inside the budget", async () => {
    const never = new Promise<string>(() => {});
    await expect(withBudget(never, 20)).rejects.toThrow("did not answer within");
  });

  test("an answer inside the budget comes back, and leaves no timer behind", async () => {
    expect(await withBudget(Promise.resolve("ok"), 20)).toBe("ok");
    // The process must not be held open by the abandoned timer.
    await new Promise((r) => setTimeout(r, 40));
  });

  test("the budget is short enough for a human waiting on a push", () => {
    expect(CREDENTIAL_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});
