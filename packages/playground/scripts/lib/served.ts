// A served app version as files on disk, ready to mount outside a browser:
// fetch index.html and every module it reaches from the dev deployment, then
// point each import where Bun can load it ("react" to this package's React,
// "playground" to the mock SDK, esm.sh URLs to local copies), and run
// scripts/lib/mount.ts on it in its own process.
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { htmlReferences, importSpecifiers, resolveRelative } from "../../convex/builder/draft";
import { versionPath } from "../../convex/lib/runPaths";
import { ROOT, SITE } from "./harness";

export type ServedFile = { path: string; text: string };

/** index.html and every local module and stylesheet it reaches. */
export async function fetchServed(slug: string, number: number): Promise<ServedFile[]> {
  const files: ServedFile[] = [];
  const queue = ["index.html"];
  const seen = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetch(SITE + versionPath(slug, number, path === "index.html" ? "" : path));
    if (!res.ok) throw new Error(`v${number} ${path}: HTTP ${res.status}`);
    const text = await res.text();
    files.push({ path, text });
    if (path === "index.html") queue.push(...htmlReferences(text).map((r) => resolveRelative("index.html", r)!));
    else if (/\.(m?js|jsx|tsx?)$/.test(path)) {
      for (const spec of importSpecifiers(text)) if (spec.startsWith(".")) queue.push(resolveRelative(path, spec)!);
    }
  }
  return files;
}

const REACT: Record<string, string> = Object.fromEntries(
  ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"].map((s) => [s, Bun.resolveSync(s, ROOT)]),
);
const MOCK_SDK = join(import.meta.dir, "mockSdk.ts");
const ESM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const IMPORT = /(\b(?:from|import)\s*\(?\s*)(["'])([^"']+)\2/g;

function rewrite(code: string, resolve: (spec: string) => string): string {
  return code.replace(IMPORT, (_m, head: string, q: string, spec: string) => `${head}${q}${resolve(spec)}${q}`);
}

/** A local copy of an esm.sh module and everything it imports from esm.sh. */
async function localEsm(url: string, dir: string, done: Map<string, string>): Promise<string> {
  const known = done.get(url);
  if (known) return known;
  const file = join(dir, "esm", `${createHash("sha1").update(url).digest("hex").slice(0, 12)}.mjs`);
  done.set(url, file);
  const code = await (await fetch(url, { headers: { "user-agent": ESM_UA } })).text();
  const deps = new Map<string, string>();
  for (const spec of new Set(importSpecifiers(code))) {
    if (REACT[spec]) continue;
    const target = spec.startsWith("/") ? `https://esm.sh${spec}` : spec.startsWith("http") ? spec : new URL(spec, url).href;
    deps.set(spec, await localEsm(target, dir, done));
  }
  await Bun.write(file, rewrite(code, (s) => REACT[s] ?? deps.get(s) ?? s));
  return file;
}

/** Write a version's files to `dir` with every import resolvable by Bun. */
export async function stage(files: ServedFile[], dir: string): Promise<{ html: string; entries: string[] }> {
  const esm = new Map<string, string>();
  for (const f of files) {
    let text = f.text;
    if (/\.(m?js|jsx|tsx?)$/.test(f.path)) {
      const urls = new Map<string, string>();
      for (const spec of new Set(importSpecifiers(text))) {
        if (/^https?:/.test(spec)) urls.set(spec, await localEsm(spec, dir, esm));
      }
      text = rewrite(text, (s) => (s === "playground" ? MOCK_SDK : REACT[s] ?? urls.get(s) ?? s));
    }
    const out = join(dir, f.path);
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, text);
  }
  const html = files.find((f) => f.path === "index.html")!.text;
  const entries = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => resolveRelative("index.html", m[1])!);
  return { html, entries };
}

export type MountReport = {
  ok: boolean;
  firstPaint: { text: string; elements: number; painted: boolean };
  afterUse: { text: string; painted: boolean };
  errors: string[];
  sdk: { insert: number; update: number; remove: number; setShared: number; setMyState: number; refused: string[] };
  steps: { what: string; writes: number }[];
  picked: { selector: string; tag: string; text?: string; snippet?: string } | null;
};

/** Mount a staged version in a fresh process and read its report. */
export async function mount(dir: string, staged: { html: string; entries: string[] }, pick?: { tag?: string; text?: string }): Promise<MountReport> {
  const jobFile = join(dir, "job.json");
  await Bun.write(jobFile, JSON.stringify({ dir, ...staged, pick }));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "mount.ts"), jobFile], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const line = out.split("\n").find((l) => l.startsWith("@@REPORT"));
  if (!line) {
    return { ok: false, firstPaint: { text: "", elements: 0, painted: false }, afterUse: { text: "", painted: false }, errors: [`mount crashed: ${(err || out).slice(-600)}`], sdk: { insert: 0, update: 0, remove: 0, setShared: 0, setMyState: 0, refused: [] }, steps: [], picked: null };
  }
  return JSON.parse(line.slice("@@REPORT".length));
}
