// Which language servers codecast knows how to start, and whether this machine
// has each one. Detection is async (fs.promises, no `which` spawns), looks past
// the daemon's often-bare PATH into the places people install servers, prefers
// a project's own node_modules copy, and is cached briefly so a server
// installed while the editor is open shows up within half a minute.

import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { TOOL_PATH } from "../../proc.js";
import type { LspServerInfo } from "@codecast/shared/contracts";

export interface LspServerSpec {
  id: string;
  name: string;
  languages: string[];
  /** Binary names, best first. */
  bins: string[];
  args: string[];
  install: string;
  /** Install dirs beyond the shared search path, absolute. */
  dirs?: string[];
  /** Look in `<ancestor>/node_modules/.bin` from the vault root upward first. */
  projectLocal?: boolean;
  /** Defaults merged under the client's `initializationOptions`. Read when a
   *  process starts, not when servers are listed. */
  initializationOptions?: (root: string) => Promise<Record<string, unknown> | undefined>;
  /** Why a binary that was found still cannot run here (a rustup proxy whose
   *  toolchain lacks the component), or null when it can. */
  unusable?: (command: string, root: string) => Promise<string | null>;
}

export interface LspLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  initializationOptions?: Record<string, unknown>;
}

export type LspResolution = { ok: true; launch: LspLaunch } | { ok: false; reason: string };

const HOME = os.homedir();
const home = (...p: string[]) => path.join(HOME, ...p);
const NPM = (pkg: string) => `Install it with: npm install -g ${pkg}`;

/** Where people's servers live when the daemon's PATH does not say so. */
const SEARCH_DIRS = [
  ...TOOL_PATH.split(path.delimiter),
  home(".cargo/bin"),
  home("go/bin"),
  home(".bun/bin"),
  home(".volta/bin"),
  home(".npm-global/bin"),
  home(".local/share/pnpm"),
  "/usr/local/go/bin",
].filter((d, i, all) => d && all.indexOf(d) === i);

export const LSP_SERVERS: LspServerSpec[] = [
  {
    id: "typescript",
    name: "TypeScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    bins: ["typescript-language-server"],
    args: ["--stdio"],
    install: NPM("typescript-language-server typescript"),
    projectLocal: true,
    // The project's own compiler, so the editor reports what `tsc` would.
    initializationOptions: async (root) => {
      const tsserver = await findUpward(root, "node_modules/typescript/lib/tsserver.js");
      return tsserver ? { tsserver: { path: tsserver } } : undefined;
    },
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    languages: ["rust"],
    bins: ["rust-analyzer"],
    args: [],
    install: "Install it with: rustup component add rust-analyzer",
    unusable: (command, root) => rustupComponentMissing(command, root, path.basename(command)),
  },
  {
    id: "clangd",
    name: "clangd",
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    bins: ["clangd"],
    args: ["--background-index"],
    dirs: ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"],
    install: process.platform === "darwin" ? "Install the Xcode Command Line Tools: xcode-select --install" : "Install clangd with your package manager, e.g. sudo apt install clangd",
  },
  {
    id: "sourcekit",
    name: "SourceKit-LSP",
    languages: ["swift"],
    bins: ["sourcekit-lsp"],
    args: [],
    install: process.platform === "darwin" ? "Install Xcode, or the Swift toolchain from swift.org" : "Install the Swift toolchain from swift.org",
  },
  {
    id: "basedpyright",
    name: "basedpyright",
    languages: ["python"],
    bins: ["basedpyright-langserver"],
    args: ["--stdio"],
    install: "Install it with: pip install basedpyright",
  },
  {
    id: "pyright",
    name: "Pyright",
    languages: ["python"],
    bins: ["pyright-langserver"],
    args: ["--stdio"],
    install: NPM("pyright"),
    projectLocal: true,
  },
  {
    id: "gopls",
    name: "gopls",
    languages: ["go"],
    bins: ["gopls"],
    args: [],
    dirs: process.env.GOPATH ? [path.join(process.env.GOPATH, "bin")] : [],
    install: "Install it with: go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "bash",
    name: "Bash",
    languages: ["shellscript"],
    bins: ["bash-language-server"],
    args: ["start"],
    install: NPM("bash-language-server"),
    projectLocal: true,
  },
  {
    id: "yaml",
    name: "YAML",
    languages: ["yaml"],
    bins: ["yaml-language-server"],
    args: ["--stdio"],
    install: NPM("yaml-language-server"),
    projectLocal: true,
  },
  ...(
    [
      ["css", "CSS", ["css", "scss", "less"]],
      ["html", "HTML", ["html"]],
      ["json", "JSON", ["json", "jsonc"]],
    ] as const
  ).map(([id, name, languages]) => ({
    id,
    name,
    languages: [...languages],
    bins: [`vscode-${id}-language-server`],
    args: ["--stdio"],
    install: NPM("vscode-langservers-extracted"),
    projectLocal: true,
  })),
];

// ── Detection ──────────────────────────────────────────────────────────────

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearLspDetectionCache(): void {
  cache.clear();
}

const WIN_EXTS = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

async function executable(file: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") await fsp.access(file, fsp.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(dirs: string[], bin: string): Promise<string | null> {
  // In order, not in parallel: the first directory wins, as on a real PATH.
  for (const dir of dirs) {
    for (const ext of WIN_EXTS) {
      const file = path.join(dir, bin + ext);
      if (await executable(file)) return file;
    }
  }
  return null;
}

const exists = (file: string) => fsp.access(file).then(() => true, () => false);
const UID = process.getuid?.();

