import { ACTIVE_AGENT_STATUSES, AGENT_IDLE_GRACE_MS } from "@codecast/shared/contracts";
import type { Message } from "../hooks/useConversationMessages";

export const INTERRUPT_CONFIRMATION_MS = 30_000;

const INTERRUPT_FIELDS = ["agent_status", "is_idle", "agent_status_updated_at", "awaiting_input"] as const;

export type SessionInterrupt = {
  requestId: string;
  at: number;
  afterTimestamp: number;
  message: Message;
  facts: Record<string, unknown>;
  active: boolean;
  echoed: boolean;
  confirmed: boolean;
};

type SessionRow = Record<string, any> & { _optimisticInterrupt?: SessionInterrupt };

function restoreFacts(row: SessionRow, interrupt: SessionInterrupt) {
  for (const field of INTERRUPT_FIELDS) row[field] = interrupt.facts[field];
}

export function applySessionInterrupt(row: SessionRow, now = Date.now()) {
  const interrupt = row._optimisticInterrupt;
  if (!interrupt) return;
  if (now - interrupt.at >= INTERRUPT_CONFIRMATION_MS) {
    if (interrupt.active) restoreFacts(row, interrupt);
    delete row._optimisticInterrupt;
    return;
  }
  if (!interrupt.active) return;
  Object.assign(row, {
    agent_status: "idle",
    is_idle: true,
    agent_status_updated_at: interrupt.at - AGENT_IDLE_GRACE_MS,
    awaiting_input: false,
  });
}

export function beginSessionInterrupt(row: SessionRow, messages: Message[], requestId: string, now = Date.now()): boolean {
  if (!ACTIVE_AGENT_STATUSES.has(row.agent_status)) return false;
  const afterTimestamp = messages.at(-1)?.timestamp ?? 0;
  row._optimisticInterrupt = {
    requestId,
    at: now,
    afterTimestamp,
    message: {
      _id: requestId,
      role: "user",
      content: row.agent_type === "codex" ? "<turn_aborted>" : "[Request interrupted by user]",
      timestamp: Math.max(now, afterTimestamp + 1),
    },
    facts: Object.fromEntries(INTERRUPT_FIELDS.map((field) => [field, row[field]])),
    active: true,
    echoed: false,
    confirmed: false,
  };
  applySessionInterrupt(row, now);
  return true;
}

export function reconcileInterruptFacts(row: SessionRow, now = Date.now()) {
  const interrupt = row._optimisticInterrupt;
  if (!interrupt?.active) return;
  for (const field of INTERRUPT_FIELDS) interrupt.facts[field] = row[field];
  if (row.agent_status && !ACTIVE_AGENT_STATUSES.has(row.agent_status)) {
    interrupt.active = false;
    interrupt.confirmed = true;
    if (interrupt.echoed) delete row._optimisticInterrupt;
  }
  applySessionInterrupt(row, now);
}

export function releaseSessionInterrupt(row: SessionRow, requestId?: string, remove = false) {
  const interrupt = row._optimisticInterrupt;
  if (!interrupt || (requestId && interrupt.requestId !== requestId)) return;
  if (interrupt.active) restoreFacts(row, interrupt);
  interrupt.active = false;
  if (remove || interrupt.echoed) delete row._optimisticInterrupt;
}

export function reconcileInterruptMessages(row: SessionRow | undefined, messages: Message[]) {
  const interrupt = row?._optimisticInterrupt;
  if (!row || !interrupt) return;
  const echo = messages.some((message) => message.role === "user" &&
    message.timestamp > interrupt.afterTimestamp &&
    /^(?:\[Request (?:interrupted|cancelled)|<turn_aborted>)/.test(message.content?.trimStart() ?? ""));
  if (!echo) return;
  interrupt.echoed = true;
  if (!interrupt.active) delete row._optimisticInterrupt;
}

export function sessionInterruptMessage(row: SessionRow | undefined): Message | undefined {
  const interrupt = row?._optimisticInterrupt;
  return interrupt && !interrupt.echoed ? interrupt.message : undefined;
}
