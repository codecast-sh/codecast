// The Evals pages' dev transport: answers every route from the fixture world
// (components/evals/__fixtures__/world.ts) so a view can be built and checked
// in a real browser before the daemon bridge and the api child exist.
//
// Dev builds only, and only when asked: `localStorage.EVALS_FIXTURE`, or
// `sessionStorage.EVALS_FIXTURE` for one tab alone (it wins when set, so a
// tab checking fixtures never flips another tab on the origin off real data)
//   "1"              answer from the world
//   "no-daemon"      act as if no daemon answered discovery
//   "no-checkout"    answer every route 503 no-checkout
//   "child-crashed"  answer every route 502 with a stderr tail
// Production builds never read the flag, and the world is a dynamic import
// inside the dev branch, so it never ships.

import { matchEvalsRoute, type EvalsErrorBody } from "@codecast/shared/contracts/evalsApi";
import type { EvalsTransport } from "./client";

export const EVALS_FIXTURE_KEY = "EVALS_FIXTURE";

export type EvalsFixtureMode = "off" | "on" | "no-daemon" | "no-checkout" | "child-crashed";

export function readEvalsFixtureMode(raw: string | null | undefined): EvalsFixtureMode {
  if (raw === "1") return "on";
  if (raw === "no-daemon" || raw === "no-checkout" || raw === "child-crashed") return raw;
  return "off";
}

/** The fixture mode this page runs in: always "off" outside a dev build. */
export function evalsFixtureMode(): EvalsFixtureMode {
  if (!import.meta.env?.DEV) return "off";
  try {
    return readEvalsFixtureMode(globalThis.sessionStorage?.getItem(EVALS_FIXTURE_KEY) ?? globalThis.localStorage?.getItem(EVALS_FIXTURE_KEY));
  } catch {
    return "off";
  }
}

const CRASH_STDERR = [
  "$ bun packages/evals/src/index.ts api --stdio",
  "error: Cannot find module './history/epochs' from '/Users/you/src/codecast/packages/evals/src/commands/api.ts'",
  "",
  "Bun v1.3.0 (macOS arm64)",
];

/** A transport over the fixture world, or over a simulated failure for the failure modes. */
export async function fixtureTransport(mode: Exclude<EvalsFixtureMode, "off" | "no-daemon">, opts: { latencyMs?: number } = {}): Promise<EvalsTransport> {
  const latency = opts.latencyMs ?? 60;
  const wait = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());
  if (mode === "no-checkout") {
    const body: EvalsErrorBody = { error: "no codecast checkout has run ./evals on this machine (EVALS_HOME/checkout.json is missing)", reason: "no-checkout" };
    return { kind: "fixture", send: async () => (await wait(), { status: 503, body }) };
  }
  if (mode === "child-crashed") {
    const body: EvalsErrorBody = { error: "the evals process exited 1", reason: "child-crashed", stderr: CRASH_STDERR };
    return { kind: "fixture", send: async () => (await wait(), { status: 502, body }) };
  }
  const { evalsFixtureWorld, EvalsFixtureMiss } = await import("../../components/evals/__fixtures__/world");
  const world = evalsFixtureWorld();
  return {
    kind: "fixture",
    async send(req) {
      await wait();
      const route = matchEvalsRoute(req.method, req.path);
      if (!route) return { status: 404, body: { error: `no route ${req.method} ${req.path}`, reason: "not-found" } satisfies EvalsErrorBody };
      try {
        // A copy, so a page that edits what it got cannot change the world.
        return { status: 200, body: structuredClone(world.answer(route.key, route.params, req.query, req.body)) };
      } catch (e) {
        if (e instanceof EvalsFixtureMiss) return { status: 404, body: { error: e.message, reason: "not-found" } satisfies EvalsErrorBody };
        throw e;
      }
    },
  };
}
