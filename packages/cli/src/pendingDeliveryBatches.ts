import { mapLimit } from "@codecast/shared/async";

export function createPendingDeliveryBatches<T extends { conversation_id: string; human?: boolean }>(deliver: (messages: T[]) => Promise<void>, isHuman: (message: T) => boolean = message => message.human === true) {
  const active = new Set<string>();
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (messages: T[]) => {
    if (!Array.isArray(messages)) return;
    const grouped = new Map<string, T[]>();
    for (const message of messages) {
      const group = grouped.get(message.conversation_id) ?? [];
      group.push(message);
      grouped.set(message.conversation_id, group);
    }
    const groups = [...grouped.entries()].filter(([id]) => !active.has(id));
    groups.sort((a, b) => Number(b[1].some(isHuman)) - Number(a[1].some(isHuman)));
    for (const [id] of groups) active.add(id);
    const results = await mapLimit(groups, 8, async ([id, rows]) => {
      if (running >= 8) await new Promise<void>(resolve => waiting.push(resolve));
      else running++;
      try {
        return await Promise.resolve().then(() => deliver(rows)).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      } finally {
        active.delete(id);
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    });
    const errors = results.flatMap(result => result.ok ? [] : [result.error]);
    if (errors.length) throw new AggregateError(errors, "Pending delivery batches failed");
  };
}
