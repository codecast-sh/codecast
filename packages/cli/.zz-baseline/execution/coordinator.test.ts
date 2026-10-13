import { describe, expect, test } from "bun:test";
import {
  FENCED_RUNTIME_CAPABILITIES,
  parseStartedDeliveryPermit,
  type AgentClientId,
  type ReadyBinding,
  type RuntimeTransport,
} from "@codecast/shared/contracts";
import {
  DormantExecutionControlPlane,
  type ClaimStartRequest,
  type ExecutionControlPlane,
  type StartClaimResult,
} from "./controlPlane.js";
import { ExecutionCoordinator } from "./coordinator.js";
import type { RuntimeDriver } from "./driver.js";
import { RuntimeDriverRegistry } from "./driver.js";
import {
  EXECUTION_JOURNAL_SCHEMA_VERSION,
  InMemoryExecutionOperationJournal,
  type ExecutionJournalRecord,
} from "./localJournal.js";
import type {
  DriverDeliveryResult,
  EnsureBindingRequest,
  RuntimeAdoptionResult,
  RuntimeDeliveryRequest,
  RuntimeHandle,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "./types.js";
import { ExecutionCoordinatorError } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class FakeControlPlane implements ExecutionControlPlane {
  claimCalls: ClaimStartRequest[] = [];
  readyPublications: ReadyBinding[] = [];
  ambiguousStarts: unknown[] = [];
  deliveredAttempts: string[] = [];
  failedAttempts: string[] = [];
  ambiguousAttempts: string[] = [];
  acceptReady = true;
  claimResult?: StartClaimResult;

  async claimStart(request: ClaimStartRequest): Promise<StartClaimResult> {
    this.claimCalls.push(request);
    return this.claimResult ?? {
      state: "claimed",
      operationId: request.proposedOperationId,
      recovery: { state: "fresh" },
    };
  }

  async publishReady(binding: ReadyBinding): Promise<{ accepted: boolean }> {
    this.readyPublications.push(binding);
    return { accepted: this.acceptReady };
  }

  async publishStartFailedBeforeEffect(): Promise<void> {}

  async publishStartAmbiguous(input: unknown): Promise<void> {
    this.ambiguousStarts.push(input);
  }

  async completeDelivery(input: Parameters<ExecutionControlPlane["completeDelivery"]>[0]): Promise<void> {
    this.deliveredAttempts.push(input.permit.attemptId);
  }

  async failDeliveryBeforeEffect(
    input: Parameters<ExecutionControlPlane["failDeliveryBeforeEffect"]>[0],
  ): Promise<void> {
    this.failedAttempts.push(input.permit.attemptId);
  }

  async markDeliveryAmbiguous(
    input: Parameters<ExecutionControlPlane["markDeliveryAmbiguous"]>[0],
  ): Promise<void> {
    this.ambiguousAttempts.push(input.permit.attemptId);
  }
}

class FakeDriver implements RuntimeDriver {
  readonly id: string;
  readonly supportedAgents: ReadonlySet<AgentClientId>;
  readonly capabilities = [...FENCED_RUNTIME_CAPABILITIES];
  startCalls = 0;
  startOperationIds: string[] = [];
  adoptCalls = 0;
  deliverCalls = 0;
  quarantineCalls: Array<{ binding: ReadyBinding; reason: string }> = [];
  stopCalls = 0;
  startImpl: (_request: RuntimeStartRequest) => Promise<RuntimeStartResult>;
  adoptImpl: () => Promise<RuntimeAdoptionResult> = async () => ({ state: "missing" });
  deliverImpl: (_request: RuntimeDeliveryRequest) => Promise<DriverDeliveryResult> = async () => ({ state: "delivered" });

  constructor(
    readonly transport: RuntimeTransport,
    agents: readonly AgentClientId[],
    startImpl?: (_request: RuntimeStartRequest) => Promise<RuntimeStartResult>,
  ) {
    this.id = `fake-${agents.join("-")}-${transport}`;
    this.supportedAgents = new Set(agents);
    this.startImpl = startImpl ?? (async () => ({
      state: "started",
      handle: this.handle(agents[0]),
    }));
  }

  handle(agent = [...this.supportedAgents][0]): RuntimeHandle {
    return {
      runtimeId: `runtime-${agent}`,
      handle: `handle-${agent}`,
      actualAgent: agent,
      transport: this.transport,
      capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    };
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    this.startCalls++;
    this.startOperationIds.push(request.operationId);
    return this.startImpl(request);
  }

  async adopt(): Promise<RuntimeAdoptionResult> {
    this.adoptCalls++;
    return this.adoptImpl();
  }

  async deliver(request: RuntimeDeliveryRequest): Promise<DriverDeliveryResult> {
    this.deliverCalls++;
    return this.deliverImpl(request);
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  async quarantine(binding: ReadyBinding, reason: string): Promise<void> {
    this.quarantineCalls.push({ binding, reason });
  }
}

class PhaseFailingJournal extends InMemoryExecutionOperationJournal {
  constructor(private readonly failedPhase: ExecutionJournalRecord["phase"]) {
    super();
  }

  override record(entry: ExecutionJournalRecord): void {
    if (entry.phase === this.failedPhase) throw new Error(`disk full at ${entry.phase}`);
    super.record(entry);
  }
}

function bindingRequest(
  trigger: EnsureBindingRequest["trigger"],
  overrides: Partial<EnsureBindingRequest["target"]> = {},
): EnsureBindingRequest {
  return {
    target: {
      conversationId: "conversation-1",
      epoch: 1,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: "/tmp/codecast-project",
      ...overrides,
    },
    configuration: { revision: 1, model: "gpt-5" },
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger,
  };
}

function coordinator(controlPlane: FakeControlPlane, drivers: RuntimeDriver[]) {
  return new ExecutionCoordinator({
    controlPlane,
    drivers: new RuntimeDriverRegistry(drivers),
    journal: new InMemoryExecutionOperationJournal(),
    operationIdFactory: () => "operation-1",
    defaultDeliveryTimeoutMs: 20,
  });
}

describe("ExecutionCoordinator single-flight binding", () => {
  for (const order of ["start-first", "message-first", "simultaneous"] as const) {
    test(`${order} converges on one runtime`, async () => {
      const entered = deferred<void>();
      const release = deferred<RuntimeStartResult>();
      const driver = new FakeDriver("app-server", ["codex"], async () => {
        entered.resolve();
        return release.promise;
      });
      const controlPlane = new FakeControlPlane();
      const execution = coordinator(controlPlane, [driver]);
      const startRequest = bindingRequest("start-session");
      const deliveryRequest = bindingRequest("delivery");

      let startPromise: Promise<ReadyBinding>;
      let deliveryPromise: Promise<ReadyBinding>;
      if (order === "start-first") {
        startPromise = execution.ensureBinding(startRequest);
        await entered.promise;
        deliveryPromise = execution.ensureBinding(deliveryRequest);
      } else if (order === "message-first") {
        deliveryPromise = execution.ensureBinding(deliveryRequest);
        await entered.promise;
        startPromise = execution.ensureBinding(startRequest);
      } else {
        startPromise = execution.ensureBinding(startRequest);
        deliveryPromise = execution.ensureBinding(deliveryRequest);
        await entered.promise;
      }

      expect(startPromise).toBe(deliveryPromise);
      release.resolve({ state: "started", handle: driver.handle("codex") });
      const [fromStart, fromDelivery] = await Promise.all([startPromise, deliveryPromise]);
      expect(fromStart.runtimeId).toBe("runtime-codex");
      expect(fromDelivery).toEqual(fromStart);
      expect(driver.startCalls).toBe(1);
      expect(controlPlane.claimCalls).toHaveLength(1);
      expect(controlPlane.readyPublications).toHaveLength(1);
    });
  }

  test("a Codex start failure cannot fall back to the registered Claude tmux driver", async () => {
    const codex = new FakeDriver("app-server", ["codex"], async () => ({
      state: "ambiguous",
      failure: { code: "CODEX_TIMEOUT", message: "thread/start timed out" },
    }));
    const claude = new FakeDriver("tmux", ["claude"]);
    const execution = coordinator(new FakeControlPlane(), [codex, claude]);

    const request = bindingRequest("start-session");
    const first = execution.ensureBinding(request);
    await expect(first).rejects.toMatchObject({
      code: "START_AMBIGUOUS",
    });
    const second = execution.ensureBinding(request);
    expect(second).toBe(first);
    await expect(second).rejects.toMatchObject({ code: "START_AMBIGUOUS" });
    expect(codex.startCalls).toBe(1);
    expect(claude.startCalls).toBe(0);
    expect(claude.deliverCalls).toBe(0);
  });

  test("the dormant control plane refuses work before any driver effect", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    const execution = new ExecutionCoordinator({
      controlPlane: new DormantExecutionControlPlane(),
      drivers: [driver],
      journal: new InMemoryExecutionOperationJournal(),
    });

    await expect(execution.ensureBinding(bindingRequest("start-session"))).rejects.toMatchObject({
      code: "FENCED_CONTROL_PLANE_DORMANT",
    });
    expect(driver.startCalls).toBe(0);
    expect(driver.adoptCalls).toBe(0);
  });

  test("rejects zero fences and unsupported agent transports before authority or driver work", () => {
    const driver = new FakeDriver("app-server", ["codex", "claude"]);
    const controlPlane = new FakeControlPlane();
    const execution = coordinator(controlPlane, [driver]);

    expect(() => execution.ensureBinding(bindingRequest("start-session", { epoch: 0 }))).toThrow(
      ExecutionCoordinatorError,
    );
    const zeroRevision = bindingRequest("start-session");
    zeroRevision.configuration = { revision: 0 };
    expect(() => execution.ensureBinding(zeroRevision)).toThrow(ExecutionCoordinatorError);
    expect(() => execution.ensureBinding(bindingRequest("start-session", {
      requestedAgent: "claude",
      transport: "app-server",
    }))).toThrow(ExecutionCoordinatorError);

    expect(controlPlane.claimCalls).toHaveLength(0);
    expect(driver.startCalls).toBe(0);
  });

  test("retries a proven retryable pre-effect start in-process with the exact operation id", async () => {
    let attempt = 0;
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.startImpl = async () => {
      attempt += 1;
      return attempt === 1
        ? {
            state: "failed-before-effect" as const,
            failure: { code: "TEMPORARY_SETUP_FAILURE", message: "try again", retryable: true },
          }
        : { state: "started" as const, handle: driver.handle("codex") };
    };
    const controlPlane = new FakeControlPlane();
    const journal = new InMemoryExecutionOperationJournal();
    let nextOperation = 0;
    const execution = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => `operation-${++nextOperation}`,
    });
    const request = bindingRequest("start-session");

    await expect(execution.ensureBinding(request)).rejects.toMatchObject({
      code: "START_FAILED_BEFORE_EFFECT",
      failure: { retryable: true },
    });
    const ready = await execution.ensureBinding(request);

    expect(ready.operationId).toBe("operation-1");
    expect(controlPlane.claimCalls.map((call) => call.proposedOperationId)).toEqual([
      "operation-1",
      "operation-1",
    ]);
    expect(driver.startOperationIds).toEqual(["operation-1", "operation-1"]);
    expect(driver.adoptCalls).toBe(0);
    expect(journal.get("conversation-1", 1)?.phase).toBe("ready");
  });

  test("retries a durable retryable pre-effect failure after coordinator restart", async () => {
    let attempt = 0;
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.startImpl = async () => {
      attempt += 1;
      return attempt === 1
        ? {
            state: "failed-before-effect" as const,
            failure: { code: "TEMPORARY_SETUP_FAILURE", message: "try again", retryable: true },
          }
        : { state: "started" as const, handle: driver.handle("codex") };
    };
    const controlPlane = new FakeControlPlane();
    const journal = new InMemoryExecutionOperationJournal();
    const request = bindingRequest("start-session");
    const first = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => "operation-original",
    });
    await expect(first.ensureBinding(request)).rejects.toMatchObject({
      code: "START_FAILED_BEFORE_EFFECT",
    });

    const restarted = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => "operation-must-not-be-used",
    });
    const ready = await restarted.ensureBinding({ ...request, trigger: "recovery" });

    expect(ready.operationId).toBe("operation-original");
    expect(driver.startOperationIds).toEqual(["operation-original", "operation-original"]);
    expect(driver.adoptCalls).toBe(0);
  });

  test("keeps nonretryable pre-effect failures sticky", async () => {
    const driver = new FakeDriver("app-server", ["codex"], async () => ({
      state: "failed-before-effect",
      failure: { code: "INVALID_SETUP", message: "cannot retry", retryable: false },
    }));
    const controlPlane = new FakeControlPlane();
    const execution = coordinator(controlPlane, [driver]);
    const request = bindingRequest("start-session");

    const first = execution.ensureBinding(request);
    await expect(first).rejects.toMatchObject({ code: "START_FAILED_BEFORE_EFFECT" });
    const second = execution.ensureBinding(request);
    expect(second).toBe(first);
    await expect(second).rejects.toMatchObject({ code: "START_FAILED_BEFORE_EFFECT" });
    expect(controlPlane.claimCalls).toHaveLength(1);
    expect(driver.startCalls).toBe(1);
  });
});

