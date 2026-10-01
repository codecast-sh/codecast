// Request-body goldens: the exact bytes a server call site posts to the
// Anthropic API, recorded from the code before a refactor and asserted after
// it. The evals replay these same request builders, so a golden that moves
// means the evals measure a prompt prod never sends.
//
// Fixtures are synthetic: this repo is public. Re-record deliberately with
// UPDATE_GOLDENS=1 only when a prompt change is intended, and read the diff.
//
// The file name carries two dots so the Convex bundler skips it (it imports
// node:fs, which the Convex runtime does not have).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicBody, type SurfaceRequest } from "../lib/anthropic";

export type GoldenCase = { case: string; body: string };

// fenceForeignText draws a fresh nonce for every fence, in prod as here, so a
// recorded body pins it to zeros. Everything else stays byte for byte.
export function normalizeBody(body: string): string {
  return body.replace(/untrusted-[0-9a-f]{8}/g, "untrusted-00000000");
}

/** The body prod posts for a request, as the goldens record it. */
export function goldenBody(req: SurfaceRequest): string {
  return normalizeBody(JSON.stringify(anthropicBody(req)));
}

/**
 * Fetch stub that records each posted body and answers with `reply` as one
 * text block, in the shape the Messages API returns. `callModel` keeps only
 * `type: "text"` blocks, so a reply without the type would never arrive.
 */
export function captureFetch(reply = "") {
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  return {
    bodies,
    install() {
      process.env.ANTHROPIC_API_KEY = "test-key";
      globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
        bodies.push(normalizeBody(init.body));
        return new Response(
          JSON.stringify({
            type: "message",
            role: "assistant",
            model: JSON.parse(init.body).model,
            content: [{ type: "text", text: reply }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    },
  };
}

const goldenFile = (name: string, dir: string) => join(dir, `${name}.json`);

/** Every recorded case for `name`. Read only: nothing here ever writes. */
export function loadGolden(name: string, dir = import.meta.dir): GoldenCase[] {
  const file = goldenFile(name, dir);
  if (!existsSync(file)) throw new Error(`no golden ${file}: record it with UPDATE_GOLDENS=1 from the code before the change`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The recorded cases matching `actual`'s names, in `actual`'s order, for
 * `expect(actual).toEqual(recordGolden(name, actual))`. A case the golden
 * lacks comes back with a body that names the fix, so the diff says why.
 *
 * Under UPDATE_GOLDENS=1 it first writes `actual` into the file case by case:
 * a case it produced replaces the recorded one of the same name, and every
 * other recorded case stays. So tests that share one golden, or one that
 * records only some of its cases, never erase each other's. A case no fixture
 * produces any more stays too; delete it by hand when you drop the fixture.
 */
export function recordGolden(name: string, actual: GoldenCase[], dir = import.meta.dir): GoldenCase[] {
  const file = goldenFile(name, dir);
  if (process.env.UPDATE_GOLDENS === "1" && actual.length > 0) {
    const merged = existsSync(file) ? loadGolden(name, dir) : [];
    for (const c of actual) {
      const at = merged.findIndex((g) => g.case === c.case);
      if (at >= 0) merged[at] = c;
      else merged.push(c);
    }
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  }
  const recorded = new Map(loadGolden(name, dir).map((g) => [g.case, g]));
  return actual.map((c) => recorded.get(c.case) ?? { case: c.case, body: `no recorded case "${c.case}" in ${file}: record it with UPDATE_GOLDENS=1` });
}
