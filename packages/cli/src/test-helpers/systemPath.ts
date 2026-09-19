import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mirrors = new Map<string, string>();

/**
 * The system tool directories mirrored as symlinks, with one command left out.
 *
 * A test that wants "this command is nowhere on PATH" cannot get it by naming
 * "/usr/bin:/bin": what lives there differs per machine, and a GitHub runner
 * ships `gh` at /usr/bin/gh. The check then finds a real gh, the wrapper looks
 * like a real install, and the test fails only in CI. Mirroring the same
 * directories minus that one name keeps every other tool the script needs.
 *
 * Built once per command and kept in the system temp directory, never inside a
 * test's HOME: a thousand symlinks per call is slow, and a test that reads its
 * own HOME should not find them there.
 */
export function systemPathWithout(command: string): string {
  const cached = mirrors.get(command);
  if (cached && fs.existsSync(cached)) return cached;
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), `sysbin-no-${command}-`));
  for (const dir of ["/usr/bin", "/bin"]) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === command) continue;
      const link = path.join(mirror, name);
      if (fs.existsSync(link)) continue;
      try { fs.symlinkSync(path.join(dir, name), link); } catch { /* racing or unreadable: skip */ }
    }
  }
  mirrors.set(command, mirror);
  return mirror;
}
