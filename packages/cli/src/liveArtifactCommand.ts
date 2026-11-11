// `cast board`, `cast sheet`, `cast data`: read and edit live artifacts (docs
// of type board, sheet, dashboard) from a session. One module registers all
// three groups from the shared spec registry; a product adds its own verbs in
// its spec (@codecast/shared/artifacts), never here.
//
// Every call names the session it runs in (session_id), so the server writes
// as that session: its name and cursor show on the open page while it works.
// Routes: /cli/live/* in http.ts (liveArtifacts.ts); create goes through
// /cli/docs/create like `cast doc create`.
import type { Command } from "commander";
import { readFileSync } from "fs";
import {
  artifactView,
  chunkOps,
  opsProblem,
  specForCli,
  ARTIFACT_SPECS,
  type ArtifactElement,
  type ArtifactOp,
  type ArtifactPosition,
  type ArtifactSpec,
} from "@codecast/shared/artifacts";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";

type LiveDeps = PublishDeps & { resolveProjectId?: (ref: string) => Promise<string> };

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

const webOrigin = () => (process.env.CODECAST_WEB_URL || "https://codecast.sh").replace(/\/$/, "");

/** A doc id from an id, `doc:<id>`, or a /docs/<id> URL. */
export function parseDocRef(ref: string): string {
  const m = ref.match(/\/docs\/([a-z0-9]{20,})/i) ?? ref.match(/^(?:doc:)?([a-z0-9]{20,})$/i);
  if (!m) throw new Error(`Not an artifact id: ${ref}. Use the id from \`cast <board|sheet|data> ls\` or its /docs/<id> URL.`);
  return m[1];
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/** Ops from `apply` input: a JSON array of ops, or {ops, position?, status?}. */
export function parseOpsInput(text: string): { ops: ArtifactOp[]; position?: ArtifactPosition; status?: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`ops must be JSON: ${(e as Error).message}`);
  }
  const body = Array.isArray(parsed) ? { ops: parsed } : parsed;
  if (!body || !Array.isArray(body.ops)) throw new Error("expected a JSON array of ops, or {\"ops\": [...]}");
  const problem = opsProblem(body.ops.slice(0, 400));
  if (problem) throw new Error(problem);
  return body;
}

type Session = { session_id?: string };

function session(deps: PublishDeps): Session {
  const id = deps.detectCurrentSessionId();
  return id ? { session_id: id } : {};
}

/** The artifact's current elements (one layer or merged), read page by page. */
export async function readArtifact(deps: PublishDeps, docId: string, layer: "merged" | "main" | "draft" = "merged") {
  let since = 0;
  const main = new Map<string, any>();
  const draft = new Map<string, any>();
  let meta: any = null;
  for (;;) {
    const page = await apiPost(deps, "/cli/live/elements", { doc_id: docId, since, ...session(deps) }, { read: true });
    if (!page) throw new Error(`No board, sheet or dashboard ${docId} that you can open`);
    meta = page;
    for (const r of page.rows) {
      if (r.layer === "comments") continue;
      const into = r.layer === "draft" ? draft : main;
      if (r.dead) into.delete(r.key);
      else into.set(r.key, r);
    }
    if (!page.more) break;
    since = page.next;
  }
  const pick = new Map<string, any>();
  if (layer !== "draft") for (const [k, r] of main) pick.set(k, r);
  if (layer !== "main") for (const [k, r] of draft) pick.set(k, r);
  const elements: ArtifactElement[] = [...pick.values()]
    .filter((r) => !r.deleted)
    .map((r) => ({ ...(r.fields ?? {}), key: r.key, kind: r.kind, rev: r.rev, by: r.by, at: r.at }));
  return { title: meta.title as string, doc_type: meta.doc_type as string, head: meta.head as number, draft: meta.draft, elements };
}

