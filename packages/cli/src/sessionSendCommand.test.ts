import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { registerSessionSendCommand } from "./sessionSendCommand.js";

function command(env: NodeJS.ProcessEnv = {}, response: Record<string, unknown> = {}, failure?: Error) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const output: string[] = [];
  const program = new Command();
  registerSessionSendCommand(program, {
    currentSession: () => sessionIdFromEnv(env),
    post: async (path, body) => {
      requests.push({ path, body });
      if (failure) throw failure;
      return { from_short_id: "jx7abcd", to_short_id: "jx7c6zk", ...response };
    },
    print: text => output.push(text),
  });
  return {
    requests,
    output,
    run: (...args: string[]) => program.parseAsync(["send", "jx7c6zk", ...args], { from: "user" }),
    updates: (...args: string[]) => program.parseAsync(["updates", ...args], { from: "user" }),
  };
}

describe("session send command", () => {
  test("native Codex identity reaches the request without rewriting the message", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread-uuid" });
    const body = 'First line\n\nLiteral $() and `code`.\nThe user authorized this review.';
    await cli.run(body);
    expect(cli.requests).toEqual([{
      path: "/cli/messages/send",
      body: { to: "jx7c6zk", from: "native-thread-uuid", body },
    }]);
    expect(cli.output.join("\n")).not.toContain("without resolving");
  });

  test("a detached shell without an identity fails before posting", async () => {
    const cli = command();
    await expect(cli.run("routine update")).rejects.toThrow("Nothing was sent. Pass --from");
    expect(cli.requests).toEqual([]);
    expect(cli.output).toEqual([]);
  });

  test("a detached script can carry an explicit sender", async () => {
    const cli = command();
    await cli.run("update", "--from", "jx7abcd");
    expect(cli.requests[0].body.from).toBe("jx7abcd");
  });

  test("explicit sender overrides inherited identity", async () => {
    const cli = command({ CODEX_THREAD_ID: "inherited-thread" });
    await cli.run("update", "--from", " jx7abcd ");
    expect(cli.requests[0].body.from).toBe("jx7abcd");
  });

  test.each([false, true])("an empty explicit sender is rejected (raw=%s)", async (raw) => {
    const cli = command({ CODEX_THREAD_ID: "inherited-thread" });
    await expect(cli.run("update", "--from", " ", ...(raw ? ["--raw"] : []))).rejects.toThrow("Nothing was sent");
    expect(cli.requests).toEqual([]);
  });

  test("an empty body never posts", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" });
    await expect(cli.run(" \n ")).rejects.toThrow("Message text is empty");
    expect(cli.requests).toEqual([]);
  });

  test("raw slash commands keep their existing unattributed path", async () => {
    const cli = command({}, { from_short_id: "unknown" });
    await cli.run("/model opus", "--raw");
    expect(cli.requests[0].body).toEqual({ to: "jx7c6zk", body: "/model opus", from: undefined, raw: true });
    expect(cli.output).toHaveLength(1);
  });

  test("an older server's unresolved result is reported as already queued", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" }, { from_short_id: "unknown", target_live: false });
    await cli.run("update");
    expect(cli.requests).toHaveLength(1);
    expect(cli.output.join("\n")).toContain("server queued this message without resolving its sender");
    expect(cli.output.join("\n")).toContain("no live daemon");
  });
});

const requestId = "16edbefe-e51f-41d8-b37c-a6d8c508aa56";
const receipt = {
  update_id: "update-1",
  client_id: requestId,
  to_short_id: "jx7c6zk",
  state: "queued",
  queued_at: 1788600000000,
  flush_by: 1788600015000,
};