describe("ExecutionCoordinator recovery proof", () => {
  test("unknown inspection stays ambiguous and never starts another runtime", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.adoptImpl = async () => ({
      state: "unknown",
      failure: { code: "INSPECTION_UNAVAILABLE", message: "cannot inspect" },
    });
    const controlPlane = new FakeControlPlane();
    controlPlane.claimResult = {
      state: "claimed",
      operationId: "operation-1",
      recovery: {
        state: "recovering",
        previousDaemonBootId: "boot-old",
        previousBootTerminated: true,
      },
    };
    const execution = coordinator(controlPlane, [driver]);

    await expect(execution.ensureBinding(bindingRequest("recovery"))).rejects.toMatchObject({
      code: "START_AMBIGUOUS",
    });
    expect(driver.adoptCalls).toBe(1);
    expect(driver.startCalls).toBe(0);
    expect(controlPlane.ambiguousStarts).toHaveLength(1);
  });

  test("only a positive missing proof permits recovery to start the same operation", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.adoptImpl = async () => ({ state: "missing" });
    const controlPlane = new FakeControlPlane();
    controlPlane.claimResult = {
      state: "claimed",
      operationId: "operation-1",
      recovery: {
        state: "recovering",
        previousDaemonBootId: "boot-old",
        previousBootTerminated: true,
      },
    };
    const execution = coordinator(controlPlane, [driver]);

    const ready = await execution.ensureBinding(bindingRequest("recovery"));
    expect(ready.runtimeId).toBe("runtime-codex");
    expect(driver.adoptCalls).toBe(1);
    expect(driver.startCalls).toBe(1);
  });

  test("a journal from another daemon boot cannot be adopted into the current boot", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    const controlPlane = new FakeControlPlane();
    controlPlane.claimResult = {
      state: "claimed",
      operationId: "operation-1",
      recovery: {
        state: "recovering",
        previousDaemonBootId: "boot-some-other",
        previousBootTerminated: true,
      },
    };
    const journal = new InMemoryExecutionOperationJournal();
    const request = bindingRequest("recovery");
    journal.record({
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      target: request.target,
      configuration: request.configuration,
      ownerDeviceId: request.ownerDeviceId,
      daemonBootId: "boot-old",
      requiredCapabilities: request.requiredCapabilities,
      protocolVersion: request.protocolVersion,
      operationId: "operation-1",
      phase: "claimed",
      updatedAt: 1,
    });
    const execution = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => "operation-1",
    });

    await expect(execution.ensureBinding(request)).rejects.toMatchObject({
      code: "START_AMBIGUOUS",
      failure: { code: "DAEMON_BOOT_RECOVERY_NOT_AUTHORIZED" },
    });
    expect(driver.adoptCalls).toBe(0);
    expect(driver.startCalls).toBe(0);
  });

  test("an exact prior-boot termination proof transfers recovery to the new boot", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.adoptImpl = async () => ({ state: "missing" });
    const controlPlane = new FakeControlPlane();
    controlPlane.claimResult = {
      state: "claimed",
      operationId: "operation-1",
      recovery: {
        state: "recovering",
        previousDaemonBootId: "boot-old",
        previousBootTerminated: true,
      },
    };
    const journal = new InMemoryExecutionOperationJournal();
    const request = bindingRequest("recovery");
    journal.record({
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      target: request.target,
      configuration: request.configuration,
      ownerDeviceId: request.ownerDeviceId,
      daemonBootId: "boot-old",
      requiredCapabilities: request.requiredCapabilities,
      protocolVersion: request.protocolVersion,
      operationId: "operation-1",
      phase: "claimed",
      updatedAt: 1,
    });
    const execution = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => "operation-1",
    });

    const ready = await execution.ensureBinding(request);
    expect(ready.daemonBootId).toBe("boot-1");
    expect(journal.get("conversation-1", 1)?.daemonBootId).toBe("boot-1");
    expect(driver.adoptCalls).toBe(1);
    expect(driver.startCalls).toBe(1);
  });
});

