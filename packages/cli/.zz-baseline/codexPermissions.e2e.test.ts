import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, type SandboxPolicy } from "./codexAppServer.js";
import { codexResumeParams, type PersistedCodexThread } from "./codexTurnRecovery.js";

const binary = process.env.CODEX_PERMISSIONS_NATIVE_BINARY;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.skipIf(!binary)("native Codex defaults survive turns and cold restart while explicit restrictions remain enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-permissions-native-"));
  const home = join(dir, "codex");
  const cwd = join(dir, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const requests: unknown[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health") return new Response("NETWORK_OK");
      requests.push(await request.json());
      const answer = { type: "message", role: "assistant", id: "answer", status: "completed", content: [{ type: "output_text", text: "PERMISSIONS_OK", annotations: [] }] };
      const events = [
        { type: "response.created", response: { id: "response", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: "PERMISSIONS_OK" },
        { type: "response.output_item.done", output_index: 0, item: answer },
        { type: "response.completed", response: { id: "response", status: "completed", output: [answer], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const wrapper = join(dir, "codex-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nunset OPENAI_API_KEY\nexport CODEX_HOME=${quote(home)}\nexec ${quote(binary!)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, "config.toml"), `model = "gpt-6-astra"\nmodel_provider = "permissions_test"\n[model_providers.permissions_test]\nname = "Local permissions test"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  let server: CodexAppServer | undefined;
  const log: string[] = [];
  const boot = async () => {
    server = new CodexAppServer({ codexBinary: wrapper, log: line => log.push(line), defaultPermissions: () => ({ sandbox: "danger-full-access", approvalPolicy: "never" }) });
    server.on("error", () => {});
    const ready = once(server, "ready");
    server.start();
    await ready;
    return server;
  };
  const stop = async () => {
    if (!server) return;
    if (!server.running) { server.stop(); return; }
    const exited = once(server, "exited");
    server.stop();
    await exited;
  };
  const turn = async (threadId: string) => {
    const done = once(server!, "turnCompleted");
    await server!.turnStart({ threadId, input: [{ type: "text", text: "Reply PERMISSIONS_OK." }] });
    const result = await done;
    expect(result[3]).toBe("completed");
  };
  const checkAccess = async (policy: SandboxPolicy, allowed: boolean) => {
    const write = await (server as any).sendRequest("command/exec", {
      cwd, sandboxPolicy: policy, command: ["/bin/sh", "-c", `printf WRITE_OK > ${quote(join(dir, "outside-project"))}`], timeoutMs: 5000,
    }, 10_000);
    expect(write.exitCode === 0).toBe(allowed);
    const network = await (server as any).sendRequest("command/exec", {
      cwd, sandboxPolicy: policy, command: ["/usr/bin/curl", "--max-time", "3", "-fsS", `http://127.0.0.1:${provider.port}/health`], timeoutMs: 5000,
    }, 10_000);
    expect(network.exitCode === 0).toBe(allowed);
    if (allowed) expect(network.stdout).toBe("NETWORK_OK");
    process.stdout.write(JSON.stringify({ policy: policy.type, write: write.exitCode, network: network.exitCode }) + "\n");
  };
  try {
    await boot();
    const started = await server!.threadStart({ cwd });
    expect(started.sandbox).toEqual({ type: "dangerFullAccess" });
    await turn(started.thread.id);
    const saved: PersistedCodexThread = JSON.parse(JSON.stringify({ threadId: started.thread.id, cwd, updatedAt: 1, sandboxPolicy: started.sandbox }));
    await checkAccess(started.sandbox, true);
    await stop();

    await boot();
    const resumed = await server!.threadResume(codexResumeParams(saved, "never"));
    expect(resumed.sandbox).toEqual(started.sandbox);
    await turn(saved.threadId);
    await checkAccess(resumed.sandbox, true);
    const contexts = readFileSync(resumed.thread.path!, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "turn_context");
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    for (const context of contexts) expect(context.payload.sandbox_policy.type).toBe("danger-full-access");
    await stop();

    await boot();
    const legacy = await server!.threadResume(codexResumeParams({ threadId: saved.threadId, cwd, updatedAt: 1 }, "never"));
    expect(legacy.sandbox.type).toBe("readOnly");
    await checkAccess(legacy.sandbox, false);
    await stop();

    await boot();
    const invalidated = await server!.threadResume(codexResumeParams({ ...saved, sandboxPolicy: null }, "never"));
    expect(invalidated.sandbox.type).toBe("readOnly");
    await checkAccess(invalidated.sandbox, false);
    const forked = await server!.threadFork({ threadId: saved.threadId, cwd });
    expect(forked.sandbox).toEqual(started.sandbox);
    const safe = await server!.threadStart({ cwd, sandbox: "read-only", approvalPolicy: "never" });
    expect(safe.sandbox.type).toBe("readOnly");
    await turn(safe.thread.id);
    await checkAccess(safe.sandbox, false);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    process.stdout.write(JSON.stringify({ cases: ["default-start", "turn-restatement", "cold-resume", "old-absent-invalidation", "invalidated-resume", "default-fork", "explicit-read-only"], status: "passed" }) + "\n");
  } finally {
    await stop();
    provider.stop(true);
    if (process.env.CODEX_PERMISSIONS_EVIDENCE) writeFileSync(process.env.CODEX_PERMISSIONS_EVIDENCE, log.join("\n"));
    if (!process.env.CODEX_PERMISSIONS_EVIDENCE) rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
