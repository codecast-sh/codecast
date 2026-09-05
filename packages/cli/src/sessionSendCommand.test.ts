import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { registerSessionSendCommand } from "./sessionSendCommand.js";

function command(env: NodeJS.ProcessEnv = {}, response: Record<string, unknown> = {}) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const output: string[] = [];
  const program = new Command();
  registerSessionSendCommand(program, {
    currentSession: () => sessionIdFromEnv(env),
    post: async (path, body) => {
      requests.push({ path, body });
      return { from_short_id: "jx7abcd", to_short_id: "jx7c6zk", ...response };
    },
    print: text => output.push(text),
  });
  return {
    requests,
    output,
    run: (...args: string[]) => program.parseAsync(["send", "jx7c6zk", ...args], { from: "user" }),
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
