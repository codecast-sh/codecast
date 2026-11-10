// The one answer to "is this pid a live process?". Signal 0 delivers nothing
// and only checks: no error means alive, EPERM (or EACCES) means alive under
// another user, anything else means gone. A leaf on purpose (no imports), so
// the daemon and the lazily loaded commands can all share it. workspace/chrome.ts
// keeps a stricter one that throws on an unexpected probe error.

export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}
