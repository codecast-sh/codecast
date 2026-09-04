import type { PaletteTargetType } from "./paletteActions";

export function resolvePaletteTarget(state: any, pathname: string | null): { targets: any[]; targetType: PaletteTargetType } | null {
  const match = pathname?.match(/^\/(conversation|tasks|docs|plans|projects|triggers)\/([^/?#]+)/);
  if (!match) return null;
  const [, route, id] = match;
  const type = { conversation: "session", tasks: "task", docs: "doc", plans: "plan", projects: "project", triggers: "trigger" }[route] as PaletteTargetType;
  const collection = { session: state.sessions, task: state.tasks, doc: state.docs, plan: state.plans, project: state.projects, trigger: state.agentTasks }[type] ?? {};
  const row = collection[id] ?? Object.values(collection).find((row: any) => row._id === id || row.short_id === id);
  const detail = type === "session" ? state.conversations?.[id] : type === "doc" ? state.docDetails?.[id] : undefined;
  if (!row && !detail) return null;
  return { targets: [{ ...detail, ...row }], targetType: type };
}
