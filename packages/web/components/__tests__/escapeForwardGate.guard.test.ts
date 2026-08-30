import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ESCAPE-INTERRUPT GATE GUARD.
//
// Escape in an empty composer forwards an interrupt to the live session
// (sendEscapeToSession -> daemon "escape" -> double Escape / SIGINT on the
// agent). That must only happen while the agent is provably mid-turn. On
// 2026-08-28 a message was injected into the pane and, 400ms later, an Escape
// the user had pressed while the message was still pending reached the daemon
// and cancelled the turn the message had just started; the web then reported
// "Message hasn't reached the agent". The gate lives in ConversationView's
// handleSendEscape and reads the same isActiveAgentStatus the pending-message
// banner trusts, so the two surfaces agree on "the agent is working".
describe("Escape is only forwarded to a working agent", () => {
  test("handleSendEscape gates on isActiveAgentStatus before dispatching", () => {
    const src = readFileSync(join(import.meta.dir, "..", "ConversationView.tsx"), "utf-8");
    const start = src.indexOf("const handleSendEscape = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const dispatch = src.indexOf('"sendEscapeToSession"', start);
    expect(dispatch).toBeGreaterThan(start);
    const body = src.slice(start, dispatch);
    expect(body).toMatch(/if \(!isActiveAgentStatus\([^)]*\)\) return;/);
  });
});
