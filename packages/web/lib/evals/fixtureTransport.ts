// The Evals pages' dev transport: answers every route from the fixture world
// (components/evals/__fixtures__/world.ts) so a view can be built and checked
// in a real browser with no daemon and no checkout. The world's records go
// through the handler the api child runs (@platform/evals/query), so a fixture
// page shows production's own verdicts.
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

import type { EvalsErrorBody } from "@codecast/shared/contracts/evalsApi";
import { localTransport, type EvalsTransport } from "@platform/evals/client";

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

/** A transport over the fixture world, or over a simulated failure for the failure modes. Every answer is a copy, so a page that edits what it got cannot change the world. */
export async function fixtureTransport(mode: Exclude<EvalsFixtureMode, "off" | "no-daemon">, opts: { latencyMs?: number } = {}): Promise<EvalsTransport> {
  const latency = opts.latencyMs ?? 60;
  const wait = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());
  const fixture = (answer: Parameters<typeof localTransport>[0]) => localTransport(async (req) => (await wait(), answer(req)), "fixture");
  if (mode === "no-checkout") {
    const body: EvalsErrorBody = { error: "no codecast checkout has run ./evals on this machine (EVALS_HOME/checkout.json is missing)", reason: "no-checkout" };
    return fixture(async () => ({ status: 503, body }));
  }
  if (mode === "child-crashed") {
    const body: EvalsErrorBody = { error: "the evals process exited 1", reason: "child-crashed", stderr: CRASH_STDERR };
    return fixture(async () => ({ status: 502, body }));
  }
  const { evalsFixtureWorld } = await import("../../components/evals/__fixtures__/world");
  return fixture(evalsFixtureWorld().handle);
}
