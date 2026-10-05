// Reads a mod's source the way a reviewer would, without running it: which
// events it hooks, which `$` methods it calls, which collections it reads and
// whether its manifest grants all of that. `cast mod inspect` prints it, `cast
// mod build` refuses a bundle whose calls the manifest does not grant, and the
// web shows it on the mods page.

import { MOD_METHODS, canRead, canWrite, type ModManifest } from "../contracts/mods";

export type ModInspection = {
  hooks: string[];
  calls: string[];
  reads: string[];
  /** Methods named in the source that the host does not answer. */
  unknown: string[];
  /** Grants the code needs and the manifest does not give. */
  missing: string[];
  /** Panes, fences and commands the manifest declares and no hook serves. */
  unserved: string[];
};

const WRITE_OF: Record<string, string> = {
  "tasks.create": "tasks", "tasks.update": "tasks",
  "sessions.send": "sessions",
  "docs.create": "docs",
  "objects.create": "objects", "objects.update": "objects", "objects.archive": "objects",
  "ui.copy": "clipboard",
};

const LOCAL = new Set(["http.fetch", "ui.invalidate"]);

function uniq(list: string[]): string[] {
  return [...new Set(list)].sort();
}

export function inspectModSource(files: Record<string, string>, manifest: ModManifest): ModInspection {
  const text = Object.entries(files)
    .filter(([p]) => /\.(t|j)sx?$/.test(p) && !p.endsWith(".d.ts"))
    .map(([, t]) => t)
    .join("\n");
  const hooks: string[] = [];
  const hookRe = /\bon\(\s*["'`]([a-z]+\.[a-z.]+)["'`]\s*(?:,\s*(\{[^}]*\}))?/g;
  for (const m of text.matchAll(hookRe)) {
    const matcher = m[2] ? m[2].replace(/\s+/g, "").replace(/["'`]/g, "") : "";
    hooks.push(matcher ? `${m[1]}${matcher}` : m[1]);
  }
  const calls: string[] = [];
  // `$` is the usual name; authors who rename it (`api`, `cc`) still pass it as the hook's first parameter.
  const apiNames = new Set(["$"]);
  for (const m of text.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?::[^,)]*)?,\s*[A-Za-z_$][\w$]*\s*(?::[^,)]*)?(?:,\s*[A-Za-z_$][\w$]*\s*)?\)\s*=>/g)) apiNames.add(m[1]);
  for (const name of apiNames) {
    const esc = name.replace(/\$/g, "\\$");
    // A generic between the name and the call ($.local.get<T>(...)) is part of the call.
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${esc}\\.([a-z]+)\\.([a-zA-Z]+)\\s*(?:<[^()]*>)?\\s*\\(`, "g"))) calls.push(`${m[1]}.${m[2]}`);
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${esc}\\.me\\s*\\(`, "g"))) if (m) calls.push("me");
  }
  const reads: string[] = [];
  for (const m of text.matchAll(/\.data\.(?:list|get|count)\(\s*["'`]([a-z]+)["'`]/g)) reads.push(m[1]);
  const known = new Set<string>(MOD_METHODS);
  const unknown = uniq(calls.filter((c) => !known.has(c) && !LOCAL.has(c)));
  const missing: string[] = [];
  for (const r of uniq(reads)) if (!canRead(manifest, r)) missing.push(`permissions.read "${r}"`);
  for (const c of uniq(calls)) {
    const w = WRITE_OF[c];
    if (w && !canWrite(manifest, w)) missing.push(`permissions.write "${w}" (for $.${c})`);
    if (c === "http.fetch" && !manifest.permissions?.fetch) missing.push(`permissions.fetch (for $.http.fetch)`);
  }
  const unserved: string[] = [];
  const served = (kind: string, id: string) =>
    hooks.some((h) => h === "ui.render" || h.includes(`${kind}:${id}`)) || (kind === "command" && hooks.some((h) => h === "command.run"));
  for (const p of manifest.panes ?? []) if (!served("pane", p.id)) unserved.push(`pane "${p.id}"`);
  for (const f of manifest.fences ?? []) if (!served("fence", f.lang)) unserved.push(`fence "${f.lang}"`);
  for (const s of manifest.sidebar ?? []) if (!served("sidebar", s.id)) unserved.push(`sidebar "${s.id}"`);
  for (const c of manifest.commands ?? []) if (!hooks.some((h) => h === "command.run" || h.includes(`command:${c.id}`))) unserved.push(`command "${c.id}"`);
  return { hooks: uniq(hooks), calls: uniq(calls), reads: uniq(reads), unknown, missing: uniq(missing), unserved };
}