describe("ExecutionCoordinator delivery ambiguity", () => {
  test("timeout retains the global slot and a late success closes the same attempt", async () => {
    const firstDelivery = deferred<DriverDeliveryResult>();
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.deliverImpl = async () => firstDelivery.promise;
    const controlPlane = new FakeControlPlane();
    const execution = coordinator(controlPlane, [driver]);
    const request = bindingRequest("delivery");
    const permit = parseStartedDeliveryPermit({
      state: "delivery-started",
      messageId: "message-1",
      deliveryId: "delivery-1",
      conversationSequence: "1",
      attemptId: "attempt-1",
      conversationId: "conversation-1",
      executionEpoch: 1,
      configurationRevision: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "runtime-codex",
    });
    const delivery = {
      messageId: "message-1",
      deliveryId: "delivery-1",
      conversationSequence: "1",
      input: [{ type: "text" as const, text: "hello" }],
    };

    const timedOut = await execution.deliver({ binding: request, permit, delivery, timeoutMs: 5 });
    expect(timedOut.state).toBe("ambiguous");
    expect(execution.getActiveDelivery("conversation-1")?.state).toBe("ambiguous");
    expect(controlPlane.ambiguousAttempts).toEqual(["attempt-1"]);

    // Re-observing the same attempt returns its existing result without reinjection.
    expect((await execution.deliver({ binding: request, permit, delivery })).state).toBe("ambiguous");
    expect(driver.deliverCalls).toBe(1);

    const secondPermit = parseStartedDeliveryPermit({
      ...permit,
      messageId: "message-2",
      deliveryId: "delivery-2",
      conversationSequence: "2",
      attemptId: "attempt-2",
    });
    await expect(
      execution.deliver({
        binding: request,
        permit: secondPermit,
        delivery: {
          messageId: "message-2",
          deliveryId: "delivery-2",
          conversationSequence: "2",
          input: [{ type: "text", text: "second" }],
        },
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_SLOT_BUSY" });

    firstDelivery.resolve({ state: "delivered" });
    await waitFor(() => execution.getActiveDelivery("conversation-1") === undefined);
    expect(controlPlane.deliveredAttempts).toEqual(["attempt-1"]);

    // Even after the late success, repeating attempt-1 is a local idempotent read.
    expect((await execution.deliver({ binding: request, permit, delivery })).state).toBe("delivered");
    expect(driver.deliverCalls).toBe(1);
  });

  test("timeout becomes locally visible even when the ambiguity mutation hangs", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    driver.deliverImpl = async () => new Promise<DriverDeliveryResult>(() => {});
    const controlPlane = new FakeControlPlane();
    controlPlane.markDeliveryAmbiguous = async () => new Promise<void>(() => {});
    const execution = coordinator(controlPlane, [driver]);
    const permit = parseStartedDeliveryPermit({
      state: "delivery-started",
      messageId: "message-hung",
      deliveryId: "delivery-hung",
      conversationSequence: "1",
      attemptId: "attempt-hung",
      conversationId: "conversation-1",
      executionEpoch: 1,
      configurationRevision: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "runtime-codex",
    });

    const outcome = await Promise.race([
      execution.deliver({
        binding: bindingRequest("delivery"),
        permit,
        delivery: {
          messageId: "message-hung",
          deliveryId: "delivery-hung",
          conversationSequence: "1",
          input: [{ type: "text", text: "hello" }],
        },
        timeoutMs: 5,
      }),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 100)),
    ]);
    expect(outcome).not.toBe("test-timeout");
    expect(outcome).toMatchObject({ state: "ambiguous" });
    expect(execution.getActiveDelivery("conversation-1")?.state).toBe("ambiguous");
  });
});

