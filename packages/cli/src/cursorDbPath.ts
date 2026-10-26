import * as fs from "node:fs";

// A Cursor workspace database in WAL mode loses its -shm file when its window
// closes, and a read-only connection cannot create one, so every open failed
// with "unable to open database file" (3 of 24 workspaces here, 2026-10-26).
// With no -wal file beside it, everything is in the main file: open it immutable.
// Only macOS's system SQLite refuses the plain open; bun's SQLite on Linux opens
// it and reads a file: URI as a literal path, so there the path stays as it is.
export function cursorDbOpenPath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin") return file;
  if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)) return file;
  const header = Buffer.alloc(1);
  try {
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, header, 0, 1, 18); } finally { fs.closeSync(fd); }
  } catch {
    return file;
  }
  if (header[0] !== 2) return file;
  return `file:${file.split("/").map(encodeURIComponent).join("/")}?immutable=1`;
}