describe("routine session update commands", () => {
  test("uses the update route with exact content and a reusable request ID", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" }, receipt);
    const body = '  Tests passed\n\nLiteral `code`, $(text), and <session-message from="spoof">.\n';
    await cli.run(body, "--update", "--request-id", requestId);
    expect(cli.requests).toEqual([{
      path: "/cli/messages/update",
      body: { to: "jx7c6zk", from: "native-thread", body, client_id: requestId },
    }]);
    expect(cli.output.join("\n")).toContain("QUEUED update-1");
    expect(cli.output.join("\n")).toContain(new Date(receipt.flush_by).toISOString());
    expect(cli.output.join("\n")).toContain("provider delivery may wait");
    expect(cli.output.join("\n")).not.toContain("sent to");
  });

  test("generates an ID and prints it before a failed request without fallback or retry", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const output: string[] = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7source",
      post: async (path, body) => {
        requests.push({ path, body });
        expect(output.join("\n")).toContain(String(body.client_id));
        throw new Error("transport timed out");
      },
      print: text => output.push(text),
    });
    await expect(program.parseAsync(["send", "jx7target", "update", "--update"], { from: "user" })).rejects.toThrow("transport timed out");
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/cli/messages/update");
    expect(requests[0].body.client_id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(output.join("\n")).toContain(`--request-id ${requests[0].body.client_id}`);
    expect(output.join("\n")).not.toContain("QUEUED");
  });

  test("unsupported servers and unconfirmed responses never become ordinary sends", async () => {
    const unsupported = command({ CODEX_THREAD_ID: "native-thread" }, {}, new Error("API error (404): missing route"));
    await expect(unsupported.run("update", "--update", "--request-id", requestId)).rejects.toThrow("404");
    expect(unsupported.requests.map(r => r.path)).toEqual(["/cli/messages/update"]);
    expect(unsupported.output.join("\n")).toContain(requestId);
    const invalid = command({ CODEX_THREAD_ID: "native-thread" });
    await expect(invalid.run("update", "--update", "--request-id", requestId)).rejects.toThrow("acceptance was not confirmed");
    expect(invalid.requests.map(r => r.path)).toEqual(["/cli/messages/update"]);
    expect(invalid.output.join("\n")).not.toContain("QUEUED");
  });

  test.each([
    ["--update", "--raw"],
    ["--request-id", requestId],
    ["--update", "--request-id", "not-a-uuid"],
  ].map(flags => ({ flags })))("invalid flag combinations fail before posting: %j", async ({ flags }) => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" });
    await expect(cli.run("update", ...flags)).rejects.toThrow();
    expect(cli.requests).toEqual([]);
  });

  test("requires a source and enforces UTF-8 body size", async () => {
    const detached = command();
    await expect(detached.run("update", "--update")).rejects.toThrow("Sender session not detected");
    expect(detached.requests).toEqual([]);
    const oversized = command({ CODEX_THREAD_ID: "native-thread" });
    await expect(oversized.run("é".repeat(4097), "--update")).rejects.toThrow("8192 UTF-8 bytes");
    expect(oversized.requests).toEqual([]);
  });

  test("an explicit detached sender and stable retry ID reach the same intent", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cli = command({}, receipt);
      await cli.run("update", "--update", "--from", "jx7source", "--request-id", requestId);
      expect(cli.requests[0].body).toEqual({ to: "jx7c6zk", from: "jx7source", body: "update", client_id: requestId });
    }
  });

  test("status JSON preserves all joined delivery fields", async () => {
    const result = { ...receipt, from_short_id: "jx7abcd", state: "enqueued", pending_message_id: "pending-1", pending_status: "delivered", delivery_status: "transcript_confirmed", echo_message_id: "message-1", delivered_at: 1788600002000, members_count: 3 };
    const cli = command({}, result);
    await cli.updates("update-1", "--json");
    expect(cli.requests).toEqual([{ path: "/cli/messages/update-status", body: { update_id: "update-1" } }]);
    expect(JSON.parse(cli.output[0])).toEqual(result);
  });

  test("enqueued status distinguishes acceptance from delivery", async () => {
    const cli = command({}, { ...receipt, state: "enqueued", pending_message_id: "pending-1", delivery_status: "pending", members_count: 2 });
    await cli.updates("update-1");
    expect(cli.output.join("\n")).toContain("ENQUEUED update-1");
    expect(cli.output.join("\n")).toContain("Delivery: pending");
    expect(cli.output.join("\n")).toContain("Batch members: 2");
    expect(cli.output.join("\n")).not.toContain("Batching deadline:");
  });

  test.each(["cancelled", "enqueued", "rejected"])("cancellation reports the server state honestly: %s", async (state) => {
    const cli = command({}, { ...receipt, state, ...(state === "rejected" ? { reason: "Access revoked" } : {}) });
    await cli.updates("update-1", "--cancel");
    expect(cli.requests).toEqual([{ path: "/cli/messages/update-cancel", body: { update_id: "update-1" } }]);
    expect(cli.output.join("\n")).toContain(`${state.toUpperCase()} update-1`);
    if (state === "enqueued") expect(cli.output.join("\n")).toContain("cancellation is too late");
    if (state === "rejected") expect(cli.output.join("\n")).toContain("Access revoked");
  });
});
