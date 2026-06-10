import { describe, expect, test } from "bun:test";
import {
  EMPTY_RESOLUTION,
  ZERO_SHA,
  augmentPorcelain,
  formatDefaultBlame,
  formatGitDate,
  parseBlamePorcelain,
  sessionLabel,
  uncommittedLinesToMatch,
  type BlameResolution,
} from "./blame";

// Real `git blame --porcelain` / `git blame` outputs captured from a probe
// repo (root/boundary commit, a second author, one uncommitted line). The
// formatter must reproduce git's default rendering byte-for-byte from the
// porcelain — that equivalence is the drop-in guarantee.
const PORCELAIN = `c8219e945b7eba64dc69e07dd25052344d187c29 1 1 2
author Al
author-mail <a@b.c>
author-time 1781076368
author-tz -0400
committer Al
committer-mail <a@b.c>
committer-time 1781076368
committer-tz -0400
summary one
boundary
filename f.txt
\tone
c8219e945b7eba64dc69e07dd25052344d187c29 2 2
\ttwo
0734898927ee6bfd79c0619b2b6cea59d2ba235f 3 3 1
author Bartholomew Longname
author-mail <a@b.c>
author-time 1781076368
author-tz -0400
committer Bartholomew Longname
committer-mail <a@b.c>
committer-time 1781076368
committer-tz -0400
summary two
previous c8219e945b7eba64dc69e07dd25052344d187c29 f.txt
filename f.txt
\tthree
0000000000000000000000000000000000000000 4 4 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1781076612
author-tz -0400
committer Not Committed Yet
committer-mail <not.committed.yet>
committer-time 1781076612
committer-tz -0400
summary Version of f.txt from f.txt
previous 0734898927ee6bfd79c0619b2b6cea59d2ba235f f.txt
filename f.txt
\tfour-uncommitted
`;

const GIT_DEFAULT = `^c8219e9 (Al                   2026-06-10 03:26:08 -0400 1) one
^c8219e9 (Al                   2026-06-10 03:26:08 -0400 2) two
07348989 (Bartholomew Longname 2026-06-10 03:26:08 -0400 3) three
00000000 (Not Committed Yet    2026-06-10 03:30:12 -0400 4) four-uncommitted`;

describe("parseBlamePorcelain", () => {
  test("extracts lines, commit metadata, and boundary flag", () => {
    const parsed = parseBlamePorcelain(PORCELAIN);
    expect(parsed.lines.map((l) => l.content)).toEqual(["one", "two", "three", "four-uncommitted"]);
    expect(parsed.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
    const root = parsed.commits.get("c8219e945b7eba64dc69e07dd25052344d187c29")!;
    expect(root.author).toBe("Al");
    expect(root.boundary).toBe(true);
    expect(root.authorTime).toBe(1781076368);
    expect(root.authorTz).toBe("-0400");
    expect(parsed.commits.get(ZERO_SHA)!.author).toBe("Not Committed Yet");
  });
});

describe("formatGitDate", () => {
  test("renders in the author's timezone like git", () => {
    expect(formatGitDate(1781076368, "-0400")).toBe("2026-06-10 03:26:08 -0400");
    expect(formatGitDate(1766628673, "-0800")).toBe("2025-12-24 18:11:13 -0800");
    expect(formatGitDate(0, "+0000")).toBe("1970-01-01 00:00:00 +0000");
    expect(formatGitDate(3600, "+0530")).toBe("1970-01-01 06:30:00 +0530");
  });
});

describe("formatDefaultBlame", () => {
  test("reproduces git blame's default output byte-for-byte when nothing resolves", () => {
    const parsed = parseBlamePorcelain(PORCELAIN);
    expect(formatDefaultBlame(parsed, EMPTY_RESOLUTION, 8)).toBe(GIT_DEFAULT);
  });

  test("swaps resolved shas' author column for the session label and re-pads", () => {
    const parsed = parseBlamePorcelain(PORCELAIN);
    const resolution: BlameResolution = {
      bySha: new Map([
        [
          "0734898927ee6bfd79c0619b2b6cea59d2ba235f",
          { conversation_id: "jx7bcdsm572w8abpms5vanx0ms88dvxv", title: "Organize commits" },
        ],
      ]),
      byUncommittedLine: new Map([
        [
          "four-uncommitted",
          { conversation_id: "jx794j1m572w8abpms5vanx0ms88dvxv", title: "Model tooltip" },
        ],
      ]),
    };
    const out = formatDefaultBlame(parsed, resolution, 8);
    const lines = out.split("\n");
    expect(lines[2]).toBe("07348989 (jx7bcds Organize commits 2026-06-10 03:26:08 -0400 3) three");
    expect(lines[3]).toBe("00000000 (jx794j1 Model tooltip    2026-06-10 03:30:12 -0400 4) four-uncommitted");
    // Unresolved lines keep the git author, padded to the new widest who.
    expect(lines[0]).toBe("^c8219e9 (Al                       2026-06-10 03:26:08 -0400 1) one");
    // Structure stays parseable by git-blame-shaped regexes.
    for (const line of lines) {
      expect(line).toMatch(/^[\^0-9a-f]+ \(.+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} +\d+\) /);
    }
  });
});