async function readComments(deps: PublishDeps, docId: string) {
  let since = 0;
  const rows = new Map<string, any>();
  for (;;) {
    const page = await apiPost(deps, "/cli/live/elements", { doc_id: docId, since, ...session(deps) }, { read: true });
    if (!page) throw new Error(`No board, sheet or dashboard ${docId} that you can open`);
    for (const r of page.rows) if (r.layer === "comments") rows.set(r.key, r);
    if (!page.more) break;
    since = page.next;
  }
  return [...rows.values()].filter((r) => !r.deleted).map((r) => ({ key: r.key, ...(r.fields ?? {}) }));
}

/** Write ops as this session, in server-sized batches, moving its cursor to what it wrote. */
async function writeOps(deps: PublishDeps, spec: ArtifactSpec, docId: string, title: string, ops: ArtifactOp[], opts: { draft?: boolean; position?: ArtifactPosition; status?: string; elements?: ArtifactElement[] }) {
  let rev = 0;
  const written: string[] = [];
  for (const batch of chunkOps(ops)) {
    const keys = batch.map((o) => o.k);
    const view = artifactView(spec.type, title, opts.elements ?? []);
    const position = opts.position ?? spec.presenceFor?.(view, keys) ?? { key: keys[keys.length - 1] };
    const r = await apiPost(deps, "/cli/live/apply", {
      doc_id: docId,
      layer: opts.draft ? "draft" : "main",
      ops: batch,
      position,
      selection: keys.slice(-50),
      ...(opts.status ? { status: opts.status } : {}),
      ...session(deps),
    });
    rev = r.rev;
    written.push(...r.keys);
  }
  return { rev, written };
}

function printWrite(spec: ArtifactSpec, docId: string, r: { rev: number; written: string[] }, json?: boolean) {
  if (json) {
    console.log(JSON.stringify(r));
    return;
  }
  console.log(`${fmt.success("ok")} ${r.written.length} element${r.written.length === 1 ? "" : "s"} written (r${r.rev}) ${fmt.muted(`${webOrigin()}/docs/${docId}`)}`);
}

function position(opts: { point?: string; cell?: string; range?: string; block?: string; key?: string }): ArtifactPosition | undefined {
  if (opts.point) {
    const [x, y] = opts.point.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("--point takes x,y");
    return { point: { x, y } };
  }
  if (opts.cell) return { cell: opts.cell.includes("!") ? opts.cell : `Sheet1!${opts.cell.toUpperCase()}` };
  if (opts.range) return { range: opts.range.includes("!") ? opts.range : `Sheet1!${opts.range.toUpperCase()}` };
  if (opts.block) return { block: opts.block };
  if (opts.key) return { key: opts.key };
  return undefined;
}

function guard<T extends any[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };
}

