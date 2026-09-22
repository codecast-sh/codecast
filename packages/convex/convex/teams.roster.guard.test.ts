import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The roster is the most subscribed query in the app, and a Convex query re-runs
// whenever anything it read changes. So what this query READS decides how often
// the backend runs it, and that is worth a test rather than a comment.
//
// On 2026-09-22 it read each member's ten most recent conversations for four
// preview fields. A running agent bumps its conversation several times a second,
// so the roster re-ran at agent-streaming rate for every open tab and phone:
// 1,620 runs in 93 seconds, 33% of all backend CPU, on a host that was then
// saturated for hours a day (ct-53363). Nothing had rendered those fields since
// the tooltip that added them stopped reading them.
//
// A surface that wants a member's recent session derives it from the sessions
// the store already syncs. This test fails if the read comes back.
const source = readFileSync(join(import.meta.dir, "teams.ts"), "utf8");

function handlerOf(name: string): string {
  const start = source.indexOf(`export const ${name} = query({`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("the team roster reads nothing that churns at streaming rate", () => {
  const handler = handlerOf("getTeamMembers");

  test("it reads no conversation", () => {
    expect(handler).not.toMatch(/query\(\s*["']conversations["']\s*\)/);
  });

  test("it reads no message", () => {
    expect(handler).not.toMatch(/query\(\s*["']messages["']\s*\)/);
  });

  test("it still reads the rows a roster is made of", () => {
    // The negative tests above would also pass if someone deleted the query,
    // so pin what it must keep doing.
    expect(handler).toMatch(/query\(\s*["']team_memberships["']\s*\)/);
    expect(handler).toMatch(/query\(\s*["']user_presence["']\s*\)/);
  });
});
