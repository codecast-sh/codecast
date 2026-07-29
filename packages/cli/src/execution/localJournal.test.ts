import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FENCED_RUNTIME_CAPABILITIES, type ReadyBinding } from "@codecast/shared/contracts";
import {
  EXECUTION_JOURNAL_SCHEMA_VERSION,
  ExecutionJournalCorruptError,
  FileExecutionOperationJournal,
  type ExecutionJournalRecord,
} from "./localJournal.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-journal-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function claimed(): ExecutionJournalRecord {
  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    target: {
      conversationId: "conversation-1",
      epoch: 2,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: "/tmp/project",
    },
    configuration: { revision: 3 },
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    operationId: "operation-1",
    phase: "claimed",
    updatedAt: 1,
  };
}

const runtimeHandle = {
  runtimeId: "thread-1",
  handle: "thread-1",
  actualAgent: "codex" as const,
  transport: "app-server" as const,
  capabilities: [...FENCED_RUNTIME_CAPABILITIES],
};

function binding(): ReadyBinding {
  return {
    conversationId: "conversation-1",
    epoch: 2,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    handle: "thread-1",
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    runtimeId: "thread-1",
    operationId: "operation-1",
    appliedConfigurationRevision: 3,
    protocolVersion: 1,
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
  };
}

describe("FileExecutionOperationJournal", () => {
  test("synchronously persists the handle before a ready binding", () => {
    const journal = new FileExecutionOperationJournal(directory);
    const initial = claimed();
    journal.record(initial);
    journal.record({ ...initial, phase: "effect-requested", updatedAt: 2 });
    journal.record({ ...initial, phase: "handle-recorded", handle: runtimeHandle, updatedAt: 3 });

    const reloaded = new FileExecutionOperationJournal(directory);
    expect(reloaded.get("conversation-1", 2)).toMatchObject({
      phase: "handle-recorded",
      handle: { runtimeId: "thread-1" },
    });

    reloaded.record({
      ...initial,
      phase: "ready",
      handle: runtimeHandle,
      binding: binding(),
      updatedAt: 4,
    });
    expect(new FileExecutionOperationJournal(directory).get("conversation-1", 2)?.phase).toBe("ready");
  });

  test("fails closed on corruption instead of forgetting a possibly-created runtime", () => {
    const journal = new FileExecutionOperationJournal(directory);
    journal.record(claimed());
    const [file] = fs.readdirSync(directory);
    fs.writeFileSync(path.join(directory, file), "{not-json");
    expect(() => journal.get("conversation-1", 2)).toThrow(ExecutionJournalCorruptError);
  });

  test("rejects a ready record missing either the handle or binding", () => {
    const journal = new FileExecutionOperationJournal(directory);
    const initial = claimed();
    journal.record(initial);
    journal.record({ ...initial, phase: "effect-requested", updatedAt: 2 });
    journal.record({ ...initial, phase: "handle-recorded", handle: runtimeHandle, updatedAt: 3 });

    expect(() => journal.record({
      ...initial,
      phase: "ready",
      handle: runtimeHandle,
      updatedAt: 4,
    })).toThrow(/both the runtime handle and ready binding/);
    expect(() => journal.record({
      ...initial,
      phase: "ready",
      binding: binding(),
      updatedAt: 4,
    })).toThrow(/both the runtime handle and ready binding/);
  });

  test("cannot replace an operation id or mutate target configuration within one epoch", () => {
    const journal = new FileExecutionOperationJournal(directory);
    const initial = claimed();
    journal.record(initial);
    expect(() => journal.record({ ...initial, operationId: "operation-2" })).toThrow(/Refusing to replace operation/);
    expect(() => journal.record({
      ...initial,
      configuration: { revision: 4 },
    })).toThrow(/mutate an execution target or configuration/);
  });

  test("only retries an explicitly retryable pre-effect failure with the same operation", () => {
    const journal = new FileExecutionOperationJournal(directory);
    const initial = claimed();
    journal.record(initial);
    journal.record({ ...initial, phase: "effect-requested", updatedAt: 2 });
    const retryableFailure: ExecutionJournalRecord = {
      ...initial,
      phase: "start-failed-before-effect",
      failure: { code: "TEMPORARY_SETUP_FAILURE", message: "retry", retryable: true },
      updatedAt: 3,
    };
    journal.record(retryableFailure);
    journal.record({
      ...retryableFailure,
      phase: "effect-requested",
      failure: undefined,
      updatedAt: 4,
    });
    expect(journal.get("conversation-1", 2)?.phase).toBe("effect-requested");

    const otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-journal-nonretry-"));
    try {
      const nonretryable = new FileExecutionOperationJournal(otherDirectory);
      nonretryable.record(initial);
      nonretryable.record({ ...initial, phase: "effect-requested", updatedAt: 2 });
      const failed: ExecutionJournalRecord = {
        ...initial,
        phase: "start-failed-before-effect",
        failure: { code: "INVALID_SETUP", message: "do not retry", retryable: false },
        updatedAt: 3,
      };
      nonretryable.record(failed);
      expect(() => nonretryable.record({
        ...failed,
        phase: "effect-requested",
        failure: undefined,
        updatedAt: 4,
      })).toThrow(/explicit retryable pre-effect failure/);
    } finally {
      fs.rmSync(otherDirectory, { recursive: true, force: true });
    }
  });

  test("rejects zero fences and transports unsupported by the agent registry", () => {
    const journal = new FileExecutionOperationJournal(directory);
    expect(() => journal.record({
      ...claimed(),
      target: { ...claimed().target, epoch: 0 },
    })).toThrow(/invalid target epoch/);
    expect(() => journal.record({
      ...claimed(),
      configuration: { revision: 0 },
    })).toThrow(/invalid configuration revision/);
    expect(() => journal.record({
      ...claimed(),
      target: {
        ...claimed().target,
        requestedAgent: "claude",
        transport: "app-server",
      },
    })).toThrow(/not supported by its agent family/);
  });
});
