/**
 * A fake Mac for `cast computer setup` (ct-49790).
 *
 * The flow's whole job is what it does BEFORE it opens anything, so the fake
 * records every call in one ordered log: the reads, the confirm, and the raise.
 * A test then asserts on the order, which is the only way to state "the raise
 * sits behind the confirm" as a fact rather than as a comment.
 *
 * Grants are a script rather than a state machine: each read takes the next
 * entry, so a test says "not granted, not granted, granted" and gets a human
 * who took two turns of the poll to click the switch.
 *
 * This lives under test-helpers because the focus guard skips this directory.
 * Anywhere else, naming `openPermissionSettings` would read as a file that
 * raises windows.
 */

import type { ComputerPermissionApi, ComputerRunDeps } from "../computer/run.js";
import type { ComputerPermissionId, ComputerPermissionStatus, ComputerPermissionStatusResult } from "../computer/types.js";

export type GrantState = Record<ComputerPermissionId, ComputerPermissionStatus>;

export const HELPER_APP = "/Users/x/.codecast/computer/codecast computer.app";

export interface SetupHarness {
  /** Every call, in order: `read`, `confirm`, `open:<id>`, `wait`, `materialize`. */
  calls: string[];
  deps: NonNullable<ComputerRunDeps["setup"]>;
  permissions: () => Promise<ComputerPermissionApi>;
  /** Fires the Ctrl C the flow registered for, if it registered one. */
  cancel: () => void;
  lines: string[];
}

export interface HarnessOptions {
  /** One entry per read. The last one repeats once the script runs out. */
  grants: GrantState[];
  confirm?: boolean;
  isTty?: boolean;
  /** Called after each `wait`, so a test can cancel or grant mid poll. */
  onWait?: (n: number) => void;
  materialize?: () => Promise<string>;
  helperUnavailableReason?: string;
}

function statusOf(grants: GrantState, reason: string | null): ComputerPermissionStatusResult {
  return {
    platform: "darwin",
    helperAppPath: HELPER_APP,
    helperUnavailableReason: reason,
    permissions: [
      { id: "accessibility", status: grants.accessibility },
      { id: "screenshots", status: grants.screenshots },
    ],
  };
}

export function setupHarness(opts: HarnessOptions): SetupHarness {
  const calls: string[] = [];
  const lines: string[] = [];
  let reads = 0;
  let waits = 0;
  let cancelFn: (() => void) | null = null;
  const at = (i: number) => statusOf(opts.grants[Math.min(i, opts.grants.length - 1)]!, opts.helperUnavailableReason ?? null);
  const read = () => at(reads++);
  // Opening a pane must not consume a scripted read: the script describes what
  // the human has granted, and opening a window grants nothing.
  const peek = () => at(reads);

  const api = {
    getPermissionStatus: async () => peek(),
    readPermissionStatus: async () => {
      calls.push("read");
      const status = read();
      return { ...status, launchedHelper: false, nextStep: null };
    },
    openPermissionSettings: async (id?: ComputerPermissionId) => {
      calls.push(`open:${id ?? "both"}`);
      return { ...peek(), permissionId: id, launchedHelper: true, nextStep: null };
    },
    resetPermissions: async () => ({ ...peek(), bundleId: "sh.codecast.computer" }),
    formatPermissionsReport: (status: ComputerPermissionStatusResult) => [
      "Computer permissions checked.",
      `  Permissions: ${status.permissions.map((p) => `${p.id}=${p.status}`).join(", ")}`,
    ],
  } as unknown as ComputerPermissionApi;

  return {
    calls,
    lines,
    cancel: () => cancelFn?.(),
    permissions: async () => api,
    deps: {
      permissions: api,
      materialize:
        opts.materialize ??
        (async () => {
          calls.push("materialize");
          return HELPER_APP;
        }),
      confirm: async () => {
        calls.push("confirm");
        return opts.confirm ?? false;
      },
      isTty: () => opts.isTty ?? false,
      wait: async () => {
        calls.push("wait");
        opts.onWait?.(++waits);
      },
      onCancel: (fn: () => void) => {
        cancelFn = fn;
        return () => {
          cancelFn = null;
        };
      },
      log: (line: string) => lines.push(line),
      pollIntervalMs: 0,
    },
  };
}

export const GRANTED: GrantState = { accessibility: "granted", screenshots: "granted" };
export const NONE: GrantState = { accessibility: "not-granted", screenshots: "not-granted" };
