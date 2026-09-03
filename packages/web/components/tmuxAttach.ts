/**
 * How to reach a session's tmux pane — the pure half of TmuxAttachPill.
 *
 * A pane exists on exactly ONE machine, and it is routinely not the machine the
 * browser is on: a session owned by a teammate's box, or by your own Linux
 * server. `tmux attach` for a pane on another host is not a command that can
 * ever succeed, so handing one over as if it could is worse than handing over
 * nothing.
 */

import { deviceDisplayName, localTmuxAttachCommand, sshTmuxAttachCommand } from "@codecast/shared/contracts";

export type SessionMachine = {
  device_id: string;
  label: string;
  platform: string;
  is_remote: boolean;
  /** True when a command or relay from the viewer can reach the device: their
   *  own machine, or an agent box running a session they own. Server-side. */
  is_mine: boolean;
  /** The pane lives under a bot account's daemon (an agent box), so no
   *  loopback daemon of the viewer's can answer for it: relay straight away. */
  via_bot?: boolean;
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
 * The ssh shape itself (TTY flag, PATH prefix, quoting) lives in
 * @codecast/shared/contracts (sshTmuxAttachCommand) so the CLI's post-move
 * hint prints the identical command.
 *
 * ssh_host is pre-validated server-side against an allowlist (sanitizeSshHost
 * in convex/devices.ts), so it cannot close a quote or chain a command here.
 */
export function attachCommand(
  tmuxSession: string,
  machine: SessionMachine | null | undefined,
): string | null {
  const local = localTmuxAttachCommand(tmuxSession);
  // Unknown machine (no owner_device_id, or the device row is gone): keep the
  // pre-existing local form rather than silently withholding the pane name.
  if (!machine) return local;
  if (!machine.is_mine) return null;
  if (!machine.ssh_host) return local;
  return sshTmuxAttachCommand(machine.ssh_host, tmuxSession);
}

/**
 * The copy gesture as a whole: the command to put on the clipboard (or none)
 * and the one line to tell the user afterwards.
 *
 * The line matters as much as the command. A bare `tmux attach` is only valid
 * in a shell ON the pane's machine, and a session that just moved (Run on
 * device → run here) still reads as "the remote box" to the person who moved
 * it — so a successful copy names the machine the command works on. With no
 * command at all, the line says why, so the click is never a silent no-op.
 */
export type AttachCopy = { command: string | null; message: string };

export function attachCopy(
  tmuxSession: string,
  machine: SessionMachine | null | undefined,
): AttachCopy {
  const command = attachCommand(tmuxSession, machine);
  if (!machine) return { command, message: "tmux attach copied" };
  const name = deviceDisplayName(machine);
  if (!command) {
    return {
      command,
      message: `Runs on ${name}, which isn't one of your machines, so no attach command works from here. Run on device → run here brings it to this machine.`,
    };
  }
  if (machine.ssh_host) return { command, message: "ssh + tmux attach copied" };
  return { command, message: `tmux attach copied — run it in a shell on ${name}` };
}