/** `rel` under the nearest ancestor of `start` (inclusive) that has it, looking
 *  no higher than the repository root or the home directory, and only in
 *  directories this user owns: a `node_modules` planted in a shared parent
 *  such as /tmp must never be what runs when someone opens a file. */
async function findUpward(start: string, rel: string): Promise<string | null> {
  for (let dir = path.resolve(start), first = true; ; first = false) {
    if (!first && UID !== undefined && (await fsp.stat(dir).then((st) => st.uid, () => -1)) !== UID) return null;
    const file = path.join(dir, rel);
    if (await exists(file)) return file;
    const parent = path.dirname(dir);
    if (parent === dir || dir === HOME || (await exists(path.join(dir, ".git")))) return null;
    dir = parent;
  }
}

/** An npm-installed server is a `#!/usr/bin/env node` script, so finding the
 *  script is not enough: the machine needs node too. */
async function needsNode(file: string): Promise<boolean> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    return /^#!.*\bnode\b/.test(first);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function locate(spec: LspServerSpec, root: string): Promise<string | null> {
  for (const bin of spec.bins) {
    const local = spec.projectLocal ? await findUpward(root, path.join("node_modules", ".bin", bin)) : null;
    const found = local ?? (await firstExecutable([...SEARCH_DIRS, ...(spec.dirs ?? [])], bin));
    if (found) return found;
  }
  return null;
}

const findNode = () => cached("node", () => firstExecutable(SEARCH_DIRS, "node"));

const readText = (file: string) => fsp.readFile(file, "utf8").catch(() => null);

/** The toolchain rustup would run in `root`: RUSTUP_TOOLCHAIN, a
 *  rust-toolchain(.toml) file up the tree, a directory override, else the
 *  default. Null when it cannot tell. */
async function rustupToolchain(rustupHome: string, root: string): Promise<string | null> {
  if (process.env.RUSTUP_TOOLCHAIN) return process.env.RUSTUP_TOOLCHAIN;
  for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
    const file = await findUpward(root, name);
    const text = file ? await readText(file) : null;
    if (!text) continue;
    const channel = /channel\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? (name === "rust-toolchain" ? text.trim().split("\n")[0] : null);
    if (channel) return channel;
  }
  const settings = await readText(path.join(rustupHome, "settings.toml"));
  if (!settings) return null;
  const overrides = settings.slice(settings.indexOf("[overrides]"));
  for (const m of overrides.matchAll(/^"([^"]+)"\s*=\s*"([^"]+)"/gm)) {
    if (root === m[1] || root.startsWith(m[1] + path.sep)) return m[2];
  }
  return /^default_toolchain\s*=\s*"([^"]+)"/m.exec(settings)?.[1] ?? null;
}

/** A rustup proxy (`~/.cargo/bin/rust-analyzer -> rustup`) exists whether or
 *  not the component is installed, and without it every start fails with
 *  "Unknown binary". Says so, so the editor shows the install hint instead
 *  of a server that crashes in a loop. */
async function rustupComponentMissing(command: string, root: string, bin: string): Promise<string | null> {
  const real = await fsp.realpath(command).catch(() => command);
  if (!/^rustup(-init)?(\.exe)?$/.test(path.basename(real))) return null;
  const rustupHome = process.env.RUSTUP_HOME ?? home(".rustup");
  const toolchain = await rustupToolchain(rustupHome, root);
  if (!toolchain) return null;
  const dirs = await fsp.readdir(path.join(rustupHome, "toolchains")).catch(() => [] as string[]);
  const dir = dirs.find((d) => d === toolchain) ?? dirs.find((d) => d.startsWith(`${toolchain}-`));
  if (!dir) return null;
  return (await executable(path.join(rustupHome, "toolchains", dir, "bin", bin))) ? null : `the ${bin} component is not installed for the ${toolchain} toolchain`;
}

/** How to start `spec` for a vault rooted at `root`, or why it cannot be.
 *  Leaves `initializationOptions` to the caller that starts the process. */
export function resolveLspServer(spec: LspServerSpec, root: string): Promise<LspResolution> {
  return cached(`${spec.id}\0${root}`, async (): Promise<LspResolution> => {
    const command = await locate(spec, root);
    if (!command) return { ok: false, reason: `${spec.name} language server is not installed` };
    const unusable = await spec.unusable?.(command, root);
    if (unusable) return { ok: false, reason: unusable };
    const node = (await needsNode(command)) ? await findNode() : undefined;
    if (node === null) return { ok: false, reason: `${spec.name} language server needs Node.js, which is not on this machine` };
    const binDirs = [path.dirname(command), node && path.dirname(node)].filter((d): d is string => !!d);
    return { ok: true, launch: { command, args: spec.args, env: { ...process.env, PATH: [...binDirs, ...SEARCH_DIRS].join(path.delimiter) } } };
  });
}

export async function describeLspServers(
  specs: LspServerSpec[],
  root: string,
  running: (id: string) => boolean,
): Promise<LspServerInfo[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const resolved = await resolveLspServer(spec, root);
      return lspServerInfo(spec, resolved.ok ? resolved.launch.command : null, running(spec.id));
    }),
  );
}

export function lspServerInfo(spec: LspServerSpec, command: string | null, running?: boolean): LspServerInfo {
  return {
    id: spec.id,
    name: spec.name,
    languages: spec.languages,
    available: !!command,
    ...(command ? { command } : { install_hint: spec.install }),
    ...(running !== undefined ? { running } : {}),
  };
}
