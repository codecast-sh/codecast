// Publishing one item into a workspace's kit (docs/architecture/team-kit.md).
//
// One code path for both callers: `cast cap publish` on a terminal, and the
// daemon's `cap_publish` command when someone presses "Share with team" on
// the web. Each passes its own transport (`post`) and its own resolved
// workspace; everything between finding the item and the publish call is here.
//
// Order: locate in the inventory, read the bytes, refuse anything naming the
// publisher's home directory, hash, upload the archive, publish. Publishing
// bytes that are already a version answers "unchanged" and the server drops
// the fresh upload.

import * as fs from "fs";
import * as path from "path";
import { formatCapabilitySlug } from "@codecast/shared/contracts";
import { readInventory, type InventoryItem } from "./inventory.js";
import { folderHash, packArchive, readTree, type StoreFile } from "./contentStore.js";
import { readKitLedger } from "./kitInstall.js";

export const KIT_KINDS = ["skill", "command", "subagent", "instructions"] as const;
export type KitKind = (typeof KIT_KINDS)[number];

export function isKitKind(value: unknown): value is KitKind {
  return typeof value === "string" && (KIT_KINDS as readonly string[]).includes(value);
}

/** Where the item goes: a team's kit or the publisher's own. The owner id is
 *  the slug's second segment. */
export type KitWorkspace = { kind: "team"; teamId: string } | { kind: "personal"; userId: string };

export function kitOwnerId(ws: KitWorkspace): string {
  return ws.kind === "team" ? ws.teamId : ws.userId;
}

export function kitSlug(ws: KitWorkspace, kind: KitKind, name: string): string | null {
  return formatCapabilitySlug({ source: "authored", segments: [kitOwnerId(ws), kind, name] });
}

/** Longest main body sent; the server caps again. */
export const MAX_MAIN_BODY_CHARS = 64 * 1024;

export class KitPublishError extends Error {}

/** What will be published, before anything leaves the machine. */
export interface KitPackage {
  kind: KitKind;
  name: string;
  description?: string;
  files: StoreFile[];
  /** The file whose text is the item's body: SKILL.md, the command or agent
   *  file, or the instruction section. */
  mainPath: string;
}

/* ==========================================================================
 * Locating the item
 * ========================================================================== */

/** A skill's identity is its directory name, never its frontmatter name. */
function itemIdentity(item: InventoryItem): string {
  if (item.kind === "skill" && /\/skill\.md$/i.test(item.source)) return path.basename(path.dirname(item.source));
  return path.basename(item.source).replace(/\.md$/, "");
}

export function locateKitItem(home: string, name: string, kind?: KitKind, projectPath?: string): KitPackage {
  if (kind === "instructions") throw new KitPublishError("instruction fragments publish with --instructions <file>#<heading>");
  // A project path equal to $HOME would attribute every user item to a project.
  const inventory = readInventory(home, projectPath && path.resolve(projectPath) !== path.resolve(home) ? projectPath : undefined);
  // A copy the kit installer wrote is someone's published item, not this
  // machine's own: publishing it again would only fork the original.
  const installed = new Set(Object.values(readKitLedger(home).files).flat());
  const seen = new Set<string>();
  const hits = inventory.items.filter((item) => {
    if (item.kind !== "skill" && item.kind !== "command" && item.kind !== "subagent") return false;
    if (kind && item.kind !== kind) return false;
    if (itemIdentity(item) !== name && item.name !== name) return false;
    // One shared skill shows once per client link; the bytes are one file.
    let real = item.source;
    try {
      real = fs.realpathSync(item.source);
    } catch {
      // unreadable: keep the reported path
    }
    if (seen.has(real) || installed.has(real)) return false;
    seen.add(real);
    return true;
  });
  if (hits.length === 0) {
    throw new KitPublishError(`No skill, command or subagent named "${name}" on this machine. \`cast cap ls -q ${name}\` searches partial names.`);
  }
  if (hits.length > 1) {
    const list = hits.map((h) => `  ${h.kind}  ${h.source}`).join("\n");
    throw new KitPublishError(`"${name}" names ${hits.length} items. Pass --kind, or publish from the project that has the one you mean:\n${list}`);
  }
  const item = hits[0]!;
  const id = itemIdentity(item);
  const source = fs.realpathSync(item.source);

  if (item.kind === "skill") {
    if (/\/skill\.md$/i.test(source)) {
      const files = readTree(path.dirname(source));
      const mainPath = files.find((f) => /^skill\.md$/i.test(f.path))?.path ?? "SKILL.md";
      return { kind: "skill", name: id, description: item.description, files, mainPath };
    }
    // A bare <name>.md skill ships as the folder layout every client reads.
    return { kind: "skill", name: id, description: item.description, files: [{ path: "SKILL.md", bytes: fs.readFileSync(source), executable: false }], mainPath: "SKILL.md" };
  }
  const mainPath = `${id}.md`;
  return { kind: item.kind as KitKind, name: id, description: item.description, files: [{ path: mainPath, bytes: fs.readFileSync(source), executable: false }], mainPath };
}

