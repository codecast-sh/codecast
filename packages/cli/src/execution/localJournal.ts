import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutionTargetSpec,
  ReadyBinding,
  RuntimeCapability,
  RuntimeConfiguration,
  StructuredFailure,
} from "@codecast/shared/contracts";
import {
  agentSupportsExecutionTransport,
  parseExecutionAgentClientId,
} from "@codecast/shared/contracts";
import type { RuntimeHandle } from "./types.js";
import { ExecutionCoordinatorError } from "./types.js";

export const EXECUTION_JOURNAL_SCHEMA_VERSION = 1 as const;

export type ExecutionJournalPhase =
  | "claimed"
  | "effect-requested"
  | "handle-recorded"
  | "ready"
  | "start-failed-before-effect"
  | "start-ambiguous"
  | "quarantined"
  | "stopped";

export interface ExecutionJournalRecord {
  schemaVersion: typeof EXECUTION_JOURNAL_SCHEMA_VERSION;
  target: ExecutionTargetSpec;
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  protocolVersion: number;
  operationId: string;
  phase: ExecutionJournalPhase;
  handle?: RuntimeHandle;
  binding?: ReadyBinding;
  failure?: StructuredFailure;
  updatedAt: number;
}

export interface ExecutionOperationJournal {
  get(conversationId: string, epoch: number): ExecutionJournalRecord | undefined;
  list(): readonly ExecutionJournalRecord[];
  /** Synchronously durable before this method returns. */
  record(entry: ExecutionJournalRecord, authorization?: ExecutionJournalWriteAuthorization): void;
}

export interface ExecutionJournalWriteAuthorization {
  bootTransfer: {
    fromDaemonBootId: string;
    toDaemonBootId: string;
    previousBootTerminated: true;
  };
}

export class ExecutionJournalCorruptError extends Error {
  constructor(readonly filePath: string, message: string) {
    super(`Execution journal is corrupt at ${filePath}: ${message}`);
    this.name = "ExecutionJournalCorruptError";
  }
}

