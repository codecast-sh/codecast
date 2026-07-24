import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  advanceLocalViewRevision,
  type CommandIdCoverage,
  type CommandIdCoverageTarget,
  type CommandReceiptCoverage,
  type ViewCoverage,
  type ViewCoverageTarget,
} from "./localViewRevisions";

export {
  advanceLocalViewRevision,
  readLocalViewRevision,
  type CommandIdCoverage,
  type CommandIdCoverageTarget,
  type CommandReceiptCoverage,
  type ViewCoverage,
  type ViewCoverageTarget,
} from "./localViewRevisions";

export const LOCAL_COMMAND_RECEIPT_VERSION = 1;

function isCommandIdCoverage(
  coverage: CommandReceiptCoverage,
): coverage is CommandIdCoverage {
  return "kind" in coverage && coverage.kind === "command-id";
}

export type PublicCommandReceipt = {
  receiptVersion: number;
  commandId: string;
  commandName: string;
  status: "acknowledged" | "rejected";
  result?: unknown;
  rejection?: { code: string; message: string; correction?: unknown };
  coverage: CommandReceiptCoverage[];
  retryUntil: null;
};

export type LocalCommandOutcome =
  | {
      status: "acknowledged";
      result?: unknown;
      /** Complete-view contracts whose authoritative result includes the write. */
      coverageViews: readonly ViewCoverageTarget[];
      /** Views that prove reconciliation by echoing this exact command id. */
      coverageCommandIds?: readonly CommandIdCoverageTarget[];
    }
  | {
      status: "rejected";
      code: string;
      message: string;
      correction?: unknown;
    };

/**
 * Canonicalize validated Convex arguments without relying on object insertion
 * order. The canonical value is hashed before persistence so indefinitely
 * retained dedupe receipts do not become a second copy of user content.
 */
