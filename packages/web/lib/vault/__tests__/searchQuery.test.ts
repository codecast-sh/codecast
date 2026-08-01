import { test, expect, describe } from "bun:test";
import {
  parseVaultQuery,
  fileMatchesQuery,
  blockMatchesPhrases,
  hasRankableText,
} from "../searchQuery";

describe("plain terms", () => {
  test("bare words become the index query", () => {
    const q = parseVaultQuery("raft consensus");
    expect(q.text).toBe("raft consensus");
    expect(q.isEmpty).toBe(false);
    expect(hasRankableText(q)).toBe(true);
  });

  test("empty and whitespace-only input is empty", () => {
    for (const input of ["", "   ", "\n\t"]) {
      const q = parseVaultQuery(input);
      expect(q.isEmpty).toBe(true);
      expect(q.text).toBe("");
    }
  });

  test("an unknown operator stays plain text", () => {
    // Only the core four are operators; `section:` isn't shipped yet and must
    // not silently drop the words the user typed.
    expect(parseVaultQuery("section:intro raft").text).toBe("section:intro raft");
  });
});

describe("path:", () => {
  test("collects a lowercased substring and keeps it out of the text", () => {
    const q = parseVaultQuery("path:Projects raft");
    expect(q.paths).toEqual(["projects"]);
    expect(q.text).toBe("raft");
  });

  test("quoted values may contain spaces", () => {
    expect(parseVaultQuery('path:"daily notes"').paths).toEqual(["daily notes"]);
  });

  test("repeats intersect", () => {
    const q = parseVaultQuery("path:work path:2026");
    expect(q.paths).toEqual(["work", "2026"]);
    expect(fileMatchesQuery(q, "Work/2026/Q1.md", "")).toBe(true);
    expect(fileMatchesQuery(q, "Work/2025/Q1.md", "")).toBe(false);
  });
});

describe("file:", () => {
  test("matches the basename without its extension", () => {
    const q = parseVaultQuery("file:consensus");
    expect(fileMatchesQuery(q, "Notes/Distributed Consensus.md", "")).toBe(true);
    expect(fileMatchesQuery(q, "Consensus/Other.md", "")).toBe(false);
  });

  test("does not match on the extension itself", () => {
    expect(fileMatchesQuery(parseVaultQuery("file:md"), "Notes/Raft.md", "")).toBe(false);
  });
});

describe("tag:", () => {
  test("accepts both #x and x, normalized without the hash", () => {
    expect(parseVaultQuery("tag:#status/draft").tags).toEqual(["status/draft"]);
    expect(parseVaultQuery("tag:Status").tags).toEqual(["status"]);
  });

  test("a tag alone is a real query even with no text", () => {
    const q = parseVaultQuery("tag:draft");
    expect(q.isEmpty).toBe(false);
    expect(hasRankableText(q)).toBe(false);
  });
});

describe("quoted phrases", () => {
  test("a phrase filters blocks and still feeds the index", () => {
    const q = parseVaultQuery('"split votes"');
    expect(q.phrases).toEqual(["split votes"]);
    expect(q.text).toBe("split votes");
  });

  test("phrase matching is case-insensitive and survives soft wraps", () => {
    const q = parseVaultQuery('"randomized timeout"');
    expect(blockMatchesPhrases("Raft uses a Randomized\n  Timeout to avoid ties.", q.phrases)).toBe(true);
    expect(blockMatchesPhrases("Raft uses a timeout that is randomized.", q.phrases)).toBe(false);
  });

  test("no phrases means no constraint", () => {
    expect(blockMatchesPhrases("anything at all", [])).toBe(true);
  });

  test("an unterminated quote is treated as a phrase (typing in progress)", () => {
    const q = parseVaultQuery('"split vot');
    expect(q.phrases).toEqual(["split vot"]);
  });
});

describe("negation", () => {
  test("drops files whose text contains the term", () => {
    const q = parseVaultQuery("raft -paxos");
    expect(q.negations).toEqual(["paxos"]);
    expect(q.text).toBe("raft");
    expect(fileMatchesQuery(q, "Notes/Raft.md", "Raft elects a leader.")).toBe(true);
    expect(fileMatchesQuery(q, "Notes/Raft.md", "Unlike Paxos, Raft is simple.")).toBe(false);
  });

  test("also drops on a path hit, so -archive excludes a folder", () => {
    const q = parseVaultQuery("-archive");
    expect(fileMatchesQuery(q, "Archive/Old.md", "current thinking")).toBe(false);
  });

  test("a quoted negation may contain spaces", () => {
    const q = parseVaultQuery('-"work in progress"');
    expect(q.negations).toEqual(["work in progress"]);
    expect(fileMatchesQuery(q, "Notes/A.md", "Work In Progress — do not read")).toBe(false);
  });

  test("a bare dash is not a negation", () => {
    const q = parseVaultQuery("raft - consensus");
    expect(q.negations).toEqual([]);
    expect(q.text).toBe("raft - consensus");
  });
});

describe("dangling operators", () => {
  test("contribute nothing while half-typed", () => {
    for (const input of ["tag:", "path:", "file:", 'path:""']) {
      const q = parseVaultQuery(input);
      expect({ input, ...q }).toMatchObject({
        text: "",
        paths: [],
        files: [],
        tags: [],
        isEmpty: true,
      });
    }
  });

  test("a dangling operator beside real terms leaves the terms alone", () => {
    const q = parseVaultQuery("raft tag:");
    expect(q.text).toBe("raft");
    expect(q.tags).toEqual([]);
  });
});

describe("combinations", () => {
  test("every operator at once", () => {
    const q = parseVaultQuery('path:Notes file:raft tag:#distributed "log replication" leader -paxos');
    expect(q).toMatchObject({
      paths: ["notes"],
      files: ["raft"],
      tags: ["distributed"],
      phrases: ["log replication"],
      negations: ["paxos"],
      isEmpty: false,
    });
    expect(q.text).toBe("log replication leader");
  });

  test("filters compose over one file", () => {
    const q = parseVaultQuery("path:notes file:raft -paxos");
    expect(fileMatchesQuery(q, "Notes/Raft.md", "leader election")).toBe(true);
    expect(fileMatchesQuery(q, "Notes/Raft.md", "compared to paxos")).toBe(false);
    expect(fileMatchesQuery(q, "Other/Raft.md", "leader election")).toBe(false);
    expect(fileMatchesQuery(q, "Notes/Consensus.md", "leader election")).toBe(false);
  });

  test("operator names are case-insensitive", () => {
    expect(parseVaultQuery("PATH:Notes Tag:Draft")).toMatchObject({
      paths: ["notes"],
      tags: ["draft"],
      text: "",
    });
  });
});
