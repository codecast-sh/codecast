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
import { randomUUID } from "crypto";
import {
  artifactView,
  chunkOps,
  fromElement,
  opsProblem,
  specForCli,
  ARTIFACT_SPECS,
  type ArtifactElement,
  type ArtifactOp,
  type ArtifactPosition,
  type ArtifactSpec,
  type VerbContext,
} from "@codecast/shared/artifacts";
import { apiPost, type PublishDeps } from "./castApi.js";
import { renameDoc, setDocArchived, setDocProject, shareDoc, unshareDoc, type DocPost } from "./docActions.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroupLookup.js";

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

/** Where a codecast id's title is read: a priority, goal, plan or task. */
const TITLE_ROUTES: Record<string, (id: string) => [string, Record<string, string>]> = {
  pri: (id) => ["/cli/priorities/show", { short_id: id }],
  in: (id) => ["/cli/initiatives/get", { id }],
  pl: (id) => ["/cli/plans/get", { short_id: id }],
  ct: (id) => ["/cli/work/get", { short_id: id }],
};

/** Titles for the ids a verb names; one that can't be read is left out, so the verb falls back to the id. */
export async function refTitles(post: (path: string, body: Record<string, any>) => Promise<any>, refs: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of new Set(refs)) {
    const route = TITLE_ROUTES[ref.split("-")[0]];
    if (!route) continue;
    const [path, body] = route(ref);
    const title = await post(path, body).then((r) => r?.title, () => undefined);
    if (typeof title === "string" && title.trim()) out[ref] = title.trim();
  }
  return out;
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
  return {
    title: meta.title as string, doc_type: meta.doc_type as string, head: meta.head as number, draft: meta.draft, elements,
    archived: !!meta.archived, can_edit: meta.can_edit !== false, owner: !!meta.owner,
    edit: (meta.edit ?? "team") as "team" | "owners", editors: (meta.editors ?? []) as string[],
  };
}

/** Lines `read` ends with when the artifact is not open for this session to edit, and what to do about it. */
export function readNotes(cli: string, noun: string, id: string, a: { archived?: boolean; can_edit?: boolean; draft?: { by_name?: string } | null }): string[] {
  const out: string[] = [];
  if (a.archived) out.push(`archived: read only. \`cast ${cli} unarchive ${id}\` brings it back.`);
  else if (a.can_edit === false) out.push(`view only: its owner limited who edits this ${noun}. You can still comment (\`cast ${cli} comment\`).`);
  if (a.draft) out.push(`a draft by ${a.draft.by_name ?? "someone"} is open; this shows it laid over the ${noun} (--main for the saved state). Write into it with --draft; \`cast ${cli} draft ${id} save\` publishes it.`);
  return out;
}

/**
 * Element keys for `rm`: each an element key, or a reference the product reads
 * (a sheet's A1 or Tab!A1). Throws naming every one that matches nothing.
 */