function registerGroup(program: Command, deps: LiveDeps, cli: string) {
  const spec = specForCli(cli);
  if (!spec) return;
  const noun = spec.label.toLowerCase();
  // A doc of another type reads as an empty one of this type: refuse it and name the right group.
  const readOwn = async (id: string, layer?: "merged" | "main" | "draft") => {
    const a = await readArtifact(deps, id, layer);
    if (a.doc_type !== spec.type) {
      const other = ARTIFACT_SPECS[a.doc_type as keyof typeof ARTIFACT_SPECS] as typeof spec | undefined;
      throw new Error(`${id} is a ${other?.label.toLowerCase() ?? a.doc_type}, not a ${noun}${other ? `: use cast ${other.cli}` : ""}`);
    }
    return a;
  };
  const group = program
    .command(cli)
    .description(commandGroup(cli).description)
    .addHelpText("after", `\nWriting a ${noun} well:\n${spec.agentGuide.split("\n").map((l) => `  ${l}`).join("\n")}\n`);

  group
    .command("create")
    .description(`Create a ${noun}`)
    .argument("<title>", "Title")
    .option("--project <ref>", "Project id, short id or title")
    .option("--personal", "Only you can see it")
    .option("--team <team>", "The team that can see it (name or id)")
    .option("--json", "Machine-readable output")
    .action(guard(async (title: string, options: { project?: string; personal?: boolean; team?: string; json?: boolean }) => {
      if (options.personal && options.team) throw new Error("Pass --personal or --team, not both");
      const sid = deps.detectCurrentSessionId();
      const body: Record<string, any> = { title, content: "", doc_type: spec.type, project_path: process.cwd(), ...(sid ? { conversation_id: sid } : {}) };
      // Without either flag the workspace follows the session's team, then the directory's mapping.
      if (options.personal || options.team) {
        const { loadWorkspaceRoster, resolveWorkspaceForWrite } = await import("./resolveWorkspace.js");
        const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
        const ws = resolveWorkspaceForWrite(roster, options.personal ? "personal" : options.team);
        Object.assign(body, ws.kind === "team" ? { workspace: "team", team_id: ws.teamId } : { workspace: "personal" });
      }
      if (options.project && deps.resolveProjectId) body.project_id = await deps.resolveProjectId(options.project);
      const result = await apiPost(deps, "/cli/docs/create", body);
      const id = String(result.id || result._id);
      const seed = spec.seed?.() ?? [];
      if (seed.length) await writeOps(deps, spec, id, title, seed, {});
      if (options.json) console.log(JSON.stringify({ id, url: `${webOrigin()}/docs/${id}` }));
      else console.log(`${fmt.success("ok")} Created ${noun} ${id}: ${title}\n  ${webOrigin()}/docs/${id}`);
    }));

  group
    .command("ls")
    .description(`List ${noun}s`)
    .option("-n, --limit <n>", "Max results", "20")
    .option("--json", "Machine-readable output")
    .action(guard(async (options: { limit: string; json?: boolean }) => {
      const docs = await apiPost(deps, "/cli/docs/list", { doc_type: spec.type, limit: Number(options.limit) || 20 }, { read: true });
      const rows = (Array.isArray(docs) ? docs : docs?.docs ?? []) as any[];
      if (options.json) {
        console.log(JSON.stringify(rows.map((d) => ({ id: d._id, title: d.title, updated_at: d.updated_at }))));
        return;
      }
      if (rows.length === 0) console.log(fmt.muted(`No ${noun}s`));
      for (const d of rows) console.log(`${d._id}  ${d.title}`);
    }));

  group
    .command("read")
    .description(`Print the ${noun} in a compact form an agent can reason over`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("--json", "The elements as JSON")
    .option("--draft", "Only the draft layer")
    .option("--main", "Only the saved layer, without the draft")
    .option("--keys <keys>", "Only these element keys (comma-separated)")
    .action(guard(async (ref: string, options: { json?: boolean; draft?: boolean; main?: boolean; keys?: string }) => {
      const id = parseDocRef(ref);
      const a = await readOwn(id, options.draft ? "draft" : options.main ? "main" : "merged");
      let elements = a.elements;
      if (options.keys) {
        const keys = new Set(options.keys.split(",").map((s) => s.trim()));
        elements = elements.filter((e) => keys.has(e.key));
      }
      if (options.json) {
        console.log(JSON.stringify({ id, title: a.title, type: a.doc_type, rev: a.head, draft: a.draft ?? null, elements }, null, 2));
        return;
      }
      console.log(spec.describe(artifactView(spec.type, a.title, elements)));
      if (a.draft) console.log(fmt.muted(`\n(a draft by ${a.draft.by_name} is open; this shows it laid over the ${noun}. --main for the saved state)`));
    }));

  group
    .command("apply")
    .description("Write ops from stdin or a file: a JSON array of {k, put|set|del}")
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("-f, --file <path>", "Read ops from a file instead of stdin")
    .option("--draft", "Write into the draft (opens one if none is open)")
    .option("--status <text>", "What you are doing, shown on your cursor")
    .option("--json", "Machine-readable output")
    .action(guard(async (ref: string, options: { file?: string; draft?: boolean; status?: string; json?: boolean }) => {
      const id = parseDocRef(ref);
      const input = parseOpsInput(options.file ? readFileSync(options.file, "utf-8") : readStdin());
      const a = await readOwn(id);
      const r = await writeOps(deps, spec, id, a.title, input.ops, { draft: options.draft, position: input.position, status: options.status ?? input.status, elements: a.elements });
      printWrite(spec, id, r, options.json);
    }));

  group
    .command("rm")
    .description("Delete elements by key")
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<keys...>", "Element keys")
    .option("--draft", "Delete in the draft")
    .action(guard(async (ref: string, keys: string[], options: { draft?: boolean }) => {
      const id = parseDocRef(ref);
      const r = await writeOps(deps, spec, id, "", keys.map((k) => ({ k, del: true as const })), { draft: options.draft });
      printWrite(spec, id, r);
    }));

  group
    .command("cursor")
    .description("Move this session's cursor (shown to everyone on the page)")
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("--point <x,y>", "Canvas point")
    .option("--cell <A1>", "Sheet cell")
    .option("--range <A1:B2>", "Sheet range")
    .option("--block <key>", "Dashboard block")
    .option("--key <key>", "Any element")
    .option("--status <text>", "What you are doing")
    .action(guard(async (ref: string, options: any) => {
      const id = parseDocRef(ref);
      await apiPost(deps, "/cli/live/presence", { doc_id: id, position: position(options), ...(options.status ? { status: options.status } : {}), ...session(deps) });
      console.log(fmt.success("ok"));
    }));

  group
    .command("draft")
    .description("Start, save or discard the draft (a set of edits only editors see until saved)")
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<op>", "start | save | discard")
    .option("--label <text>", "What the draft is, for start")
    .action(guard(async (ref: string, op: string, options: { label?: string }) => {
      if (!["start", "save", "discard"].includes(op)) throw new Error("draft takes start, save or discard");
      const id = parseDocRef(ref);
      const r = await apiPost(deps, "/cli/live/draft", { op, doc_id: id, ...(op === "start" && options.label ? { label: options.label } : {}), ...session(deps) });
      console.log(`${fmt.success("ok")} draft ${op}${r?.saved !== undefined ? ` (${r.saved} elements)` : r?.discarded !== undefined ? ` (${r.discarded} elements)` : ""}`);
    }));

  group
    .command("history")
    .description("List saved versions")
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("--json", "Machine-readable output")
    .action(guard(async (ref: string, options: { json?: boolean }) => {
      const id = parseDocRef(ref);
      const r = await apiPost(deps, "/cli/live/versions", { doc_id: id, ...session(deps) }, { read: true });
      if (!r) throw new Error(`No ${noun} ${id} that you can open`);
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(fmt.muted(`now r${r.head}`));
      for (const v of r.versions) console.log(`r${v.rev}\t${new Date(v.at).toISOString().slice(0, 16).replace("T", " ")}\t${v.by_name}\t${v.label}`);
    }));

  group
    .command("checkpoint")
    .description("Save the current state as a named version")
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("[label]", "Name")
    .action(guard(async (ref: string, label?: string) => {
      const id = parseDocRef(ref);
      const r = await apiPost(deps, "/cli/live/checkpoint", { doc_id: id, ...(label ? { label } : {}), ...session(deps) });
      console.log(`${fmt.success("ok")} saved r${r.rev}`);
    }));

  group
    .command("restore")
    .description("Put the artifact back to a version (the current state is saved first)")
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<rev>", "Revision from `history` (r12 or 12)")
    .action(guard(async (ref: string, rev: string) => {
      const id = parseDocRef(ref);
      const n = Number(rev.replace(/^r/, ""));
      if (!Number.isFinite(n)) throw new Error("rev must be a number");
      const r = await apiPost(deps, "/cli/live/restore", { doc_id: id, rev: n, ...session(deps) });
      console.log(`${fmt.success("ok")} restored to r${n}: ${r.changed} element${r.changed === 1 ? "" : "s"} changed (now r${r.rev})`);
    }));

  group
    .command("comment")
    .description("Comment on an element (a key), or reply to a comment (a cm_ key)")
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<key>", "Element key to pin it to, or a comment key to reply to")
    .argument("<text...>", "Comment")
    .action(guard(async (ref: string, key: string, words: string[]) => {
      const id = parseDocRef(ref);
      const k = `cm_${Math.random().toString(36).slice(2, 12)}`;
      const fields: Record<string, any> = { text: words.join(" "), created_at: Date.now() };
      if (key.startsWith("cm_")) fields.parent = key;
      else fields.anchor = key;
      await apiPost(deps, "/cli/live/apply", { doc_id: id, layer: "comments", ops: [{ k, put: { kind: "comment", ...fields } }], ...session(deps) });
      console.log(`${fmt.success("ok")} ${k}`);
    }));

  group
    .command("comments")
    .description("List comments")
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("--all", "Include resolved threads")
    .option("--json", "Machine-readable output")
    .action(guard(async (ref: string, options: { all?: boolean; json?: boolean }) => {
      const id = parseDocRef(ref);
      const rows = await readComments(deps, id);
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      const roots = rows.filter((c: any) => !c.parent && (options.all || !c.resolved));
      if (roots.length === 0) console.log(fmt.muted("No comments"));
      for (const root of roots as any[]) {
        console.log(`${root.key}${root.anchor ? ` on ${root.anchor}` : ""}${root.resolved ? " (resolved)" : ""}  ${root.author_name ?? ""}: ${root.text}`);
        for (const r of rows.filter((c: any) => c.parent === root.key) as any[]) console.log(`  ${r.key}  ${r.author_name ?? ""}: ${r.text}`);
      }
    }));

  for (const [name, verb] of Object.entries(spec.verbs ?? {})) {
    group
      .command(name)
      .description(verb.summary)
      .usage(verb.usage.replace(/^\S+\s*/, ""))
      .argument("<doc>", "Id or /docs/<id> URL")
      .argument("[args...]", "Verb arguments")
      .option("--draft", "Write into the draft")
      .option("--json", "Machine-readable output")
      // A verb's own flags reach it in `args`, in order; the verb parses them.
      .allowUnknownOption(true)
      .action(guard(async (ref: string, args: string[], options: { draft?: boolean; json?: boolean }) => {
        const id = parseDocRef(ref);
        const a = await readOwn(id);
        const view = artifactView(spec.type, a.title, a.elements);
        // The group's --json is the verb's too: a read verb formats its own output.
        const result = verb.run(view, options.json ? [...args, "--json"] : args, verb.stdin ? readStdin() : undefined);
        // A read-only verb returns no ops and its output in `status`: print it, write nothing, move no cursor.
        if (result.ops.length === 0) {
          if (result.status) console.log(result.status);
          return;
        }
        const r = await writeOps(deps, spec, id, a.title, result.ops, { draft: options.draft, position: result.position, status: result.status, elements: a.elements });
        printWrite(spec, id, r, options.json);
      }));
  }

  for (const [name, verb] of Object.entries(spec.remote ?? {})) {
    group
      .command(name)
      .description(verb.summary)
      .usage(verb.usage.replace(/^\S+\s*/, ""))
      .argument("[args...]", "Verb arguments")
      .option("--doc <doc>", "The artifact it is about")
      .option("--json", "Machine-readable output")
      .allowUnknownOption(true)
      .action(guard(async (args: string[], options: { doc?: string; json?: boolean }) => {
        let docId = options.doc ? parseDocRef(options.doc) : undefined;
        // A first argument that is a doc id is the doc.
        if (!docId && args[0] && /^(doc:)?[a-z0-9]{20,}$|\/docs\//i.test(args[0])) docId = parseDocRef(args.shift()!);
        const r = await apiPost(deps, "/cli/live/remote", { cli, verb: name, ...(docId ? { doc_id: docId } : {}), args, ...(verb.stdin ? { stdin: readStdin() } : {}), ...session(deps) });
        if (options.json || r?.text === undefined) console.log(JSON.stringify(r?.json ?? r, null, 2));
        else console.log(r.text);
      }));
  }
}

export function registerBoardCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "board");
}
export function registerSheetCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "sheet");
}
export function registerDataCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "data");
}