/** "Release checklist" -> "release-checklist": a slug segment. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * One section of a markdown file: the heading line through the line before
 * the next heading at the same or a higher level. `spec` is `<file>#<heading>`,
 * matched against the heading text or its slug.
 */
export function readInstructionSection(spec: string, cwd = process.cwd()): KitPackage {
  const hash = spec.lastIndexOf("#");
  if (hash <= 0 || hash === spec.length - 1) throw new KitPublishError(`--instructions takes <file>#<heading>, got "${spec}"`);
  const file = path.resolve(cwd, spec.slice(0, hash));
  const wanted = spec.slice(hash + 1).trim();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    throw new KitPublishError(`Cannot read ${file}`);
  }
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const headings: Array<{ index: number; level: number; title: string }> = [];
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push({ index, level: m[1]!.length, title: m[2]! });
  });
  const hit = headings.find((h) => h.title === wanted) ?? headings.find((h) => headingSlug(h.title) === headingSlug(wanted));
  if (!hit) {
    const names = headings.map((h) => `  ${"#".repeat(h.level)} ${h.title}`).join("\n");
    throw new KitPublishError(`No heading "${wanted}" in ${file}. Headings:\n${names}`);
  }
  const end = headings.find((h) => h.index > hit.index && h.level <= hit.level)?.index ?? lines.length;
  const body = lines.slice(hit.index, end).join("\n").trimEnd() + "\n";
  const name = headingSlug(hit.title);
  if (!name) throw new KitPublishError(`Heading "${hit.title}" has no letters or digits to name the fragment by`);
  const mainPath = `${name}.md`;
  return { kind: "instructions", name, files: [{ path: mainPath, bytes: Buffer.from(body), executable: false }], mainPath };
}

/* ==========================================================================
 * The home-path refusal
 * ========================================================================== */

/**
 * Lines that name the publisher's home directory. Such a path points nowhere
 * on a teammate's machine, and it tells them the publisher's username.
 * Binary files are skipped; `~/` is portable and allowed.
 */
export function findHomePaths(files: readonly StoreFile[], home: string): Array<{ path: string; line: number; text: string }> {
  const needles = new Set([home.replace(/\/+$/, "")]);
  try {
    needles.add(fs.realpathSync(home));
  } catch {
    // a home that does not resolve still has its literal form
  }
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const f of files) {
    if (f.bytes.includes(0)) continue;
    f.bytes
      .toString("utf-8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const needle of needles) {
          const at = line.indexOf(needle);
          // "/Users/ann" must not match "/Users/anna": the next char ends a segment.
          if (at !== -1 && !/[A-Za-z0-9._-]/.test(line[at + needle.length] ?? "")) {
            out.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 160) });
            return;
          }
        }
      });
  }
  return out;
}

/* ==========================================================================
 * Publishing
 * ========================================================================== */

export interface KitPublishDeps {
  home: string;
  workspace: KitWorkspace;
  deviceId: string;
  note?: string;
  /** Authenticated POST to a /cli route; throws on an error response. */
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  /** Injected for tests; callers pass fetch. */
  fetchImpl?: typeof fetch;
}

export interface KitPublishResult {
  status: "created" | "unchanged";
  slug: string;
  kind: KitKind;
  name: string;
  version?: number;
  folder_hash: string;
  file_count: number;
  item_id?: string;
  /** What the server derived the version runs (prose, ships_scripts, ...). */
  surfaces?: string[];
}