describe("sessionLabel", () => {
  test("short id + title, parens stripped, long titles truncated", () => {
    expect(
      sessionLabel({ conversation_id: "jx7bcdsm572w8abpms5vanx0ms88dvxv", title: "Fix (auth) flow" }),
    ).toBe("jx7bcds Fix auth flow");
    const long = sessionLabel({
      conversation_id: "jx7bcdsm572w8abpms5vanx0ms88dvxv",
      title: "An extremely long conversation title that keeps going",
    });
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("..")).toBe(true);
  });
});

describe("uncommittedLinesToMatch", () => {
  test("collects unique trimmed uncommitted lines, skipping short ones", () => {
    const parsed = parseBlamePorcelain(PORCELAIN);
    expect(uncommittedLinesToMatch(parsed)).toEqual(["four-uncommitted"]);
  });
});

describe("augmentPorcelain", () => {
  const resolution: BlameResolution = {
    bySha: new Map([
      [
        "0734898927ee6bfd79c0619b2b6cea59d2ba235f",
        {
          conversation_id: "jx7bcdsm572w8abpms5vanx0ms88dvxv",
          title: "Organize commits",
          message_id: "k17abc",
        },
      ],
    ]),
    byUncommittedLine: new Map([
      ["four-uncommitted", { conversation_id: "jx794j1m572w8abpms5vanx0ms88dvxv", title: "Model tooltip" }],
    ]),
  };

  test("injects codecast keys after the summary of resolved blocks only", () => {
    const out = augmentPorcelain(PORCELAIN, resolution);
    const lines = out.split("\n");
    const summaryIdx = lines.indexOf("summary two");
    expect(lines[summaryIdx + 1]).toBe("codecast-session jx7bcds");
    expect(lines[summaryIdx + 2]).toBe("codecast-conversation jx7bcdsm572w8abpms5vanx0ms88dvxv");
    expect(lines[summaryIdx + 3]).toBe("codecast-title Organize commits");
    expect(lines[summaryIdx + 4]).toBe(
      "codecast-url https://codecast.sh/conversation/jx7bcdsm572w8abpms5vanx0ms88dvxv",
    );
    expect(lines[summaryIdx + 5]).toBe("codecast-message k17abc");
    // The boundary commit resolved to nothing — no keys injected there.
    expect(lines[lines.indexOf("summary one") + 1]).toBe("boundary");
  });

  test("attributes the zero-sha block from its content line", () => {
    const out = augmentPorcelain(PORCELAIN, resolution);
    const lines = out.split("\n");
    const idx = lines.indexOf("summary Version of f.txt from f.txt");
    expect(lines[idx + 1]).toBe("codecast-session jx794j1");
  });

  test("leaves content lines and structure untouched", () => {
    const out = augmentPorcelain(PORCELAIN, resolution);
    const stripped = out
      .split("\n")
      .filter((l) => !l.startsWith("codecast-"))
      .join("\n");
    expect(stripped).toBe(PORCELAIN);
  });

  test("no-op without resolutions", () => {
    expect(augmentPorcelain(PORCELAIN, EMPTY_RESOLUTION)).toBe(PORCELAIN);
  });
});
