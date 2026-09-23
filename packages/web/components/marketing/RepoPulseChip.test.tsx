import { test, expect, mock, describe } from "bun:test";
// The chip says less, never wrong: no numbers until the public read answers,
// then stars and a live count in words that change with the number.
import { renderToStaticMarkup } from "react-dom/server";
let answer: { data?: unknown } = {};
mock.module("@/lib/repoTransport", () => ({
  publicRepoUrl: (repository: string, kind: string) => `https://convex.test/cli/public/repo/${repository}/${kind}`,
  usePublicRepoRead: () => ({ data: answer.data, missing: false, pending: false, ready: answer.data !== undefined, error: undefined }),
}));
mock.module("next/link", () => ({ default: (p: any) => <a href={p.href} title={p.title}>{p.children}</a> }));
const { RepoPulseChip } = await import("./RepoPulseChip");
const { pulseWords, REPO_PULSE_URL } = await import("../../lib/repoPulse");

describe("pulseWords", () => {
  test("counts agents, singular and plural, and says quiet at zero", () => {
    expect(pulseWords(4).now).toBe("4 agents now");
    expect(pulseWords(1).now).toBe("1 agent now");
    expect(pulseWords(0).now).toBe("quiet now");
  });
});

describe("RepoPulseChip", () => {
  test("reads the pulse of codecast's own repository", () => {
    expect(REPO_PULSE_URL).toBe("https://convex.test/cli/public/repo/codecast-sh/codecast/pulse");
  });
  test("links into the repository's sessions on codecast, not out to GitHub", () => {
    const html = renderToStaticMarkup(<RepoPulseChip />);
    expect(html).toContain('href="/r/codecast-sh/codecast/sessions"');
    expect(html).not.toContain("github.com");
  });
  test("before the read answers it is the octocat alone", () => {
    const html = renderToStaticMarkup(<RepoPulseChip />);
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
  });
  test("with an answer it shows stars and the live count", () => {
    answer = { data: { stargazers_count: 1234, live: 4 } };
    const html = renderToStaticMarkup(<RepoPulseChip />);
    expect(html).toContain("1,234");
    expect(html).toContain("4 agents now");
    expect(html).toContain("animate-ping");
  });
  test("a quiet repository has a still dot and no zero", () => {
    answer = { data: { stargazers_count: 33, live: 0 } };
    const html = renderToStaticMarkup(<RepoPulseChip />);
    expect(html).toContain("quiet now");
    expect(html).not.toContain("animate-ping");
    expect(html).not.toContain(">0<");
  });
  test("missing stars leave only the live half", () => {
    answer = { data: { stargazers_count: null, live: 2 } };
    const html = renderToStaticMarkup(<RepoPulseChip />);
    expect(html).toContain("2 agents now");
    expect(html).not.toContain("lucide-star");
  });
});
