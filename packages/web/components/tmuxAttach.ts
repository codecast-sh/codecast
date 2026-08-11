/**
 * How to reach a session's tmux pane — the pure half of TmuxAttachPill.
 *
 * A pane exists on exactly ONE machine, and it is routinely not the machine the
 * browser is on: a session owned by a teammate's box, or by your own Linux
 * server. `tmux attach` for a pane on another host is not a command that can
 * ever succeed, so handing one over as if it could is worse than handing over
 * nothing.
 */

export type SessionMachine = {
  device_id: string;
  label: string;
  platform: string;
  is_remote: boolean;
  /** True only when the device belongs to the VIEWER. Decided server-side. */
  is_mine: boolean;
  /** User-set ssh target; server returns null for machines that aren't yours. */
  ssh_host: string | null;
};

/**
 * The command to reach a pane, or null when no honest command exists.
 *
 * Two quoting layers, and they are not interchangeable. The pane name is
 * single-quoted for the shell that finally runs tmux. When that shell is
 * reached through ssh, the whole tmux command travels as one argv element that
 * the REMOTE shell re-parses, so it needs its own outer quoting — double
 * quotes, since the inner single quotes are already spent.
 *
 * `-t` is load-bearing: ssh allocates a TTY only when asked, and tmux without
 * one exits immediately with "open terminal failed: not a terminal".
 *
 * ssh_host is pre-validated server-side against an allowlist (sanitizeSshHost
 * in convex/devices.ts), so it cannot close a quote or chain a command here.
 */
export function attachCommand(
  tmuxSession: string,
  machine: SessionMachine | null | undefined,
): string | null {
  const local = `tmux attach -t '${tmuxSession}'`;
  // Unknown machine (no owner_device_id, or the device row is gone): keep the
  // pre-existing local form rather than silently withholding the pane name.
  if (!machine) return local;
  if (!machine.is_mine) return null;
  if (!machine.ssh_host) return local;
  return `ssh ${machine.ssh_host} -t "${local}"`;
}
