// The two filesystems: the real one for consumers, an in-memory one for tests
// and for callers that want to preview what an install would do.

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile } from "@platform/cli-kit/retryQueue";
import type { SnippetFs } from "./types";

/**
 * The Node filesystem. Writes are atomic (temp file plus rename, via
 * cli-kit's atomicWriteFile): the files this package writes are the user's
 * CLAUDE.md and AGENTS.md, and a crash or a full disk partway through a plain
 * write truncates them. The whole point of the section machinery is that we
 * never destroy content we do not own.
 *
 * No `mode` is passed: atomicWriteFile keeps the mode the file already has and
 * defaults a new file to 0600. Passing a mode would re-chmod on every write,
 * and reconcilers run this on every update and boot, so a CLAUDE.md the user
 * made group-readable would keep snapping back. We own a section, not the file.
 */
export const nodeFs: SnippetFs = {
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  },
  writeFile(filePath, text) {
    atomicWriteFile(filePath, text);
  },
  exists(filePath) {
    return fs.existsSync(filePath);
  },
  mkdir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },
};

/** An in-memory SnippetFs. `files` maps absolute path to content; `dirs` holds
 *  every directory that exists. `writes` counts writeFile calls per path — the
 *  in-memory stand-in for "the mtime did not move". */
export interface MemoryFs extends SnippetFs {
  files: Map<string, string>;
  dirs: Set<string>;
  writes: Map<string, number>;
}

export function memoryFs(seed: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  for (const p of files.keys()) dirs.add(path.dirname(p));
  const writes = new Map<string, number>();
  return {
    files,
    dirs,
    writes,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, text) => {
      files.set(p, text);
      writes.set(p, (writes.get(p) ?? 0) + 1);
    },
    exists: (p) => files.has(p) || dirs.has(p),
    mkdir: (p) => {
      dirs.add(p);
    },
  };
}