function journalKey(conversationId: string, epoch: number): string {
  return `${conversationId}\u0000${epoch}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const ALLOWED_TRANSITIONS: Record<ExecutionJournalPhase, ReadonlySet<ExecutionJournalPhase>> = {
  claimed: new Set(["claimed", "effect-requested", "handle-recorded", "start-failed-before-effect", "start-ambiguous"]),
  "effect-requested": new Set(["effect-requested", "handle-recorded", "start-failed-before-effect", "start-ambiguous"]),
  "handle-recorded": new Set(["effect-requested", "handle-recorded", "ready", "start-ambiguous", "quarantined"]),
  ready: new Set(["ready", "quarantined", "stopped"]),
  "start-failed-before-effect": new Set(["effect-requested", "start-failed-before-effect"]),
  "start-ambiguous": new Set(["effect-requested", "start-ambiguous", "handle-recorded", "quarantined", "stopped"]),
  quarantined: new Set(["quarantined", "stopped"]),
  stopped: new Set(["stopped"]),
};

function stableRequestIdentity(record: ExecutionJournalRecord): string {
  return JSON.stringify({
    target: record.target,
    configuration: record.configuration,
    ownerDeviceId: record.ownerDeviceId,
    daemonBootId: record.daemonBootId,
    requiredCapabilities: [...record.requiredCapabilities].sort(),
    protocolVersion: record.protocolVersion,
  });
}

function stableRequestIdentityWithoutBoot(record: ExecutionJournalRecord): string {
  return JSON.stringify({
    target: record.target,
    configuration: record.configuration,
    ownerDeviceId: record.ownerDeviceId,
    requiredCapabilities: [...record.requiredCapabilities].sort(),
    protocolVersion: record.protocolVersion,
  });
}

function assertRecordShape(entry: ExecutionJournalRecord): void {
  if (entry.schemaVersion !== EXECUTION_JOURNAL_SCHEMA_VERSION) {
    throw new TypeError(`unsupported schema version ${String(entry.schemaVersion)}`);
  }
  if (!entry.target || typeof entry.target.conversationId !== "string" || entry.target.conversationId.length === 0) {
    throw new TypeError("missing target conversationId");
  }
  if (!Number.isSafeInteger(entry.target.epoch) || entry.target.epoch < 1) {
    throw new TypeError("invalid target epoch");
  }
  if (parseExecutionAgentClientId(entry.target.requestedAgent) !== entry.target.requestedAgent) {
    throw new TypeError("target agent id is not canonical");
  }
  if (!["tmux", "app-server", "external"].includes(entry.target.transport)) {
    throw new TypeError("invalid target transport");
  }
  if (!agentSupportsExecutionTransport(entry.target.requestedAgent, entry.target.transport)) {
    throw new TypeError("target transport is not supported by its agent family");
  }
  if (!path.isAbsolute(entry.target.projectPath)) throw new TypeError("target project path is not absolute");
  if (!entry.configuration || !Number.isSafeInteger(entry.configuration.revision) || entry.configuration.revision < 1) {
    throw new TypeError("invalid configuration revision");
  }
  if (typeof entry.ownerDeviceId !== "string" || entry.ownerDeviceId.length === 0) {
    throw new TypeError("missing ownerDeviceId");
  }
  if (typeof entry.daemonBootId !== "string" || entry.daemonBootId.length === 0) {
    throw new TypeError("missing daemonBootId");
  }
  if (!Number.isSafeInteger(entry.protocolVersion) || entry.protocolVersion < 1) {
    throw new TypeError("invalid protocolVersion");
  }
  if (!Array.isArray(entry.requiredCapabilities)) throw new TypeError("invalid requiredCapabilities");
  if (typeof entry.operationId !== "string" || entry.operationId.length === 0) {
    throw new TypeError("missing operationId");
  }
  if (!(entry.phase in ALLOWED_TRANSITIONS)) {
    throw new TypeError(`invalid phase ${String(entry.phase)}`);
  }
  if (!Number.isFinite(entry.updatedAt)) throw new TypeError("invalid updatedAt");
  if (entry.phase === "handle-recorded" && !entry.handle) {
    throw new TypeError("handle-recorded entry has no runtime handle");
  }
  if (entry.phase === "ready" && (!entry.handle || !entry.binding)) {
    throw new TypeError("ready entry must contain both the runtime handle and ready binding");
  }
  if (
    (entry.phase === "start-failed-before-effect" || entry.phase === "start-ambiguous" || entry.phase === "quarantined") &&
    !entry.failure
  ) {
    throw new TypeError(`${entry.phase} entry has no failure`);
  }
}

function assertTransition(
  previous: ExecutionJournalRecord | undefined,
  next: ExecutionJournalRecord,
  authorization?: ExecutionJournalWriteAuthorization,
): void {
  assertRecordShape(next);
  if (!previous) {
    if (next.phase !== "claimed") {
      throw new ExecutionCoordinatorError(
        "JOURNAL_CONFLICT",
        `First journal phase must be claimed, received ${next.phase}`,
      );
    }
    return;
  }
  if (previous.operationId !== next.operationId) {
    throw new ExecutionCoordinatorError(
      "JOURNAL_CONFLICT",
      `Refusing to replace operation ${previous.operationId} with ${next.operationId} in the same execution epoch`,
    );
  }
  if (stableRequestIdentity(previous) !== stableRequestIdentity(next)) {
    const authorizedBootTransfer =
      stableRequestIdentityWithoutBoot(previous) === stableRequestIdentityWithoutBoot(next) &&
      authorization?.bootTransfer.fromDaemonBootId === previous.daemonBootId &&
      authorization.bootTransfer.toDaemonBootId === next.daemonBootId &&
      authorization.bootTransfer.previousBootTerminated === true;
    if (!authorizedBootTransfer) {
      throw new ExecutionCoordinatorError(
        "JOURNAL_CONFLICT",
        "Refusing to mutate an execution target or configuration inside one journaled epoch",
      );
    }
  }
  if (!ALLOWED_TRANSITIONS[previous.phase].has(next.phase)) {
    throw new ExecutionCoordinatorError(
      "JOURNAL_CONFLICT",
      `Invalid execution journal transition ${previous.phase} -> ${next.phase}`,
    );
  }
  if (
    previous.phase === "start-failed-before-effect" &&
    next.phase === "effect-requested" &&
    (previous.failure?.retryable !== true || next.handle || next.binding || next.failure)
  ) {
    throw new ExecutionCoordinatorError(
      "JOURNAL_CONFLICT",
      "Only an explicit retryable pre-effect failure may retry the same operation",
    );
  }
}

export class InMemoryExecutionOperationJournal implements ExecutionOperationJournal {
  private readonly records = new Map<string, ExecutionJournalRecord>();

  get(conversationId: string, epoch: number): ExecutionJournalRecord | undefined {
    const found = this.records.get(journalKey(conversationId, epoch));
    return found ? clone(found) : undefined;
  }

  list(): readonly ExecutionJournalRecord[] {
    return [...this.records.values()].map(clone);
  }

  record(entry: ExecutionJournalRecord, authorization?: ExecutionJournalWriteAuthorization): void {
    const key = journalKey(entry.target.conversationId, entry.target.epoch);
    assertTransition(this.records.get(key), entry, authorization);
    this.records.set(key, clone(entry));
  }
}

/**
 * One synchronously-fsynced file per `(conversation, epoch)` avoids whole-store
 * lost updates when an old and new daemon briefly overlap. Corruption fails
 * closed: silently forgetting a possibly-created runtime would permit a duplicate
 * start, so callers must surface/recover the journal instead.
 */
export class FileExecutionOperationJournal implements ExecutionOperationJournal {
  constructor(private readonly directory: string) {}

  private filePath(conversationId: string, epoch: number): string {
    const digest = createHash("sha256").update(conversationId).digest("hex");
    return path.join(this.directory, `${digest}.${epoch}.json`);
  }

  private readFile(filePath: string): ExecutionJournalRecord | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new ExecutionJournalCorruptError(
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      assertRecordShape(parsed as ExecutionJournalRecord);
      return parsed as ExecutionJournalRecord;
    } catch (error) {
      throw new ExecutionJournalCorruptError(
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  get(conversationId: string, epoch: number): ExecutionJournalRecord | undefined {
    const entry = this.readFile(this.filePath(conversationId, epoch));
    if (!entry) return undefined;
    if (entry.target.conversationId !== conversationId || entry.target.epoch !== epoch) {
      throw new ExecutionJournalCorruptError(
        this.filePath(conversationId, epoch),
        "record identity does not match its file name",
      );
    }
    return clone(entry);
  }

  list(): readonly ExecutionJournalRecord[] {
    if (!fs.existsSync(this.directory)) return [];
    const entries: ExecutionJournalRecord[] = [];
    for (const name of fs.readdirSync(this.directory).sort()) {
      if (!name.endsWith(".json")) continue;
      const entry = this.readFile(path.join(this.directory, name));
      if (entry) entries.push(clone(entry));
    }
    return entries;
  }

  record(entry: ExecutionJournalRecord, authorization?: ExecutionJournalWriteAuthorization): void {
    const filePath = this.filePath(entry.target.conversationId, entry.target.epoch);
    const previous = this.readFile(filePath);
    assertTransition(previous, entry, authorization);

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      this.directory,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, filePath);

      // Persist the directory entry where supported. Some filesystems reject
      // fsync on a directory; the record itself has still been fsynced + renamed.
      try {
        const dirFd = fs.openSync(this.directory, "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Best effort only for the directory metadata.
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The successful rename consumes the temporary path.
      }
    }
  }
}
