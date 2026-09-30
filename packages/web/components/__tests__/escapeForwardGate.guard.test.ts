import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ESCAPE-INTERRUPT FORWARDING GUARD.
//
// Escape in an empty composer forwards an interrupt to the live session
// (sendEscapeToSession -> daemon "escape" -> double Escape / SIGINT /
// app-server turn/interrupt). The web forwards EVERY press on an owned, active
// conversation and paints the "user interrupted" line at once: its copy of the
// live agent status is a windowed overlay that goes stale, and a press dropped
// on a stale "idle" never reached the agent at all (2026-09-14). The daemon
// holds the facts and decides (cli/src/escapeInterrupt.ts).
//
// The one protection the web used to provide by gating on the status — an
// Escape pressed while a message was pending must not cancel the turn that
// message starts once the daemon pastes it (2026-08-28) — now rides on the
// press time: the daemon skips a press that predates its newest injection.
//
// The dispatch lives once, in useSessionEscape (hooks/useSessionComposerControls.ts),
// and every composer that shows a session (the conversation view, a Threads card)
// sends its Escape through it.
describe("Escape is forwarded on every press, stamped with the press time", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf-8");
  const src = read("../hooks/useSessionComposerControls.ts");
  const start = src.indexOf("export function useSessionEscape(");
  const dispatch = src.indexOf('"sendEscapeToSession"', start);
  const body = src.slice(start, dispatch);

  test("every composer sends Escape through the one hook", () => {
    for (const rel of ["ConversationView.tsx", "threads/kinds/SessionKind.tsx"]) {
      const surface = read(rel);
      expect(surface, rel).toContain("useSessionEscape(");
      expect(surface, rel).not.toContain('"sendEscapeToSession"');
    }
  });

  test("useSessionEscape dispatches without judging the live agent status", () => {
    expect(start).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(start);
    expect(body).not.toMatch(/isActiveAgentStatus|agent_status/);
  });

  test("the dispatch carries pressed_at", () => {
    const call = src.slice(dispatch, src.indexOf(")", dispatch) + 1);
    expect(call).toMatch(/pressed_at:\s*Date\.now\(\)/);
  });
});
