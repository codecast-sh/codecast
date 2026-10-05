// `cast obj`: objects of the kinds mods declare (bug-14, inc-3), for agents.
// A kind is a mod's manifest entry (shared/contracts/mods.ts ModObjectKind);
// these verbs work every kind the same way, so a new kind needs no CLI code.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { OBJECT_SHORT_ID_RE, objectStatusIsDone, type ModObjectKind } from "@codecast/shared/contracts/mods";
import { webBaseUrl } from "./config/readLocalConfig.js";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function kinds(deps: PublishDeps): Promise<(ModObjectKind & { mod: string })[]> {
  const res = await apiPost(deps, "/cli/objects/kinds", {}, { read: true });
  return res.kinds ?? [];
}

async function kindOrFail(deps: PublishDeps, prefix: string) {
  const all = await kinds(deps);
  const kind = all.find((k) => k.prefix === prefix);
  if (!kind) fail(all.length ? `no kind "${prefix}"; yours: ${all.map((k) => k.prefix).join(", ")}` : `no kind "${prefix}": no mod you can see declares objects (a manifest's "objects" list)`);
  return kind;
}

/** `--set name=value` pairs, typed by the kind's fields. */
function parseSets(kind: ModObjectKind, sets: string[] | undefined): Record<string, unknown> | undefined {
  if (!sets?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const pair of sets) {
    const eq = pair.indexOf("=");
    if (eq < 1) fail(`--set takes name=value, got "${pair}"`);
    const name = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    const f = kind.fields?.[name];
    if (!f) fail(`${kind.title} has no field "${name}"${kind.fields ? ` (fields: ${Object.keys(kind.fields).join(", ")})` : ""}`);
    out[name] = raw === "" ? null : f.type === "number" ? Number(raw) : f.type === "bool" ? /^(true|yes|1|on)$/i.test(raw) : raw;
  }
  return out;
}

function line(o: any, kind?: ModObjectKind): string {
  const status = o.status ? `[${o.status}]` : "";
  return `${o.short_id.padEnd(9)} ${status.padEnd(14)} ${objectStatusIsDone(kind, o.status) ? "✓ " : ""}${o.title}`;
}

function teamArg(options: { team?: string }) {
  return options.team;
}

async function scope(deps: PublishDeps, team: string | undefined) {
  if (!team) return {};
  const { scopeFor } = await import("./signalCommand.js");
  const s: Record<string, unknown> = (await scopeFor(deps, team, true)) ?? {};
  return s.team_id ? { team_id: s.team_id } : {};
}

