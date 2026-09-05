// A repository name is case insensitive on GitHub and byte-equal in our
// indexes, so everything that parses one hands back the canonical spelling.
import { describe, expect, test } from "bun:test";
import { extractRepoFromRemoteUrl, normalizeRepository, parsePrRef, repositoryOwner } from "./prRefs";

describe("normalizeRepository", () => {
  test("lower cases owner and name and trims", () => {
    expect(normalizeRepository(" Codecast-SH/Codecast ")).toBe("codecast-sh/codecast");
  });

  test("passes null and undefined through", () => {
    expect(normalizeRepository(undefined)).toBeUndefined();
    expect(normalizeRepository(null)).toBeNull();
  });

  test("repositoryOwner is the canonical owner", () => {
    expect(repositoryOwner("Codecast-SH/Codecast")).toBe("codecast-sh");
    expect(repositoryOwner("Codecast-SH")).toBe("codecast-sh");
  });
});

describe("parsePrRef canonical spelling", () => {
  test.each([
    ["Codecast-SH/Codecast#12", 12],
    ["Codecast-SH/Codecast/12", 12],
    ["https://github.com/Codecast-SH/Codecast/pull/12/files", 12],
    ["https://codecast.sh/pr/Codecast-SH/Codecast/12", 12],
  ])("%s names codecast-sh/codecast", (raw, number) => {
    expect(parsePrRef(raw)).toEqual({ repository: "codecast-sh/codecast", number });
  });

  test("a repository alone is canonical too", () => {
    expect(parsePrRef("Codecast-SH/Codecast")).toEqual({ repository: "codecast-sh/codecast" });
  });

  test("a bare number carries no repository", () => {
    expect(parsePrRef("#12")).toEqual({ number: 12 });
  });
});

describe("extractRepoFromRemoteUrl canonical spelling", () => {
  test.each([
    "git@github.com:Codecast-SH/Codecast.git",
    "https://github.com/Codecast-SH/Codecast",
    "ssh://git@github.com/Codecast-SH/Codecast.git",
  ])("%s", (remote) => {
    expect(extractRepoFromRemoteUrl(remote)).toBe("codecast-sh/codecast");
  });

  test("a remote off GitHub is not a repository", () => {
    expect(extractRepoFromRemoteUrl("git@gitlab.com:Codecast-SH/Codecast.git")).toBeNull();
  });
});
