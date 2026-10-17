import { mapLimit } from "@codecast/shared/async";

export function createPendingDeliveryBatches<T extends { conversation_id: string; human?: boolean }>(deliver: (messages: T[]) => Promise<void>) {
  const active = new Set<string>();
  return async (messages: T[]) => {
    const grouped = new Map<string, T[]>();
    for (const message of messages) {
      const group = grouped.get(message.conversation_id) ?? [];
      group.push(message);
      grouped.set(message.conversation_id, group);
    }
    const groups = [...grouped.entries()].filter(([id]) => !active.has(id));
    groups.sort((a, b) => Number(b[1].some(m => m.human)) - Number(a[1].some(m => m.human)));
    for (const [id] of groups) active.add(id);
    await mapLimit(groups, 8, async ([id, rows]) => {
      try {
        await deliver(rows);
      } finally {
        active.delete(id);
      }
    });
  };
}