export function resolveRmKeys(spec: ArtifactSpec, view: ReturnType<typeof artifactView>, refs: string[]): string[] {
  const keys: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const key = view.get(ref) ? ref : spec.anchorFor?.(view, ref);
    if (key && view.get(key)) keys.push(key);
    else missing.push(ref);
  }
  if (missing.length) {
    const hint = spec.type === "sheet" ? "; to empty cells use `cast sheet clear <doc> <range>`" : "";
    throw new Error(`no element ${missing.join(", ")} in this ${spec.label.toLowerCase()} (\`cast ${spec.cli} read <doc> --json\` lists every key${hint})`);
  }
  return [...new Set(keys)];
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
async function writeOps(deps: PublishDeps, spec: ArtifactSpec, docId: string, title: string, ops: ArtifactOp[], opts: { draft?: boolean; position?: ArtifactPosition; status?: string; elements?: ArtifactElement[]; claim?: { scope: string; base: number } }) {
  let rev = 0;
  const written: string[] = [];
  const batches = chunkOps(ops);
  // A rewrite's batches share one write id and hold its scope until the last (lib/liveArtifactWrite claimsAfter).
  const write = opts.claim ? randomUUID() : "";
  for (const [i, batch] of batches.entries()) {
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
      ...(opts.claim ? { claim: { scope: opts.claim.scope, write, base: opts.claim.base, first: i === 0, last: i === batches.length - 1 } } : {}),
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

/** The whole life of an artifact in a few lines, the same for every product: the top of `cast <cli> --help`. */
export function lifecycleGuide(spec: ArtifactSpec): string[] {
  const noun = spec.label.toLowerCase();
  const c = (verb: string) => `\`cast ${spec.cli} ${verb}\``;
  return [
    `A ${noun} from start to end (<doc> is its id or /docs/<id> URL):`,
    `  Make: ${c('create "<title>"')} (--personal, --team, --project), or ${c("copy <doc>")}. Find: ${c("ls")}. Read: ${c("read <doc>")} (--json gives every element with its key).`,
    `  Change elements with the verbs below, or ${c("apply <doc>")} with JSON ops on stdin: {"k":key,"put":{"kind":..,..fields}} writes an element whole, {"k":key,"set":{..}} merges fields (null removes one), {"k":key,"del":true} deletes. ${c("rm <doc> <keys...>")} deletes elements.`,
    `  Edits for review: ${c("draft <doc> start")}, --draft on every write, then ${c("draft <doc> save")} (or discard).`,
    `  The ${noun} itself: ${c("rename <doc> <title>")}; ${c("share <doc>")} turns on a public link, ${c("unshare <doc>")} ends it; ${c("access <doc> team|owners [names]")}; ${c("project <doc> <ref|none>")}; ${c("archive <doc>")} deletes it (${c("unarchive <doc>")} undoes that).`,
    `  History: ${c("history <doc>")}, ${c("checkpoint <doc> [label]")}, ${c("restore <doc> <rev>")}. Comments: ${c("comment <doc> <key> <text>")}, ${c("comments <doc>")}.`,
  ];
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
    .addHelpText("after", `\n${lifecycleGuide(spec).map((l) => `  ${l}`).join("\n")}\n\nWriting a ${noun} well:\n${spec.agentGuide.split("\n").map((l) => `  ${l}`).join("\n")}\n`);

  type Placement = { project?: string; personal?: boolean; team?: string; json?: boolean };
  // A new artifact holding `ops` (the product's seed, or a copy's elements), placed by the flags.
  const createWith = async (title: string, options: Placement, ops: ArtifactOp[]) => {
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
    if (ops.length) await writeOps(deps, spec, id, title, ops, {});
    if (options.json) console.log(JSON.stringify({ id, url: `${webOrigin()}/docs/${id}` }));
    else console.log(`${fmt.success("ok")} Created ${noun} ${id}: ${title}\n  ${webOrigin()}/docs/${id}`);
  };
  const placementOptions = (c: Command) => c
    .option("--project <ref>", "Project id, short id or title")
    .option("--personal", "Only you can see it")
    .option("--team <team>", "The team that can see it (name or id)")
    .option("--json", "Machine-readable output");
  const post: DocPost = (path, body) => apiPost(deps, path, body);

  placementOptions(group
    .command("create")
    .description(`Create a ${noun}`)
    .argument("<title>", "Title"))
    .action(guard(async (title: string, options: Placement) => {
      await createWith(title, options, spec.seed?.() ?? []);
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
        console.log(JSON.stringify({ id, title: a.title, type: a.doc_type, rev: a.head, draft: a.draft ?? null, archived: a.archived, can_edit: a.can_edit, elements }, null, 2));
        return;
      }
      console.log(spec.describe(artifactView(spec.type, a.title, elements)));
      // Open comments, so an agent knows to look (cast <cli> comments lists them).
      const openRoots = (await readComments(deps, id).catch(() => [])).filter((c: any) => !c.parent && !c.resolved);
      if (openRoots.length) {
        const places = threadPlaces(spec, a.title, a.elements, openRoots);
        const where = openRoots.slice(0, 6).map((r: any) => (places.get(r.key) === null ? "deleted" : placeLabel(places.get(r.key)) ?? "unpinned"));
        console.log(`\ncomments: ${openRoots.length} open (${where.join(", ")}${openRoots.length > 6 ? ", …" : ""}); \`cast ${cli} comments ${id}\``);
      }
      const notes = readNotes(cli, noun, id, a);
      if (notes.length) console.log(fmt.muted(`\n${notes.join("\n")}`));
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
    .description(`Delete elements by key (the ${noun} itself: archive)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<keys...>", spec.anchorFor ? "Element keys, or cell references like Tab!A1" : "Element keys")
    .option("--draft", "Delete in the draft")
    .action(guard(async (ref: string, refs: string[], options: { draft?: boolean }) => {
      const id = parseDocRef(ref);
      const a = await readOwn(id, options.draft ? "merged" : "main");
      const keys = resolveRmKeys(spec, artifactView(spec.type, a.title, a.elements), refs);
      const r = await writeOps(deps, spec, id, a.title, keys.map((k) => ({ k, del: true as const })), { draft: options.draft, elements: a.elements });
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
      const n = r?.saved ?? r?.discarded;
      console.log(`${fmt.success("ok")} draft ${op}${n !== undefined ? ` (${n} elements)` : ""}`);
      if (op === "start") console.log(`Write into it by adding --draft to apply, rm and the ${cli} verbs; a write without it changes the saved ${noun} at once. \`cast ${cli} draft ${id} save\` publishes it.`);
      else if (n === 0) console.log(fmt.muted(`The draft held nothing: only writes made with --draft go into it.`));
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
      let pin: ArtifactOp[] = [];
      let pinView: ReturnType<typeof artifactView> | null = null;
      if (key.startsWith("cm_")) fields.parent = key;
      else {
        // Pin it to an element that exists: the product reads a person's reference (a sheet's Tab!A1), else it is a key.
        const a = await readOwn(id);
        const view = artifactView(spec.type, a.title, a.elements);
        const anchor = spec.anchorFor?.(view, key) ?? (view.get(key) ? key : undefined);
        if (!anchor) throw new Error(`${key} names nothing in this ${noun}; pass an element key${spec.anchorFor ? " or a reference like Tab!A1" : ""} (\`cast ${cli} read\` lists them)`);
        fields.anchor = anchor;
        // The thread rides its element from the start (a sheet stamps the cell), so a sort or insert before anyone opens the page carries it along.
        pin = spec.pinComment?.(view, anchor, k) ?? [];
        pinView = view;
      }
      await apiPost(deps, "/cli/live/apply", { doc_id: id, layer: "comments", ops: [{ k, put: { kind: "comment", ...fields } }], ...session(deps) });
      if (pin.length && pinView) await writeOps(deps, spec, id, pinView.title, pin, { elements: pinView.elements });
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
        // Each thread with where it is now (`place`, a key) and whether its element was deleted.
        const roots = rows.filter((c: any) => !c.parent);
        const a = roots.length ? await readOwn(id) : null;
        const places = a ? threadPlaces(spec, a.title, a.elements, roots) : new Map<string, string | null>();
        console.log(JSON.stringify(rows.map((c: any) => (c.parent ? c : { ...c, place: places.get(c.key) ?? null, anchor_deleted: places.get(c.key) === null })), null, 2));
        return;
      }
      const roots = rows.filter((c: any) => !c.parent && (options.all || !c.resolved));
      if (roots.length === 0) console.log(fmt.muted("No comments"));
      // Where each thread is now (it may have moved with its element, or lost it), not where it was made.
      const a = roots.length ? await readOwn(id) : null;
      const places = a ? threadPlaces(spec, a.title, a.elements, roots) : new Map<string, string | null>();
      for (const root of roots as any[]) {
        const place = places.get(root.key);
        const what = String(root.anchor ?? "").startsWith("c:") ? "cell" : "element";
        const where = place === null ? ` (its ${what} was deleted)` : place ? ` on ${placeLabel(place)}` : "";
        console.log(`${root.key}${where}${root.resolved ? " (resolved)" : ""}  ${root.author_name ?? ""}: ${root.text}`);
        for (const r of rows.filter((c: any) => c.parent === root.key) as any[]) console.log(`  ${r.key}  ${r.author_name ?? ""}: ${r.text}`);
      }
    }));

  // ── The artifact itself: the same calls `cast doc` makes (docActions.ts). ──

  group
    .command("rename")
    .description(`Rename the ${noun}`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<title...>", "New title")
    .action(guard(async (ref: string, words: string[]) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      await renameDoc(post, id, words.join(" "), deps.detectCurrentSessionId());
      console.log(`${fmt.success("ok")} renamed ${id}: ${words.join(" ").trim()}`);
    }));

  group
    .command("share")
    .description(`Turn on a public link anyone can view without signing in (--off ends it)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .option("--off", "Turn the public link off (same as unshare)")
    .action(guard(async (ref: string, options: { off?: boolean }) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      if (options.off) {
        await unshareDoc(post, id);
        console.log(`${fmt.success("ok")} public link off`);
        return;
      }
      console.log(`${fmt.success("ok")} ${await shareDoc(post, id)}`);
    }));

  group
    .command("unshare")
    .description("Turn the public link off; the old link stops working")
    .argument("<doc>", "Id or /docs/<id> URL")
    .action(guard(async (ref: string) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      await unshareDoc(post, id);
      console.log(`${fmt.success("ok")} public link off`);
    }));

  group
    .command("access")
    .description(`Who may edit a team ${noun}: the whole team, or only you and the people named (the rest view and comment)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("[who...]", "team | owners [names...]; nothing prints who edits now")
    .action(guard(async (ref: string, who: string[]) => {
      const id = parseDocRef(ref);
      const a = await readOwn(id);
      const people = ((await apiPost(deps, "/cli/live/access", { doc_id: id, ...session(deps) }, { read: true })) ?? []) as Array<{ _id: string; name: string }>;
      const nameOf = (uid: string) => people.find((p) => p._id === uid)?.name ?? uid;
      if (who.length === 0) {
        console.log(a.edit === "owners" ? `owners: the owner${a.editors.length ? ` and ${a.editors.map(nameOf).join(", ")}` : " only"}` : "team: everyone who can open it edits");
        if (people.length) console.log(fmt.muted(`can be named: ${people.map((p) => p.name).join(", ")}`));
        return;
      }
      const [mode, ...names] = who;
      if (mode !== "team" && mode !== "owners") throw new Error("access takes team, or owners followed by the people who may edit");
      const editors = names.map((n) => {
        const matches = people.filter((p) => p.name.toLowerCase() === n.toLowerCase() || p._id === n);
        const loose = matches.length ? matches : people.filter((p) => p.name.toLowerCase().includes(n.toLowerCase()));
        if (loose.length !== 1) throw new Error(`${loose.length ? `"${n}" matches ${loose.map((p) => p.name).join(", ")}` : `no one named "${n}" on the ${noun}'s team`}; name one of: ${people.map((p) => p.name).join(", ") || "(only the owner can name editors)"}`);
        return loose[0]._id;
      });
      const r = await apiPost(deps, "/cli/live/access", { op: "set", doc_id: id, edit: mode, editors, ...session(deps) });
      console.log(`${fmt.success("ok")} ${r.edit === "owners" ? `owners edit: the owner${r.editors.length ? ` and ${r.editors.map(nameOf).join(", ")}` : " only"}` : "the whole team edits"}`);
    }));

  group
    .command("project")
    .description(`File the ${noun} under a project in its own workspace (none takes it out)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("<project>", "Project id, short id or title, or none")
    .action(guard(async (ref: string, project: string) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      const clear = project === "none";
      const projectId = clear ? "" : deps.resolveProjectId ? await deps.resolveProjectId(project) : project;
      await setDocProject((path, body) => apiPost(deps, path, body, {
        describeError: (e) => /another workspace/.test(e)
          ? `that project is in another workspace; a ${noun} files only under a project in its own (to move it, \`cast ${cli} copy ${id} --team <team> --project <ref>\`, then archive this one)`
          : e,
      }), id, projectId);
      console.log(`${fmt.success("ok")} ${clear ? "out of its project" : `filed under ${project}`}`);
    }));

  placementOptions(group
    .command("copy")
    .description(`Copy the saved ${noun} into a new one (not its draft, comments or history)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .argument("[title...]", "Title of the copy (default: \"<title> (copy)\")"))
    .action(guard(async (ref: string, words: string[], options: Placement) => {
      const id = parseDocRef(ref);
      const a = await readOwn(id, "main");
      const ops: ArtifactOp[] = a.elements.map((e) => {
        const { kind, fields } = fromElement(e as any);
        return { k: e.key, put: { kind, ...fields } } as ArtifactOp;
      });
      await createWith(words.join(" ").trim() || `${a.title || "Untitled"} (copy)`, options, ops);
    }));

  group
    .command("archive")
    .description(`Delete the ${noun}: out of every list, read only, history kept (unarchive undoes; \`cast doc delete --yes\` erases for good)`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .action(guard(async (ref: string) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      await setDocArchived(post, id, true);
      console.log(`${fmt.success("ok")} archived ${id}; \`cast ${cli} unarchive ${id}\` brings it back`);
    }));

  group
    .command("unarchive")
    .description(`Bring an archived ${noun} back, as it was`)
    .argument("<doc>", "Id or /docs/<id> URL")
    .action(guard(async (ref: string) => {
      const id = parseDocRef(ref);
      await readOwn(id);
      await setDocArchived(post, id, false);
      console.log(`${fmt.success("ok")} ${id} is back`);
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
        // A session writing is an agent (the server writes as it); titles for the ids the verb names are read first.
        const refs = verb.refs?.(args) ?? [];
        const ctx: VerbContext = {
          agent: !!deps.detectCurrentSessionId(),
          ...(refs.length ? { titles: await refTitles((path, body) => apiPost(deps, path, body, { read: true, exitOnError: false }), refs) } : {}),
        };
        // The group's --json is the verb's too: a read verb formats its own output.
        const result = verb.run(view, options.json ? [...args, "--json"] : args, verb.stdin ? readStdin() : undefined, ctx);
        // A read-only verb returns no ops and its output in `status`: print it, write nothing, move no cursor.
        if (result.ops.length === 0) {
          if (result.status) console.log(result.status);
          return;
        }
        // Judgments that need the server's data run before anything is written; a failed one stops the write.
        for (const step of result.before ?? []) {
          if (!spec.remote?.[step.verb]) throw new Error(`${cli} ${name} asked for "${step.verb}", which is not a ${cli} remote verb`);
          const out = await apiPost(deps, "/cli/live/remote", { cli, verb: step.verb, doc_id: id, args: step.args, ...session(deps) });
          if (out?.failed) throw new Error(out.text ?? `${step.verb} refused the write`);
        }
        // The cursor label takes the status's first line; the agent gets all of it (board verbs end it with the keys they made).
        const label = result.status?.split("\n")[0];
        const r = await writeOps(deps, spec, id, a.title, result.ops, {
          draft: options.draft, position: result.position, status: label, elements: a.elements,
          ...(result.claim && !options.draft ? { claim: { scope: result.claim.scope, base: a.head } } : {}),
        });
        // Server-side follow-ups the verb asked for, once its write has landed.
        const after: string[] = [];
        for (const step of result.after ?? []) {
          if (!spec.remote?.[step.verb]) throw new Error(`${cli} ${name} asked for "${step.verb}", which is not a ${cli} remote verb`);
          const out = await apiPost(deps, "/cli/live/remote", { cli, verb: step.verb, doc_id: id, args: step.args, ...session(deps) });
          if (out?.text) after.push(out.text);
        }
        if (options.json) {
          console.log(JSON.stringify({ ...r, ...(result.status ? { status: result.status } : {}), ...(after.length ? { after } : {}) }));
          return;
        }
        printWrite(spec, id, r);
        if (result.status) console.log(result.status);
        for (const text of after) console.log(text);
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
        // A remote verb that judges something (check) says when the judgment failed; the exit code carries it to scripts.
        if (r?.failed) process.exitCode = 1;
      }));
  }
}

/** Where each thread sits now (the product's commentPlaces), or its anchor when the product does not say. Null: its element is gone. */
function threadPlaces(spec: ArtifactSpec, title: string, elements: ArtifactElement[], roots: any[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const places = spec.commentPlaces?.(artifactView(spec.type, title, elements), roots.map((r) => ({ key: r.key, anchor: r.anchor })));
  for (const r of roots) out.set(r.key, places?.has(r.key) ? places.get(r.key)! : r.anchor ?? undefined);
  return out;
}

const placeLabel = (p: string | null | undefined) => (p ? String(p).replace(/^c:/, "") : p);

export function registerBoardCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "board");
}
export function registerSheetCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "sheet");
}
export function registerDataCommand(program: Command, deps: LiveDeps): void {
  registerGroup(program, deps, "data");
}
