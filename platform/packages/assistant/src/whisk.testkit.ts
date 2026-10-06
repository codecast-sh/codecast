// A fake Whisk for the assistant's tool tests: answers Whisk Convex functions
// by path (a dispatch by its action name) and records every call, so a test
// sees exactly what the tools asked Whisk for. No bun:test import, so the
// module is safe wherever the convex bundle reaches it.
import type { WhiskCall } from "./whisk";

export type WhiskTestCall = { kind: string; path: string; args: any };

export function fakeWhisk(routes: Record<string, (args: any) => unknown>) {
  const calls: WhiskTestCall[] = [];
  const call: WhiskCall = async (kind, path, args) => {
    calls.push({ kind, path, args });
    const dispatch = path === "dispatch:dispatch" ? (args as { action: string; args: unknown[] }) : null;
    const key = dispatch ? `dispatch:${dispatch.action}` : path;
    const route = routes[key];
    if (!route) throw new Error(`no route ${key}`);
    return route(dispatch ? dispatch.args[0] : args) as any;
  };
  return { call, calls };
}
