import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCodexJsonl, type ExportResult } from "./jsonlGenerator";
import { buildCodexImportContext } from "./codexImportContext";

const binary = process.env.CODEX_IMPORT_NATIVE_BINARY;
const sourceRollout = process.env.CODEX_IMPORT_SOURCE_ROLLOUT;

test.skipIf(!binary)("native Codex imports the full archive but sends only bounded context to the provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-import-native-"));
  const requests: Array<{ path: string; input: unknown[] }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { input: unknown[] };
      requests.push({ path: new URL(request.url).pathname, input: body.input });
      if (body.input.length > 16_384) return Response.json({ error: { message: "Invalid 'input': array too long", type: "invalid_request_error", param: "input", code: "array_above_max_length" } }, { status: 400 });
      const answer = { type: "message", role: "assistant", id: "answer", status: "completed", content: [{ type: "output_text", text: "IMPORT_OK", annotations: [] }] };
      const events = [
        { type: "response.created", response: { id: "response", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: "IMPORT_OK" },
        { type: "response.output_item.done", output_index: 0, item: answer },
        { type: "response.completed", response: { id: "response", status: "completed", output: [answer], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const timestamp = "2026-09-05T00:00:00.000Z";
    const data: ExportResult = {
      conversation: { id: "jx7b88a", title: "Long import", session_id: crypto.randomUUID(), agent_type: "claude", project_path: dir, model: null, message_count: 20_002, started_at: timestamp, updated_at: timestamp },
      messages: [
        { role: "user", content: "Original mandate", timestamp },
        ...Array.from({ length: 20_000 }, (_, i) => ({ role: "assistant", content: `historical step ${i}`, timestamp })),
        { role: "user", content: "Hold until the gate is green", timestamp },
      ],
    };
    let { jsonl } = generateCodexJsonl(data);
    if (sourceRollout) {
      const archived = readFileSync(sourceRollout, "utf8");
      const rows = archived.trim().split("\n").map(line => JSON.parse(line));
      const replacement = buildCodexImportContext(rows.filter(row => row.type === "response_item").map(row => row.payload), "jx7b88a");
      jsonl = archived.trimEnd() + "\n" + JSON.stringify({ timestamp, type: "compacted", payload: { message: "", replacement_history: replacement } }) + "\n";
    }
    for (const bounded of [false, true]) {
      const home = join(dir, bounded ? "bounded" : "control");
      mkdirSync(home);
      const path = join(home, "input.jsonl");
      writeFileSync(path, bounded ? jsonl : jsonl.split("\n").filter(line => !line || JSON.parse(line).type !== "compacted").join("\n"));
      writeFileSync(join(home, "config.toml"), `model = "gpt-6-astra"\nmodel_provider = "import_test"\nmodel_auto_compact_token_limit = 10000000\n[model_providers.import_test]\nname = "Local import test"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
      const startIndex = requests.length;
      const outputPath = join(home, "native.out");
      const errorPath = join(home, "native.err");
      const outputFd = openSync(outputPath, "w");
      const errorFd = openSync(errorPath, "w");
      const child = spawn("node", [fileURLToPath(new URL("./test-helpers/codexImportNative.mjs", import.meta.url)), binary!, home, path, dir], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", outputFd, errorFd],
      });
      closeSync(outputFd);
      closeSync(errorFd);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (code !== 0) throw new Error(readFileSync(errorPath, "utf8"));
        const output = readFileSync(join(home, "result.json"), "utf8");
        const completion = JSON.parse(output);
        const sent = requests.slice(startIndex);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every(request => request.path === "/v1/responses")).toBe(true);
        if (bounded) {
          expect(completion.status).toBe("completed");
          expect(sent.every(request => request.input.length < 16_384)).toBe(true);
          const input = JSON.stringify(sent[0].input);
          expect(input).toContain("Hold until the gate is green");
          if (!sourceRollout) {
            expect(input).toContain("Original mandate");
            expect(input).toContain("historical step 19999");
          }
        } else {
          expect(completion.status).toBe("failed");
          expect(sent[0].input.length).toBeGreaterThan(16_384);
        }
        process.stdout.write(JSON.stringify({ case: bounded ? "bounded" : "control", inputItems: sent[0].input.length, status: completion.status }) + "\n");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
          child.kill();
          await exited;
        }
      }
    }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
