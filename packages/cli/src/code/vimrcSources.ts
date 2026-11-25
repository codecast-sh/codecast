// The person's vim config, read for the editor's vim mode: the entry points
// vim and neovim load, each followed by the files its `source` and `runtime`
// lines name, plus codecast's own overlay. Nothing is executed; the web parses
// the text. A file is read only when it resolves inside the home folder,
// symlinks followed, so a config cannot make the daemon hand an arbitrary file
// to the browser. The one exception is the nix store, where home-manager keeps
// the files ~/.vimrc and friends link to.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  CODE_VIMRC_MAX_BYTES,
  type CodeVimrcOverlayWriteResponse,
  type CodeVimrcResponse,
  type CodeVimrcSource,
  type CodeVimrcUnread,
} from "@codecast/shared/contracts";
import { writeVaultFile } from "../vault/vaultFs.js";

const MAX_DEPTH = 4;
const ENTRY_POINTS = [".vimrc", ".vim/vimrc", ".config/nvim/init.vim"];
/** Where `runtime` looks: the runtimepath directories a person writes into. */
const RUNTIME_DIRS = [".vim", ".config/nvim"];
const NIX_STORE = "/nix/store/";

export interface VimrcDirs {
  home: string;
  /** ~/.codecast, which holds the overlay. */
  configDir: string;
}

export function vimrcOverlayPath(configDir: string): string {
  return path.join(configDir, "editor", "vimrc");
}

interface SourceRef {
  path: string;
  runtime: boolean;
}

/**
 * The files a vimrc's lines name: `source`/`so` and `runtime`/`ru`, alone or
 * after a `|` (the `if filereadable(...) | source ... | endif` idiom), with
 * `silent!` in front. `runtime!` and globs are skipped: they load whole plugin
 * directories, which the editor does not run. Pure, for tests.
 */
export function sourcedPaths(text: string, file: string, home: string): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*"/.test(line)) continue;
    for (const part of line.split("|")) {
      const m = part.match(/^\s*(?:sil(?:ent)?!?\s+)?(so(?:urce)?|ru(?:ntime)?)(!?)\s+(.+?)\s*$/);
      if (!m) continue;
      const runtime = m[1].startsWith("r");
      if (runtime && m[2]) continue;
      const args = runtime ? m[3].split(/\s+/) : [m[3]];
      for (const arg of args) {
        if (/[*?[]/.test(arg) || arg.startsWith('"')) continue;
        const expanded = arg
          .replace(/^~(?=\/|$)/, home)
          .replace(/\$HOME\b|\$\{HOME\}/g, home)
          .replace(/<sfile>(?::p)?:h/g, path.dirname(file))
          .replace(/\\ /g, " ");
        if (expanded.includes("$") || expanded.includes("<")) continue; // an expression vim would evaluate
        refs.push({ path: expanded, runtime });
      }
    }
  }
  return refs;
}

function insideHome(home: string, candidate: string): boolean {
  const rel = path.relative(home, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** Read up to `budget` bytes, cut back to the last whole line when cut. */
async function readCapped(file: string, budget: number): Promise<{ content: string; bytes: number; truncated: boolean } | null> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, "r");
  } catch {
    return null;
  }
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) return null;
    const want = Math.min(stat.size, budget);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    let data = buf.subarray(0, bytesRead);
    const truncated = stat.size > budget;
    if (truncated) {
      const nl = data.lastIndexOf(0x0a);
      data = data.subarray(0, nl + 1);
    }
    return { content: data.toString("utf8"), bytes: data.length, truncated };
  } finally {
    await fh.close();
  }
}

export async function readVimrc(dirs: VimrcDirs): Promise<CodeVimrcResponse> {
  const home = path.resolve(dirs.home);
  const realHome = (await realpathOrNull(home)) ?? home;
  const sources: CodeVimrcSource[] = [];
  const unread: CodeVimrcUnread[] = [];
  const seen = new Set<string>();
  let budget = CODE_VIMRC_MAX_BYTES;

  const visit = async (file: string, depth: number, from?: string): Promise<void> => {
    const real = await realpathOrNull(file);
    if (!real) {
      if (from) unread.push({ path: file, sourced_from: from, reason: "not found" });
      return;
    }
    // init.vim that sources ~/.vimrc, or a file sourced twice: read once.
    if (seen.has(real)) return;
    if (!insideHome(realHome, real) && !real.startsWith(NIX_STORE)) {
      unread.push({ path: file, sourced_from: from ?? file, reason: "outside home" });
      return;
    }
    if (budget <= 0) {
      unread.push({ path: file, sourced_from: from ?? file, reason: "size limit" });
      return;
    }
    seen.add(real);
    const read = await readCapped(file, budget);
    if (!read) {
      if (from) unread.push({ path: file, sourced_from: from, reason: "not found" });
      return;
    }
    budget -= read.bytes;
    if (read.truncated) budget = 0;
    sources.push({
      path: file,
      content: read.content,
      ...(from ? { sourced_from: from } : {}),
      ...(read.truncated ? { truncated: true } : {}),
    });
    for (const ref of sourcedPaths(read.content, file, home)) {
      // vim resolves a relative `source` against its cwd, which a config cannot
      // count on; the sourcing file's folder is what such a line almost always means.
      const candidates = ref.runtime
        ? RUNTIME_DIRS.map((d) => path.join(home, d, ref.path))
        : [path.resolve(path.dirname(file), ref.path)];
      const outside = candidates.filter((c) => !insideHome(home, c));
      if (outside.length === candidates.length) {
        unread.push({ path: candidates[0], sourced_from: file, reason: "outside home" });
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        unread.push({ path: candidates[0], sourced_from: file, reason: "too deep" });
        continue;
      }
      const target = ref.runtime
        ? (await Promise.all(candidates.map(async (c) => ((await realpathOrNull(c)) ? c : null)))).find(Boolean)
        : candidates[0];
      if (!target) {
        unread.push({ path: candidates[0], sourced_from: file, reason: "not found" });
        continue;
      }
      await visit(target, depth + 1, file);
    }
  };

  for (const entry of ENTRY_POINTS) {
    const file = path.join(home, entry);
    if (await realpathOrNull(file)) await visit(file, 0);
  }

  const overlayFile = vimrcOverlayPath(dirs.configDir);
  const overlay = await fsp.readFile(overlayFile, "utf8").then(
    (content) => ({ path: overlayFile, content }),
    () => null,
  );
  return { sources, overlay, ...(unread.length ? { unread } : {}) };
}

export async function writeVimrcOverlay(configDir: string, content: Buffer): Promise<CodeVimrcOverlayWriteResponse> {
  const file = vimrcOverlayPath(configDir);
  // writeVaultFile is the daemon's atomic write: temp file, fsync, rename.
  const stat = await writeVaultFile(file, content);
  return { path: file, bytes: stat.size };
}
