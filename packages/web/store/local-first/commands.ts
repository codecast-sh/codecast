import type { PrincipalId } from "./types";
import {
  ALLOWED_COMMAND_TRANSITIONS,
  PrincipalStoreFenceError,
  type CommandReceiptRecord,
  type CommandRecord,
  type CommandStatus,
  type CommitResult,
  type OptimisticOperation,
  type PrincipalStoreAdapter,
  type PrincipalStoreFence,
  type StoreOperation,
} from "./persistence/adapter";

export class InvalidCommandTransitionError extends Error {
  constructor(from: CommandStatus, to: CommandStatus) {
    super(`Invalid command transition: ${from} -> ${to}`);
    this.name = "InvalidCommandTransitionError";
  }
}

export function transitionCommand(command: CommandRecord, status: CommandStatus): CommandRecord {
  if (!ALLOWED_COMMAND_TRANSITIONS[command.status].includes(status)) {
    throw new InvalidCommandTransitionError(command.status, status);
  }
  return {
    ...command,
    status,
    optimisticActive: status === "queued" ||
      status === "sending" ||
      status === "checking-receipt" ||
      status === "acknowledged-awaiting-coverage" ||
      status === "ambiguous",
  };
}

export function activeOptimisticOperations(
  commands: readonly CommandRecord[],
): OptimisticOperation[] {
  return [...commands]
    .filter((command) => command.optimisticActive)
    .sort((a, b) => a.localSequence - b.localSequence)
    .flatMap((command) => [...command.optimisticOperations]);
}

/** Commands sharing a conflict key are drained in creation order; keys may run concurrently. */
export function commandDrainGroups(
  commands: readonly CommandRecord[],
): Map<string, CommandRecord[]> {
  const groups = new Map<string, CommandRecord[]>();
  for (const command of [...commands].sort((a, b) =>
    a.localSequence - b.localSequence || a.id.localeCompare(b.id))) {
    const group = groups.get(command.conflictKey) ?? [];
    group.push(command);
    groups.set(command.conflictKey, group);
  }
  return groups;
}

export type QueueCommandInput = Omit<
  CommandRecord,
  "principalId" | "status" | "createdAt" | "localSequence" | "optimisticActive"
> & { createdAt?: number };

export type CommandTransport = {
  getReceipt(command: CommandRecord): Promise<CommandReceiptRecord | null>;
  send(command: CommandRecord): Promise<CommandReceiptRecord>;
};

export class LocalFirstCommandRuntime {
  constructor(
    private readonly adapter: PrincipalStoreAdapter,
    private readonly fence: PrincipalStoreFence,
    private readonly principalId: PrincipalId,
    private readonly onStorageFailure?: (error: unknown) => void,
    private readonly onRejected?: (
      command: CommandRecord,
      rejection: NonNullable<CommandReceiptRecord["rejection"]>,
    ) => void,
  ) {}

  private async commit(operations: readonly StoreOperation[]): Promise<CommitResult> {
    try {
      return await this.adapter.commit(this.fence, operations);
    } catch (error) {
      if (!(error instanceof PrincipalStoreFenceError)) this.onStorageFailure?.(error);
      throw error;
    }
  }

  async queue(
    input: QueueCommandInput,
    publish: (command: CommandRecord, commit: CommitResult) => void = () => {},
  ): Promise<CommandRecord> {
    if (!input.conflictKey.trim()) throw new Error("Durable commands require a conflict key");
    const record = {
      ...input,
      principalId: this.principalId,
      status: "queued" as const,
      createdAt: input.createdAt ?? Date.now(),
      optimisticActive: true,
    };
    const result = await this.commit([{ kind: "queue-command", record }]);
    const command: CommandRecord = { ...record, localSequence: result.head };
    publish(command, result);
    return command;
  }

  async transition(command: CommandRecord, status: CommandStatus): Promise<CommandRecord> {
    if (command.principalId !== this.principalId) {
      throw new Error("Command belongs to another principal");
    }
    const next = transitionCommand(command, status);
    await this.commit([{ kind: "put-command", record: next }]);
    return next;
  }

  async markSending(command: CommandRecord): Promise<CommandRecord> {
    return await this.transition(command, "sending");
  }