export async function publishKitPackage(pkg: KitPackage, deps: KitPublishDeps): Promise<KitPublishResult> {
  const slug = kitSlug(deps.workspace, pkg.kind, pkg.name);
  if (!slug) throw new KitPublishError(`"${pkg.name}" cannot be a kit name: use letters, digits, dot, dash and underscore`);
  if (pkg.files.length === 0) throw new KitPublishError(`${pkg.name} has no files to publish`);

  const leaks = findHomePaths(pkg.files, deps.home);
  if (leaks.length > 0) {
    const shown = leaks.slice(0, 10).map((l) => `  ${l.path}:${l.line}  ${l.text}`).join("\n");
    const more = leaks.length > 10 ? `\n  …and ${leaks.length - 10} more` : "";
    throw new KitPublishError(
      `${pkg.name} names your home directory (${deps.home}), which does not exist on a teammate's machine. Use ~/ or a relative path:\n${shown}${more}`,
    );
  }

  const hash = folderHash(pkg.files);
  const files = pkg.files.map((f) => ({ path: f.path, size: f.bytes.length, executable: f.executable }));
  const main = pkg.files.find((f) => f.path === pkg.mainPath);
  const mainBody = main ? main.bytes.toString("utf-8").slice(0, MAX_MAIN_BODY_CHARS) : "";
  // The server rebuilds the slug from (workspace, kind, name); a team_id names
  // the team's kit and its absence the publisher's own.
  const base = { ...(deps.workspace.kind === "team" ? { team_id: deps.workspace.teamId } : {}), kind: pkg.kind, name: pkg.name, folder_hash: hash };

  const upload = await deps.post("/cli/cap/kit/upload-url", {});
  const uploadUrl = upload?.upload_url;
  if (typeof uploadUrl !== "string") throw new KitPublishError("the server returned no upload URL");

  const res = await (deps.fetchImpl ?? fetch)(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/gzip" },
    body: new Uint8Array(packArchive(pkg.files)),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new KitPublishError(`upload failed: HTTP ${res.status}`);
  const { storageId } = (await res.json()) as { storageId?: string };
  if (!storageId) throw new KitPublishError("upload returned no storage id");

  const published = await deps.post("/cli/cap/kit/publish", {
    ...base,
    storage_id: storageId,
    files,
    main_body: mainBody,
    ...(pkg.description ? { description: pkg.description.slice(0, 500) } : {}),
    ...(deps.note ? { note: deps.note.slice(0, 500) } : {}),
    device_id: deps.deviceId,
  });
  if (published?.status === "rejected") throw new KitPublishError(`the server refused the publish: ${published.reason}`);
  if (published?.status !== "created" && published?.status !== "unchanged") throw new KitPublishError("the server returned no version");
  return {
    status: published.status,
    slug: published.slug ?? slug,
    kind: pkg.kind,
    name: pkg.name,
    version: published.version,
    folder_hash: hash,
    file_count: files.length,
    item_id: published.item_id,
    surfaces: published.surfaces,
  };
}

/** Locate (or read the section) and publish: the whole verb, minus output. */
export async function publishKitItem(
  target: { name?: string; kind?: KitKind; instructions?: string; projectPath?: string; cwd?: string },
  deps: KitPublishDeps,
): Promise<KitPublishResult> {
  const pkg = target.instructions
    ? readInstructionSection(target.instructions, target.cwd)
    : locateKitItem(deps.home, target.name ?? "", target.kind, target.projectPath);
  return publishKitPackage(pkg, deps);
}

/* ==========================================================================
 * The daemon's cap_publish command
 * ========================================================================== */

/** POST a /cli route with the token, throwing on an error answer. */
export function cliPoster(siteUrl: string, apiToken: string, fetchImpl: typeof fetch = fetch): KitPublishDeps["post"] {
  return async (route, body) => {
    const res = await fetchImpl(`${siteUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new KitPublishError(res.status === 404 ? `this codecast server has no ${route} route yet` : `HTTP ${res.status} from ${route}`);
    }
    if (json?.error) throw new KitPublishError(String(json.error));
    return json;
  };
}

/**
 * "Share with team" from the web: a daemon_commands row `cap_publish` with
 * `{ kind, name, team_id?, note?, instructions? }`. The web chose the
 * workspace, so nothing is resolved here: a team_id is that team's kit, none
 * is the person's own. Returns what the command row reports.
 */
export async function runCapPublishCommand(
  rawArgs: string | undefined,
  ctx: { siteUrl: string; apiToken: string; userId?: string; home: string; deviceId: string; fetchImpl?: typeof fetch },
): Promise<{ result: string } | { error: string }> {
  let args: any;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: "cap_publish args are not JSON" };
  }
  const kind = args.kind;
  if (kind !== undefined && !isKitKind(kind)) return { error: `unknown kind ${String(kind)}` };
  if (kind === "instructions" && typeof args.instructions !== "string") return { error: "an instructions item needs instructions: <file>#<heading>" };
  if (kind !== "instructions" && typeof args.name !== "string") return { error: "cap_publish needs a name" };
  const workspace: KitWorkspace | null =
    typeof args.team_id === "string" && args.team_id
      ? { kind: "team", teamId: args.team_id }
      : ctx.userId
        ? { kind: "personal", userId: ctx.userId }
        : null;
  if (!workspace) return { error: "this daemon does not know its user id" };
  try {
    const r = await publishKitItem(
      { name: args.name, kind, instructions: kind === "instructions" ? args.instructions : undefined, cwd: ctx.home },
      {
        home: ctx.home,
        workspace,
        deviceId: ctx.deviceId,
        note: typeof args.note === "string" ? args.note : undefined,
        post: cliPoster(ctx.siteUrl, ctx.apiToken, ctx.fetchImpl),
        fetchImpl: ctx.fetchImpl,
      },
    );
    return { result: JSON.stringify(r) };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) };
  }
}
