import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, describe, expect, test } from "bun:test";
import { injectViaTmux, takeTmuxSubmitVerdict } from "./daemon.js";
import { pasteTextIntoPane } from "./tmuxPaste.js";
import { tmuxRun } from "./tmux.js";
import {
  hasBinary,
  spawnClientPane,
  startFakeModelEndpoint,
  waitFor,
} from "./test-helpers/messagingHarness.js";

describe.skipIf(!hasBinary("tmux") || !hasBinary("claude"))("short-message delivery into Claude", () => {
  afterAll(killIsolatedTmuxServer);

  test.each(["empty", "already pasted"])("hi submits exactly once from a composer that is %s", async (draft) => {
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject();
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000, label: "claude prompt" });
      expect(pane.capture()).toContain("shift+tab");
      const sessionId = pane.sessionId()!;
      expect(tmuxRun(["set-option", "-t", pane.target, "@codecast_session_id", sessionId]).status).toBe(0);
      if (draft === "already pasted") {
        await pasteTextIntoPane(async (args) => ({ stdout: tmuxRun(args).stdout ?? "" }), pane.target, "hi", true);
        await waitFor(() => /❯\s*hi/.test(pane.capture()), { timeoutMs: 20_000, label: "hi draft" });
      }

      await injectViaTmux(pane.target, "hi", "claude");
      expect(takeTmuxSubmitVerdict(sessionId)?.outcome).toBe("delivered");
      await waitFor(() => pane.userMessages().length > 0, { timeoutMs: 20_000, label: "submitted hi" });
      expect(pane.userMessages().map((message) => message.trim())).toEqual(["hi"]);
      expect(endpoint.requests()).toBeGreaterThan(0);
    } finally {
      pane.tearDown();
      endpoint.close();
    }
  }, 120_000);
});