export function registerObjCommand(program: Command, deps: PublishDeps): void {
  const obj = program.command("obj").alias("objects").description(commandGroup("obj").description);

  obj
    .command("kinds")
    .description("The object kinds your mods declare, with their statuses and fields")
    .option("--json", "As JSON")
    .action(async (options: { json?: boolean }) => {
      const all = await kinds(deps);
      if (options.json) return console.log(JSON.stringify(all, null, 2));
      if (!all.length) return console.log(`No object kinds yet. A mod declares one in codecast-mod.json under "objects".`);
      for (const k of all) {
        console.log(`${k.prefix.padEnd(8)} ${k.title}${k.plural ? ` (${k.plural})` : ""}  from ${k.mod}`);
        if (k.statuses?.length) console.log(`         statuses: ${k.statuses.join(" -> ")}`);
        if (k.fields) console.log(`         fields:   ${Object.entries(k.fields).map(([n, f]) => `${n} (${f.type}${f.options ? `: ${f.options.join("|")}` : ""})`).join(", ")}`);
      }
    });

  obj
    .command("ls <prefix>")
    .description("Objects of one kind, newest first; done ones hidden unless --all")
    .option("--status <name>", "Only this status")
    .option("--all", "Include done objects")
    .option("-n, --limit <n>", "How many", "50")
    .option("--team <name|id>", "One team's objects")
    .option("--json", "As JSON")
    .action(async (prefix: string, options: { status?: string; all?: boolean; limit?: string; team?: string; json?: boolean }) => {
      const res = await apiPost(deps, "/cli/objects/list", { prefix, status: options.status, limit: Number(options.limit) || 50, ...(await scope(deps, teamArg(options))) }, { read: true });
      const kind: ModObjectKind | undefined = res.kinds?.[prefix];
      const rows = (res.objects ?? []).filter((o: any) => options.all || options.status || !objectStatusIsDone(kind, o.status));
      if (options.json) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log(`No ${prefix} objects${options.all ? "" : " open"}.`);
      for (const o of rows) console.log(line(o, kind));
    });

  obj
    .command("create <prefix> <title>")
    .description("File a new object; it starts in the kind's first status")
    .option("--status <name>", "Start in another status")
    .option("--set <name=value...>", "A field value (repeatable)")
    .option("--body <markdown>", "Notes in markdown; '-' reads stdin")
    .option("--team <name|id>", "The team it belongs to (default: personal)")
    .option("--json", "The created object as JSON")
    .action(async (prefix: string, title: string, options: { status?: string; set?: string[]; body?: string; team?: string; json?: boolean }) => {
      const kind = await kindOrFail(deps, prefix);
      const body = options.body === "-" ? await readStdin() : options.body;
      const res = await apiPost(deps, "/cli/objects/create", { prefix, title, status: options.status, fields: parseSets(kind, options.set), body, ...(await scope(deps, teamArg(options))) });
      if (options.json) return console.log(JSON.stringify(res, null, 2));
      console.log(`ok ${res.short_id}  ${title}  ${webBaseUrl().replace(/\/$/, "")}/o/${res.short_id}`);
    });

  obj
    .command("show <id>")
    .description("One object: status, fields and notes")
    .option("--json", "As JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      if (!OBJECT_SHORT_ID_RE.test(id.toLowerCase())) fail(`"${id}" is not an object id (<prefix>-<number>, like bug-14)`);
      const res = await apiPost(deps, "/cli/objects/get", { short_id: id }, { read: true });
      if (options.json) return console.log(JSON.stringify(res, null, 2));
      const o = res.object;
      const kind: ModObjectKind | undefined = res.kind;
      console.log(`${o.short_id}  ${o.title}`);
      if (o.status) console.log(`status:  ${o.status}${kind?.statuses ? `  (${kind.statuses.join(" -> ")})` : ""}`);
      for (const [name, f] of Object.entries(kind?.fields ?? {})) {
        const v = o.fields?.[name];
        if (v !== undefined && v !== null && v !== "") console.log(`${(f.label ?? name).padEnd(8)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
      console.log(`updated: ${new Date(o.updated_at).toISOString().slice(0, 16).replace("T", " ")}   ${webBaseUrl().replace(/\/$/, "")}/o/${o.short_id}`);
      if (o.body) console.log(`\n${o.body}`);
    });

  obj
    .command("set <id>")
    .description("Change an object's title, status, fields or notes")
    .option("--title <text>", "A new title")
    .option("--status <name>", "A new status")
    .option("--set <name=value...>", "A field value (repeatable); name= clears it")
    .option("--body <markdown>", "Replace the notes; '-' reads stdin")
    .action(async (id: string, options: { title?: string; status?: string; set?: string[]; body?: string }) => {
      const kind = await kindOrFail(deps, id.toLowerCase().split("-")[0]);
      const body = options.body === "-" ? await readStdin() : options.body;
      const res = await apiPost(deps, "/cli/objects/update", { short_id: id, title: options.title, status: options.status, fields: parseSets(kind, options.set), body });
      console.log(`ok ${res.short_id}`);
    });

  obj
    .command("done <id>")
    .description("Move an object to its kind's last status")
    .action(async (id: string) => {
      const kind = await kindOrFail(deps, id.toLowerCase().split("-")[0]);
      const last = kind.statuses?.[kind.statuses.length - 1];
      if (!last) fail(`${kind.title} has no statuses`);
      const res = await apiPost(deps, "/cli/objects/update", { short_id: id, status: last });
      console.log(`ok ${res.short_id} -> ${last}`);
    });

  obj
    .command("archive <id>")
    .description("Hide an object from lists and pages")
    .action(async (id: string) => {
      const res = await apiPost(deps, "/cli/objects/update", { short_id: id, archived: true });
      console.log(`ok archived ${res.short_id}`);
    });
}