  /**
   * A transport timeout for a server-deduplicated command means “query the
   * receipt”, not “invent new intent”. Non-replayable effects become genuinely
   * ambiguous and require explicit recovery.
   */
  async markTransportUncertain(command: CommandRecord): Promise<CommandRecord> {
    return await this.transition(
      command,
      command.replayPolicy === "server-deduplicated" ? "checking-receipt" : "ambiguous",
    );
  }

  /** A null receipt permits replay of the exact same ID while inside its horizon. */
  async receiptAbsent(command: CommandRecord, now = Date.now()): Promise<CommandRecord> {
    if (command.status !== "checking-receipt") {
      throw new InvalidCommandTransitionError(command.status, "sending");
    }
    if (command.retryUntil !== undefined && command.retryUntil <= now) {
      return await this.transition(command, "replay-expired");
    }
    return await this.transition(command, "sending");
  }

  /**
   * Persist a server receipt and settle against the already-applied durable
   * view in one transaction. A view-revision receipt alone never retires the
   * overlay; the adapter does so only when that exact view has reached it.
   */
  async settleReceipt(
    command: CommandRecord,
    receipt: CommandReceiptRecord,
    authoritativeOperations: readonly StoreOperation[] = [],
    publish: (command: CommandRecord, commit: CommitResult) => void = () => {},
  ): Promise<CommandRecord> {
    if (receipt.commandId !== command.id || receipt.principalId !== this.principalId ||
      receipt.commandType !== command.commandType) {
      throw new Error("Receipt does not match command principal/id/type");
    }
    const result = await this.commit([
      ...authoritativeOperations,
      { kind: "settle-command-receipt", record: receipt },
    ]);
    const settled = await this.adapter.readCommand(this.fence, command.id);
    if (!settled) throw new Error("Settled command disappeared from its principal store");
    publish(settled, result);
    if (receipt.outcome === "rejected" && receipt.rejection) {
      // User-visible failure is published only after the rejection and overlay
      // retirement are durable.
      this.onRejected?.(settled, receipt.rejection);
    }
    return settled;
  }

  async pending(statuses: readonly CommandStatus[] = [
    "queued",
    "sending",
    "checking-receipt",
    "acknowledged-awaiting-coverage",
    "ambiguous",
  ]): Promise<CommandRecord[]> {
    return await this.adapter.readCommands(this.fence, statuses);
  }

  /**
   * Restart-safe drain. Each conflict key is sequential; independent keys are
   * concurrent. A record found in `sending` is treated as crash ambiguity and
   * queries its receipt before the same deduplicated ID may be replayed.
   */
  async drain(transport: CommandTransport): Promise<void> {
    const groups = commandDrainGroups(await this.pending());
    const drainGroup = async (initial: readonly CommandRecord[]) => {
      for (const initialCommand of initial) {
        let command = (await this.adapter.readCommand(this.fence, initialCommand.id)) ?? initialCommand;
        if (command.status === "acknowledged-awaiting-coverage") continue;
        if (command.status === "ambiguous") break;

        if (command.status === "sending") {
          command = await this.markTransportUncertain(command);
          if (command.status === "ambiguous") break;
        }

        if (command.status === "checking-receipt") {
          const receipt = await transport.getReceipt(command);
          if (receipt) {
            await this.settleReceipt(command, receipt);
            continue;
          }
          command = await this.receiptAbsent(command);
          if (command.status === "replay-expired") break;
        }

        if (command.status === "queued") command = await this.markSending(command);
        if (command.status !== "sending") continue;
        try {
          const receipt = await transport.send(command);
          await this.settleReceipt(command, receipt);
        } catch (error) {
          await this.markTransportUncertain(command);
          throw error;
        }
      }
    };
    const outcomes = await Promise.allSettled(
      [...groups.values()].map((commands) => drainGroup(commands)),
    );
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), "Command drain failed");
    }
  }

  async expireReplayHorizon(command: CommandRecord, now = Date.now()): Promise<CommandRecord> {
    if (command.retryUntil === undefined || command.retryUntil > now) return command;
    if (command.status !== "queued" && command.status !== "sending" &&
      command.status !== "checking-receipt") return command;
    return await this.transition(command, "replay-expired");
  }
}
