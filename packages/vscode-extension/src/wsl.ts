// On Windows, codecast runs inside WSL, so an editor running on the Windows
// side reaches `cast` through wsl.exe. The command sees Linux paths: a Windows
// drive path is its /mnt/<drive> twin, and a \\wsl.localhost\<distro>\ (or
// \\wsl$\<distro>\) path is that distro's own path. The distro in such a path
// is also the one to run in; any other path runs in the default distro.

export function toWslPath(winPath: string): { path: string; distro?: string } {
  const unc = winPath.match(/^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i);
  if (unc) return { path: unc[2].replace(/\\/g, "/") || "/", distro: unc[1] };
  const drive = winPath.match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (drive) return { path: `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(/\/$/, "") };
  return { path: winPath };
}

/** Translate a `cast` argument that is a Windows path, or a path with a `:<line>` suffix. */
function translateArg(arg: string): string {
  const m = arg.match(/^(.*?)(:\d+)?$/);
  const base = m?.[1] ?? arg;
  if (!/^([A-Za-z]:[\\/]|[\\/]{2}(wsl\.localhost|wsl\$)[\\/])/i.test(base)) return arg;
  return toWslPath(base).path + (m?.[2] ?? "");
}

/**
 * The wsl.exe argument list that runs `cast <args>` in `cwd`. A login shell,
 * so ~/.local/bin is on PATH even for an install that predates the
 * /usr/local/bin link.
 */
export function wslCastArgs(args: string[], cwd: string): string[] {
  const where = toWslPath(cwd);
  return [
    ...(where.distro ? ["-d", where.distro] : []),
    "--cd", where.path,
    "-e", "sh", "-lc", 'exec cast "$@"', "cast",
    ...args.map(translateArg),
  ];
}
