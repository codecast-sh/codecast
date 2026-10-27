// What `ps` prints in its terminal column. A leaf with no imports: processTable
// builds a regex from TTY_TOKEN at load time, and processTable sits inside an
// import cycle through resourceMonitor and tmux, where a binding read during
// evaluation is still uninitialized.

/** A ps terminal value: none (`??` on macOS, `?` on Linux), a name, or a
 *  macOS `tdev` major/minor. */
export const TTY_TOKEN = /^(\?\??|-|console|tty\S*|pts\/\d+|\d+\/\d+)$/;

/** The terminal value ps prints for a process with no controlling terminal. */
export const noTerminal = (tty: string): boolean => /^(\?\??|-)$/.test(tty);
