import { RetryQueue, defaultClassifyError } from "@platform/cli-kit/retryQueue";
import { AsyncResource } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { discardShellChanges, readShellChangeBatch, shellChangesDir, type WireFileChange } from "./shellChanges.js";

type PendingShellChange = { conversationId: string; messageUuid: string; toolUseId: string; offset: number };
type Upload = (params: { conversation_id: string; message_uuid: string; changes: WireFileChange[] }) => Promise<unknown>;

export class ShellChangeSync {
  private queue: RetryQueue<PendingShellChange>;
  private dir: string;

  constructor(upload: Upload, options: { dir?: string; onLog?: (message: string) => void; initialDelayMs?: number } = {}) {
    this.dir = options.dir ?? shellChangesDir();
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = new RetryQueue({
      persistPath: path.join(this.dir, "uploads.json"),
      droppedPath: path.join(this.dir, "failed-uploads.json"),
      concurrency: 1,
      initialDelayMs: options.initialDelayMs ?? 1_000,
      maxDelayMs: 60_000,
      maxAttempts: 100,
      onLog: options.onLog,
      serialKey: (op) => op.params.toolUseId,
      classifyError: (error) => error.includes("Unauthorized shell diff") || error.includes("does not match") || error.includes("exceeds") ? "permanent" : defaultClassifyError(error),
    });
    this.queue.setExecutor(AsyncResource.bind(async (op) => {
      const { conversationId, messageUuid, toolUseId, offset } = op.params;
      const batch = await readShellChangeBatch(toolUseId, offset, this.dir);
      if (batch.quarantined) options.onLog?.(`Quarantined unverified bulk shell capture ${toolUseId}; transcript sync is unaffected`);
      if (batch.changes.length) await upload({ conversation_id: conversationId, message_uuid: messageUuid, changes: batch.changes });
      if (batch.done) {
        discardShellChanges([toolUseId], this.dir);
      } else {
        this.queue.add("shellChanges", { ...op.params, offset: batch.next });
      }
      this.queue.persistNow({ sync: true });
      return true;
    }));
    this.queue.start();
  }

  enqueue(conversationId: string, messageUuid: string | undefined, toolResults: Array<{ toolUseId: string }> | undefined): void {
    if (!messageUuid || !toolResults?.length) return;
    let added = false;
    for (const { toolUseId } of toolResults ?? []) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId) || !fs.existsSync(path.join(this.dir, toolUseId))) continue;
      if (this.queue.hasPending((op) => op.params.toolUseId === toolUseId)) continue;
      this.queue.add("shellChanges", { conversationId, messageUuid, toolUseId, offset: 0 });
      added = true;
    }
    if (added) this.queue.persistNow({ sync: true });
  }

  stop(): void { this.queue.stop(); }
  waitForCompletion(timeoutMs: number): Promise<boolean> { return this.queue.waitForCompletion(timeoutMs); }
}