describe("ExecutionCoordinator stale completion", () => {
  test("quarantines a runtime whose ready CAS loses", async () => {
    const release = deferred<RuntimeStartResult>();
    const driver = new FakeDriver("app-server", ["codex"], () => release.promise);
    const controlPlane = new FakeControlPlane();
    controlPlane.acceptReady = false;
    const journal = new InMemoryExecutionOperationJournal();
    const execution = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal,
      operationIdFactory: () => "operation-stale",
    });

    const promise = execution.ensureBinding(bindingRequest("start-session"));
    await waitFor(() => driver.startCalls === 1);
    release.resolve({ state: "started", handle: driver.handle("codex") });
    await expect(promise).rejects.toMatchObject({ code: "STALE_START_COMPLETION" });

    expect(driver.quarantineCalls).toHaveLength(1);
    expect(driver.quarantineCalls[0].binding.actualAgent).toBe("codex");
    expect(journal.get("conversation-1", 1)?.phase).toBe("quarantined");
    expect(controlPlane.ambiguousStarts).toHaveLength(1);
  });

  test("rejects a conflicting request for the same epoch before another start", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    const execution = coordinator(new FakeControlPlane(), [driver]);
    await execution.ensureBinding(bindingRequest("start-session"));

    const changed = bindingRequest("delivery");
    changed.configuration = { revision: 2 };
    await expect(execution.ensureBinding(changed)).rejects.toBeInstanceOf(ExecutionCoordinatorError);
    expect(driver.startCalls).toBe(1);
  });

  test("quarantines and reports ambiguity if the created handle cannot be journaled", async () => {
    const driver = new FakeDriver("app-server", ["codex"]);
    const controlPlane = new FakeControlPlane();
    const execution = new ExecutionCoordinator({
      controlPlane,
      drivers: [driver],
      journal: new PhaseFailingJournal("handle-recorded"),
      operationIdFactory: () => "operation-journal-failure",
    });

    await expect(execution.ensureBinding(bindingRequest("start-session"))).rejects.toMatchObject({
      code: "START_AMBIGUOUS",
      failure: { code: "LOCAL_RUNTIME_HANDLE_JOURNAL_FAILED" },
    });
    expect(driver.quarantineCalls).toHaveLength(1);
    expect(controlPlane.readyPublications).toHaveLength(0);
    expect(controlPlane.ambiguousStarts).toHaveLength(1);
  });
});
