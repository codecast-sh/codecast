/**
 * The one way to spell "attach to a tmux pane on another machine over ssh".
 * The web attach pill and the CLI's post-move hint both hand this to a person
 * to paste, so they must agree — and both must survive two traps:
 *
 *  - `-t`: ssh allocates a TTY only when asked; tmux without one exits with
 *    "open terminal failed: not a terminal".
 *  - PATH: `ssh host "cmd"` runs cmd in a non-login, non-interactive shell,
 *    which reads neither .zprofile nor .zshrc. On a stock Mac, where tmux comes
 *    from Homebrew, the bare form dies with "command not found: tmux". Naming
 *    the four standard install locations makes the command work on macOS
 *    (Apple silicon and Intel Homebrew) and Linux alike, whatever the remote
 *    account's shell initialisation does.
 *
 * Two quoting layers: the pane name is single-quoted for the shell that runs
 * tmux; the whole remote command is double-quoted so it travels as one argv
 * element for the remote shell to re-parse. Pane names are [A-Za-z0-9_-]
 * (isValidPaneTarget), so neither layer can be broken from inside.
 */
export const REMOTE_TMUX_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export function localTmuxAttachCommand(tmuxSession: string): string {
  return `tmux attach -t '${tmuxSession}'`;
}

export function sshTmuxAttachCommand(sshHost: string, tmuxSession: string): string {
  return `ssh ${sshHost} -t "PATH=${REMOTE_TMUX_PATH} ${localTmuxAttachCommand(tmuxSession)}"`;
}
