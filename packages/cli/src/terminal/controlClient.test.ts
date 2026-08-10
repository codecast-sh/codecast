import { describe, expect, it } from "bun:test";
import { TmuxControlClient } from "./controlClient.js";
import { hasTmux } from "../tmux.js";

describe("TmuxControlClient.start", () => {
  // Regression: a failed attach (dead target, hung tmux server) used to
  // RESOLVE start() with fallback geometry and an empty seed — the server
  // then sent "ready" and the web client rendered a blank pane with a healthy
  // status dot. start() must reject so the client gets an error it can show.
  it.skipIf(!hasTmux())("rejects when the attach target does not exist", async () => {
    const client = new TmuxControlClient(
      { kind: "attach", target: "cast-term-does-not-exist-000", readOnly: true },
      { onOutput() {}, onExit() {} },
    );
    try {
      await expect(client.start(80, 24)).rejects.toThrow();
    } finally {
      client.close();
    }
  });
});