export function canonicalCommandArguments(value: unknown): string {
  const seen = new Set<object>();

  const encode = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new ConvexError({ code: "INVALID_COMMAND_ARGUMENTS", message: "Command arguments must be finite" });
      }
      return Object.is(input, -0) ? "0" : String(input);
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) {
        throw new ConvexError({ code: "INVALID_COMMAND_ARGUMENTS", message: "Command arguments must not be cyclic" });
      }
      seen.add(input);
      const encoded = `[${input.map(encode).join(",")}]`;
      seen.delete(input);
      return encoded;
    }
    if (typeof input === "object") {
      const object = input as Record<string, unknown>;
      if (seen.has(object)) {
        throw new ConvexError({ code: "INVALID_COMMAND_ARGUMENTS", message: "Command arguments must not be cyclic" });
      }
      seen.add(object);
      const entries = Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`);
      seen.delete(object);
      return `{${entries.join(",")}}`;
    }
    throw new ConvexError({
      code: "INVALID_COMMAND_ARGUMENTS",
      message: `Unsupported command argument type: ${typeof input}`,
    });
  };

  return encode(value);
}

/** Cryptographically bind a command id to intent without retaining its payload. */
export async function commandArgumentsFingerprint(value: unknown): Promise<string> {
  const canonical = canonicalCommandArguments(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function toPublicReceipt(receipt: any): PublicCommandReceipt {
  return {
    receiptVersion: receipt.receipt_version,
    commandId: receipt.command_id,
    commandName: receipt.command_name,
    status: receipt.status,
    ...(receipt.status === "acknowledged" && receipt.result !== undefined
      ? { result: receipt.result }
      : {}),
    ...(receipt.status === "rejected"
      ? {
          rejection: {
            code: receipt.rejection_code,
            message: receipt.rejection_message,
            ...(receipt.correction !== undefined ? { correction: receipt.correction } : {}),
          },
        }
      : {}),
    coverage: receipt.coverage.map((item: any) => item.kind === "command-id"
      ? {
          kind: "command-id" as const,
          contractId: item.contract_id,
          viewKey: item.view_key,
          commandId: item.command_id,
        }
      : {
          contractId: item.contract_id,
          viewKey: item.view_key,
          revision: item.revision,
        }),
    // Initial protocol retains dedupe receipts indefinitely.
    retryUntil: null,
  };
}

export function validateCommandId(value: string): string {
  if (!value || value !== value.trim()) {
    throw new ConvexError({
      code: "INVALID_COMMAND_ID",
      message: "commandId must be a non-empty canonical string",
    });
  }
  if (value.length > 160) {
    throw new ConvexError({ code: "INVALID_COMMAND_ID", message: "commandId is too long" });
  }
  return value;
}

/** Resolve an ambiguous client transport attempt without reissuing new intent. */
export const getReceipt = query({
  args: { command_id: v.string() },
  handler: async (ctx, args) => {
    const principalId = await requireUser(ctx);
    const commandId = validateCommandId(args.command_id);
    const receipt = await ctx.db
      .query("local_command_receipts")
      .withIndex("by_principal_command", (q) =>
        q.eq("principal_id", principalId).eq("command_id", commandId))
      .unique();
    return receipt ? toPublicReceipt(receipt) : null;
  },
});

/**
 * Execute and receipt one validated command in a single Convex transaction.
 * Known domain refusals are returned by `execute` as `rejected`; unexpected
 * exceptions abort the transaction and intentionally do not manufacture a
 * terminal receipt.
 */
export async function runLocalCommand<Result>(
  ctx: Pick<MutationCtx, "db">,
  input: {
    principalId: Id<"users">;
    commandId: string;
    commandName: string;
    arguments: unknown;
  },
  execute: () => Promise<LocalCommandOutcome & { result?: Result }>,
): Promise<PublicCommandReceipt> {
  const commandId = validateCommandId(input.commandId);
  const argumentFingerprint = await commandArgumentsFingerprint(input.arguments);
  const existing = await ctx.db
    .query("local_command_receipts")
    .withIndex("by_principal_command", (q: any) =>
      q.eq("principal_id", input.principalId).eq("command_id", commandId))
    .unique();

  if (existing) {
    if (
      existing.command_name !== input.commandName ||
      existing.argument_fingerprint !== argumentFingerprint
    ) {
      throw new ConvexError({
        code: "COMMAND_ID_REUSED",
        message: "This command id is already bound to different intent",
      });
    }
    return toPublicReceipt(existing);
  }

  const outcome = await execute();
  let coverage: CommandReceiptCoverage[] = [];
  if (outcome.status === "acknowledged") {
    const views = [...new Map(
      outcome.coverageViews.map((target) => [
        `${target.revisionPrincipalId ?? input.principalId}\0${target.contractId}\0${target.viewKey}`,
        target,
      ]),
    ).values()].sort((a, b) =>
      a.contractId.localeCompare(b.contractId) || a.viewKey.localeCompare(b.viewKey));
    for (const target of views) {
      coverage.push(await advanceLocalViewRevision(
        ctx,
        target.revisionPrincipalId ?? input.principalId,
        target.contractId,
        target.viewKey,
      ));
    }
    const commandIdTargets = [...new Map(
      (outcome.coverageCommandIds ?? []).map((target) => [
        `${target.contractId}\0${target.viewKey}`,
        target,
      ]),
    ).values()].sort((a, b) =>
      a.contractId.localeCompare(b.contractId) || a.viewKey.localeCompare(b.viewKey));
    for (const target of commandIdTargets) {
      coverage.push({
        kind: "command-id",
        contractId: target.contractId,
        viewKey: target.viewKey,
        commandId,
      });
    }
  }

  const stored = {
    principal_id: input.principalId,
    command_id: commandId,
    command_name: input.commandName,
    receipt_version: LOCAL_COMMAND_RECEIPT_VERSION,
    argument_fingerprint: argumentFingerprint,
    status: outcome.status,
    ...(outcome.status === "acknowledged" && outcome.result !== undefined
      ? { result: outcome.result }
      : {}),
    ...(outcome.status === "rejected"
      ? {
          rejection_code: outcome.code,
          rejection_message: outcome.message,
          ...(outcome.correction !== undefined ? { correction: outcome.correction } : {}),
        }
      : {}),
    coverage: coverage.map((item) => isCommandIdCoverage(item)
      ? {
          kind: "command-id" as const,
          contract_id: item.contractId,
          view_key: item.viewKey,
          command_id: item.commandId,
        }
      : {
          contract_id: item.contractId,
          view_key: item.viewKey,
          revision: item.revision,
        }),
    created_at: Date.now(),
  };
  await ctx.db.insert("local_command_receipts", stored);
  return toPublicReceipt(stored);
}
