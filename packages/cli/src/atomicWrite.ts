/**
 * One atomic file write for the whole CLI, from @platform/cli-kit.
 *
 * Every config write goes through here. The daemon's remote `config_write`
 * handler used to call `fs.writeFileSync` straight onto the target, so a crash,
 * a power loss or a kill between truncate and the last byte left the user with a
 * truncated — often unparseable — `~/.claude/settings.json`.
 *
 * What the package's implementation guarantees, and why each part is there:
 *
 *  - the temp name carries pid + uuid and opens with "wx", so two writers can
 *    never share a temp file and a stale temp can never be adopted;
 *  - the payload is fsynced before the rename, so the rename can only publish
 *    bytes the disk has actually acknowledged;
 *  - `rename` is the publish step, and it is atomic within a filesystem, so a
 *    concurrent reader sees the whole old file or the whole new one — never a
 *    partial one;
 *  - the temp file is removed on every failure path, and temps stranded by a
 *    kill are swept by the next successful write;
 *  - an explicit `fchmod` after creation makes the requested mode the mode on
 *    disk, because `open`/`writeFile` modes are masked by the process umask;
 *  - a symlinked target is resolved to the file it names, so a config file
 *    symlinked into a dotfiles repo keeps receiving writes.
 *
 * Two limits are inherent to publishing by rename, not oversights:
 *
 *  - A hardlinked file does not survive. Rename swaps the directory entry, so
 *    the other name keeps pointing at the old inode with the old bytes. No
 *    scheme publishes atomically AND preserves a hardlink; a caller that needs
 *    the link must write in place and accept the torn window.
 *  - The temp file lands beside the target, so the rename never crosses a
 *    filesystem. Passing a target on a different filesystem is fine; passing one
 *    whose directory is not writable is not, and fails before anything is
 *    published.
 */
export { atomicWriteFile, type AtomicWriteOptions } from "@platform/cli-kit/retryQueue";
